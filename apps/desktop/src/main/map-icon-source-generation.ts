import type {
  MapIconSourceRequest,
  PreviewGenerationInput,
  PreviewGenerationResult,
} from '../shared/api';
import type { ExecutionProgressEvent } from '../shared/execution-cost';
import { DesktopError } from '../shared/desktop-error';
import { validateMapIconSourceRequest } from '../shared/map-icon-source';
import type {
  AuthorizedDeploymentGraph,
  DeploymentCatalogIdentity,
  MainSourceCatalog,
} from './source-catalog-service';

export class MapIconSourceCancelled extends Error {
  constructor(message = 'map icon generation was cancelled') {
    super(message);
    this.name = 'MapIconSourceCancelled';
  }
}

export const mapIconSourceBusyMessage =
  'Map icon generation needs the execution slot, but another preview, map test, or live test is running. Try again when it finishes.';

export interface MapIconSourceGenerationHost {
  deploymentGraph(
    identity: DeploymentCatalogIdentity & { documentUri: string; documentRevision: number },
  ): AuthorizedDeploymentGraph;
  executionBusy(): boolean;
  withExecutionLease<T>(
    executionId: string,
    label: string,
    cooperativeStop: () => Promise<void>,
    forceStop: () => Promise<void>,
    operation: () => Promise<T>,
  ): Promise<T>;
  generate(
    input: PreviewGenerationInput,
    catalog: MainSourceCatalog,
    localProductVersion: string,
    onExecutionProgress: (event: ExecutionProgressEvent) => void,
  ): Promise<PreviewGenerationResult>;
  cancel(executionId: string): Promise<unknown>;
  forceStop(): Promise<void>;
}

interface GenerationTemplate {
  input: PreviewGenerationInput;
  localProductVersion: string;
}

interface ActiveGeneration {
  executionId: string;
  cancelled: boolean;
  settled: Promise<void>;
}

export class MapIconSourceGeneration {
  private readonly templates = new WeakMap<AuthorizedDeploymentGraph, GenerationTemplate>();
  private readonly iconSources = new WeakMap<AuthorizedDeploymentGraph, string>();
  private active: ActiveGeneration | null = null;

  constructor(private readonly host: MapIconSourceGenerationHost) {}

  remember(
    graph: AuthorizedDeploymentGraph,
    input: PreviewGenerationInput,
    localProductVersion: string,
    result: PreviewGenerationResult,
  ): void {
    if (graph.semanticHash === null || result.semanticHash !== graph.semanticHash) return;
    const template = structuredClone(input);
    delete template.clientRequestId;
    this.templates.set(graph, Object.freeze({ input: template, localProductVersion }));
  }

  acceptsIconSource(graph: AuthorizedDeploymentGraph, semanticHash: string): boolean {
    if (graph.semanticHash === null) return false;
    return semanticHash === graph.semanticHash || this.iconSources.get(graph) === semanticHash;
  }

  activeExecutionId(): string | null {
    return this.active?.executionId ?? null;
  }

  async generate(
    value: unknown,
    onExecutionProgress?: (event: ExecutionProgressEvent) => void,
  ): Promise<PreviewGenerationResult> {
    const request = validateMapIconSourceRequest(value);
    const identity = graphIdentity(request);
    let graph: AuthorizedDeploymentGraph;
    try {
      graph = this.host.deploymentGraph(identity);
    } catch (error) {
      throw new DesktopError(
        'deploy.map-icon-preview-changed',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (graph.semanticHash === null || graph.semanticHash !== request.boundSemanticHash) {
      throw new DesktopError(
        'deploy.map-icon-preview-changed',
        'map icon generation requires the current final preview',
      );
    }
    const template = this.templates.get(graph);
    if (!template) {
      throw new DesktopError(
        'deploy.map-icon-preview-changed',
        'map icon generation has no recorded generation for this preview',
      );
    }
    if (this.active?.executionId === request.clientRequestId) {
      throw new Error('map icon generation request identity is already active');
    }
    const previous = this.active;
    let settle = () => {};
    const current: ActiveGeneration = {
      executionId: request.clientRequestId,
      cancelled: false,
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    this.active = current;
    try {
      if (previous) {
        previous.cancelled = true;
        await this.host.cancel(previous.executionId).catch(() => undefined);
        await previous.settled;
      }
      if (current.cancelled) {
        throw new MapIconSourceCancelled('map icon generation was superseded');
      }
      if (this.host.executionBusy()) {
        throw new DesktopError('deploy.map-icon-busy', mapIconSourceBusyMessage);
      }
      const input: PreviewGenerationInput = {
        ...structuredClone(template.input),
        seed: request.seed,
        clientRequestId: request.clientRequestId,
      };
      let result: PreviewGenerationResult;
      try {
        result = await this.host.withExecutionLease(
          request.clientRequestId,
          `Map icon · ${uriBasename(graph.documentUri)}`,
          async () => {
            current.cancelled = true;
            await this.host.cancel(request.clientRequestId).catch(() => undefined);
          },
          () => this.host.forceStop(),
          async () => {
            if (current.cancelled) throw new MapIconSourceCancelled();
            return this.host.generate(
              input,
              graph.catalog,
              template.localProductVersion,
              (progress) => {
                if (
                  this.active === current &&
                  !current.cancelled &&
                  progress.requestId === request.clientRequestId
                ) {
                  onExecutionProgress?.(progress);
                }
              },
            );
          },
        );
      } catch (error) {
        if (current.cancelled && !(error instanceof MapIconSourceCancelled)) {
          throw new MapIconSourceCancelled();
        }
        throw error;
      }
      if (current.cancelled) throw new MapIconSourceCancelled();
      assertIconResultBelongsToGraph(result, graph);
      let latest: AuthorizedDeploymentGraph | null;
      try {
        latest = this.host.deploymentGraph(identity);
      } catch {
        latest = null;
      }
      if (latest !== graph) {
        throw new DesktopError(
          'deploy.map-icon-preview-changed',
          'the preview changed while the map icon was generating',
        );
      }
      this.iconSources.set(graph, result.semanticHash);
      return result;
    } finally {
      if (this.active === current) this.active = null;
      settle();
    }
  }

  async cancel(clientRequestId: string): Promise<boolean> {
    const active = this.active;
    if (!active || active.executionId !== clientRequestId) return false;
    active.cancelled = true;
    await this.host.cancel(clientRequestId).catch(() => undefined);
    return true;
  }
}

function graphIdentity(request: MapIconSourceRequest) {
  return {
    revision: request.sourceCatalogRevision,
    catalogHash: request.sourceCatalogHash,
    rmsGraphHash: request.sourceGraphHash,
    externalAssetHash: request.externalAssetHash,
    documentUri: request.documentUri,
    documentRevision: request.documentRevision,
  };
}

function assertIconResultBelongsToGraph(
  result: PreviewGenerationResult,
  graph: AuthorizedDeploymentGraph,
): void {
  const catalog = graph.catalog;
  const checks: [string, boolean][] = [
    ['backend', result.backend === 'exact'],
    ['document', result.documentUri === graph.documentUri],
    ['document revision', result.documentRevision === graph.documentRevision],
    ['catalog revision', result.sourceCatalogRevision === catalog.revision],
    ['catalog', result.sourceCatalogHash === hex(catalog.catalogHash)],
    ['source graph', result.sourceGraphHash === hex(catalog.rmsGraphHash)],
    ['external assets', result.externalAssetHash === hex(catalog.externalAssetHash)],
    [
      'final semantic hash',
      typeof result.semanticHash === 'string' && /^[a-f0-9]{64}$/u.test(result.semanticHash),
    ],
    [
      'deployment allowlist',
      sameStringSet(result.resolvedRmsSourceIds, graph.resolvedRmsSourceIds) &&
        sameStringSet(result.externalAssetSourceIds, graph.externalAssetSourceIds),
    ],
  ];
  const mismatched = checks.filter(([, matches]) => !matches).map(([name]) => name);
  if (mismatched.length > 0) {
    throw new Error(
      `map icon generation result does not belong to the authorized deployment graph (${mismatched.join(', ')})`,
    );
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  const expected = new Set(right);
  return new Set(left).size === left.length && left.every((value) => expected.has(value));
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function uriBasename(uri: string): string {
  const name = uri.split(/[\\/]/u).pop() ?? uri;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}
