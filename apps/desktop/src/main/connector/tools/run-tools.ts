import type { MapTestRunResult, PreviewGenerationResult } from '../../../shared/api';
import type { ConnectorOutputFacts } from '../../../shared/connector-api';
import {
  appMapSizeTiles,
  validateAppRunContext,
  validateAppRunReply,
  type AppRunContext,
  type AppRunReply,
  type AppRunRequest,
  type AppRunSettings,
} from '../../../shared/connector-run-api';
import {
  AppMapStore,
  compactMapFromResult,
  type CompactMap,
  type CompactSource,
} from '../app-map-store';
import {
  ConnectorToolError,
  connectorTextResult,
  type ConnectorToolContext,
  type ConnectorToolRegistry,
  type ConnectorToolResult,
} from '../dispatcher';
import {
  busyError,
  type AppLane,
  type AppRunTicket,
  type AppRunTicketKind,
  type AppRunTickets,
} from '../lane';
import { planQualityCheck } from '../quality-request';
import { parseRunSettings, unsignedSeed, waitMilliseconds } from '../run-arguments';
import {
  expired,
  RunRegistry,
  runningAnswer,
  type RunContext,
  type RunPrefix,
} from '../run-registry';
import {
  failedRunSummary,
  generateSummary,
  inspectSummary,
  mapDetails,
  mapSummaryCaps,
  showSummary,
  sourceFile,
  type ScriptError,
} from '../summaries/map-summary';
import { mapTestDetails, mapTestSummary } from '../summaries/map-test-summary';
import { qualityDetails, qualitySettings, qualitySummary } from '../summaries/quality-summary';
import type { ConnectorJsonValue, ConnectorToolArguments } from '../validator';

export interface ResolvedScript {
  absolute: string;
  relative: string;
}

export type RunDetails =
  | { kind: 'map'; mapId: string; path: string | null }
  | { kind: 'map-test'; result: MapTestRunResult; path: string | null }
  | { kind: 'quality'; result: MapTestRunResult; path: string | null }
  | { kind: 'custom'; details(args: ConnectorToolArguments): string };

export interface RunToolDependencies {
  bridge: {
    request(
      kind: 'run' | 'resolveRunContext',
      payload: unknown,
      options: { timeoutMilliseconds: number; signal?: AbortSignal },
    ): Promise<unknown>;
  };
  lane: AppLane;
  tickets: AppRunTickets;
  leaseState(): Parameters<typeof busyError>[0];
  resolveScript(path: string, kind: 'map' | 'map-test'): Promise<ResolvedScript>;
  relativePath(absolute: string): string | null;
  source(sourceId: string): CompactSource;
  stopExecution(executionId: string): void;
  qualityAvailable(): boolean | Promise<boolean>;
  qualityCases: readonly string[];
  scriptErrors?(absolutePath: string): ScriptError[];
  pictureMap?(result: PreviewGenerationResult): unknown;
  freshSeed(): number;
  now(): number;
}

const mapStoreKey = {};
const runRegistryKey = {};
const generationTimeoutMilliseconds = 30 * 60 * 1000;
const mapTestTimeoutMilliseconds = 6 * 60 * 60 * 1000;
const contextTimeoutMilliseconds = 10_000;

function stringArgument(args: ConnectorToolArguments, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function integerArgument(args: ConnectorToolArguments, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function textResult(
  text: string,
  options: { outcome?: 'done' | 'failed'; facts?: ConnectorOutputFacts } = {},
): ConnectorToolResult {
  return { content: [{ type: 'text', text }], ...options };
}

function mapExpired(id: string): ConnectorToolError {
  return new ConnectorToolError('map_expired', `${id} is no longer available.`, {
    hint: 'Generate the map again; AoE2RMSIDE keeps the last 6 maps of a connection.',
  });
}

function internalError(message = 'Something went wrong in AoE2RMSIDE.'): ConnectorToolError {
  return new ConnectorToolError('internal', message, {
    hint: 'Try again; if it keeps failing, ask the user to look at the Output in AoE2RMSIDE.',
  });
}

function stoppedError(run: RunContext): ConnectorToolError {
  return new ConnectorToolError('stopped', 'The run was stopped.', {
    details: { by: run.stoppedBy() === 'connection' ? 'connection' : 'app' },
  });
}

function sameDocument(sourceId: string, uri: string): boolean {
  return sourceId === uri || sourceId.toLowerCase() === uri.toLowerCase();
}

function isPreviewResult(value: unknown): value is PreviewGenerationResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'terrainIdsLe' in value &&
    'objects' in value &&
    'provenanceOperations' in value
  );
}

function isMapTestResult(value: unknown): value is MapTestRunResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    'report' in value &&
    'diagnostics' in value &&
    'elapsedMilliseconds' in value
  );
}

export function connectionMaps(context: ConnectorToolContext): AppMapStore {
  return context.connection.get(mapStoreKey, () => new AppMapStore());
}

export function connectionRuns(context: ConnectorToolContext, now: () => number): RunRegistry {
  return context.connection.get(runRegistryKey, () => {
    const registry = new RunRegistry(undefined, now);
    context.connection.onClose(() => registry.close());
    return registry;
  });
}

export class RunTools {
  constructor(private readonly deps: RunToolDependencies) {}

  maps(context: ConnectorToolContext): AppMapStore {
    return connectionMaps(context);
  }

  runs(context: ConnectorToolContext): RunRegistry {
    return connectionRuns(context, () => this.deps.now());
  }

  async generate(
    args: ConnectorToolArguments,
    context: ConnectorToolContext,
    kind: 'generate' | 'show',
  ): Promise<ConnectorToolResult> {
    const maps = this.maps(context);
    const compareId = kind === 'generate' ? stringArgument(args, 'compare_to') : undefined;
    const compare = compareId === undefined ? undefined : maps.get(compareId);
    if (compareId !== undefined && !compare) throw mapExpired(compareId);
    let seed = integerArgument(args, 'seed');
    if (seed !== undefined) seed = unsignedSeed(seed);
    let settings = parseRunSettings(args.settings);
    const path = stringArgument(args, 'path');
    let absolute: string | null = null;
    const fromRun = kind === 'generate' ? this.fromRun(args.from_run, context) : undefined;
    if (fromRun) {
      seed ??= fromRun.seed;
      settings = { ...fromRun.settings, ...settings };
      if (path === undefined && fromRun.path) absolute = fromRun.path;
    }
    if (path !== undefined) {
      absolute = (await this.deps.resolveScript(path, 'map')).absolute;
    } else if (fromRun && !absolute) {
      throw new ConnectorToolError(
        'invalid_arguments',
        'Give path: the map test does not name one map for its seeds.',
        { hint: 'Pass the .rms file the map test generates as path.' },
      );
    }
    const request: Omit<AppRunRequest, 'token' | 'app'> = {
      kind,
      path: absolute,
      ...(seed === undefined ? {} : { seed }),
      ...(settings ? { settings } : {}),
    };
    return this.laneRun(args, context, 'g', 'generate', request, async (reply, ticket, run) => {
      if (reply.outcome === 'failed') {
        const errors = reply.path ? (this.deps.scriptErrors?.(reply.path) ?? []) : [];
        return textResult(
          failedRunSummary(
            {
              path: reply.path ? this.deps.relativePath(reply.path) : null,
              name: reply.name,
              stage: reply.stage,
              message: reply.message,
              fileOf: (sourceId) => sourceFile(sourceId, this.deps.relativePath),
              ...(kind === 'show' ? { shown: false } : {}),
            },
            errors,
            kind === 'show' ? mapSummaryCaps.show : mapSummaryCaps.generate,
          ),
          { outcome: 'failed', facts: this.fileFacts(reply.path, reply.name) },
        );
      }
      if (reply.outcome !== 'done') throw internalError();
      const result = ticket.result;
      if (!isPreviewResult(result))
        throw internalError("The map did not reach AoE2RMSIDE's main process.");
      const relative = reply.path ? this.deps.relativePath(reply.path) : null;
      let map: CompactMap;
      try {
        map = compactMapFromResult(
          result,
          {
            id: maps.nextId(),
            path: relative,
            name: reply.name,
            seed: reply.seed,
            settings: reply.settings,
            timeS: Math.max(0, ((ticket.resultAt ?? this.deps.now()) - run.startedAt) / 1000),
            teams: reply.players.map((player) => player.team),
          },
          (sourceId) =>
            ticket.source && sameDocument(sourceId, ticket.source.uri)
              ? { file: relative ?? reply.name, text: ticket.source.text }
              : this.deps.source(sourceId),
        );
      } catch {
        throw internalError('AoE2RMSIDE could not read the generated map.');
      }
      if (this.deps.pictureMap) {
        try {
          map.picture = this.deps.pictureMap(result);
        } catch {}
      }
      maps.put(map);
      run.setDetails({ kind: 'map', mapId: map.id, path: reply.path } satisfies RunDetails);
      const facts: ConnectorOutputFacts = {
        ...this.fileFacts(reply.path, reply.name),
        seed: map.seed,
      };
      return textResult(
        kind === 'show' ? showSummary(map, reply.changed) : generateSummary(map, { compare }),
        { facts },
      );
    });
  }

  private fileFacts(path: string | null, name: string): ConnectorOutputFacts {
    const relative = path ? this.deps.relativePath(path) : null;
    return { file: (relative ?? name).slice(0, 260) };
  }

  private fromRun(
    value: ConnectorJsonValue | undefined,
    context: ConnectorToolContext,
  ): { seed: number; settings: AppRunSettings; path: string | null } | undefined {
    if (
      value === undefined ||
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      return undefined;
    }
    const raw = value as ConnectorToolArguments;
    const id = stringArgument(raw, 'run')!;
    const run = this.runs(context).get(id);
    if (!run) throw expired(id);
    const details = run.details as RunDetails | undefined;
    if (
      !details ||
      (details.kind !== 'map-test' && details.kind !== 'quality') ||
      !details.result.report
    ) {
      throw new ConnectorToolError(
        'not_found',
        `${id} has no finished report to take a seed from.`,
      );
    }
    const report = details.result.report;
    const seed = unsignedSeed(integerArgument(raw, 'seed')!);
    const settingId = stringArgument(raw, 'setting') ?? 's1';
    const refs = qualitySettings(report);
    const ref = refs.find((entry) => entry.id === settingId);
    if (!ref) {
      throw new ConnectorToolError(
        'not_found',
        `${id} has the settings ${refs.map((entry) => entry.id).join(', ')}, not ${settingId}.`,
      );
    }
    const settings: AppRunSettings = {
      players: ref.players.length,
      teams: ref.players.map((player) => Math.min(4, player.team)),
    };
    const tiles = appMapSizeTiles(ref.mapSize);
    if (tiles !== undefined && tiles === ref.width && tiles === ref.height) {
      settings.mapSize = ref.mapSize as AppRunSettings['mapSize'];
    }
    return { seed, settings, path: details.kind === 'quality' ? details.path : null };
  }

  async mapTest(
    args: ConnectorToolArguments,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    const resolved = await this.deps.resolveScript(stringArgument(args, 'path')!, 'map-test');
    const note =
      integerArgument(args, 'seeds') === undefined
        ? undefined
        : 'seeds is not used: the map test chooses its own seeds';
    return this.laneRun(
      args,
      context,
      'r',
      'map-test',
      { kind: 'map-test', path: resolved.absolute },
      async (reply, ticket, run) => {
        if (reply.outcome === 'failed') {
          return textResult(
            failedRunSummary(
              {
                path: resolved.relative,
                name: reply.name,
                stage: reply.stage,
                message: reply.message,
                fileOf: (sourceId) => sourceFile(sourceId, this.deps.relativePath),
              },
              [],
              3_000,
            ),
            { outcome: 'failed', facts: { file: resolved.relative } },
          );
        }
        const result = ticket.result;
        if (reply.outcome !== 'done' || !isMapTestResult(result)) {
          throw internalError("The map test result did not reach AoE2RMSIDE's main process.");
        }
        run.setDetails({ kind: 'map-test', result, path: resolved.absolute } satisfies RunDetails);
        return textResult(mapTestSummary(run.id, result, note ? { note } : {}), {
          outcome: result.status === 'passed' ? 'done' : 'failed',
          facts: {
            file: resolved.relative,
            ...(result.report ? { count: result.report.generatedMaps } : {}),
          },
        });
      },
    );
  }

  async qualityCheck(
    args: ConnectorToolArguments,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    if (!(await this.deps.qualityAvailable())) {
      throw new ConnectorToolError(
        'internal',
        'The quality check is not available: the map-test helper running now does not offer it.',
        {
          hint: 'Use generate_map and run_map_test to check the map instead, or ask the user to restart AoE2RMSIDE.',
        },
      );
    }
    const path = stringArgument(args, 'path');
    const resolved = path === undefined ? undefined : await this.deps.resolveScript(path, 'map');
    const contextReply = await this.deps.bridge.request(
      'resolveRunContext',
      { path: resolved?.absolute ?? null },
      { timeoutMilliseconds: contextTimeoutMilliseconds, signal: context.signal },
    );
    let runContext: AppRunContext;
    try {
      runContext = validateAppRunContext(contextReply);
    } catch {
      throw internalError();
    }
    const firstSeed = integerArgument(args, 'first_seed');
    const plan = planQualityCheck(
      {
        seeds: integerArgument(args, 'seeds'),
        ...(firstSeed === undefined ? {} : { firstSeed: unsignedSeed(firstSeed) }),
        settings: Array.isArray(args.settings)
          ? (args.settings as readonly { map_size?: string; players?: number; teams?: string }[])
          : undefined,
        cases: Array.isArray(args.cases)
          ? args.cases.filter((entry): entry is string => typeof entry === 'string')
          : undefined,
      },
      runContext,
      this.deps.qualityCases,
      context.limits.qualityCheckMaps,
      () => this.deps.freshSeed(),
    );
    const scriptPath = resolved?.absolute ?? runContext.path;
    return this.laneRun(
      args,
      context,
      'q',
      'quality-check',
      { kind: 'quality-check', path: scriptPath, quality: plan.run },
      async (reply, ticket, run) => {
        const file = (scriptPath ? this.deps.relativePath(scriptPath) : null) ?? runContext.name;
        if (reply.outcome === 'failed') {
          return textResult(
            failedRunSummary(
              {
                path: file,
                name: reply.name,
                stage: reply.stage,
                message: reply.message,
                fileOf: (sourceId) => sourceFile(sourceId, this.deps.relativePath),
              },
              [],
              4_000,
            ),
            { outcome: 'failed', facts: { file } },
          );
        }
        const result = ticket.result;
        if (reply.outcome !== 'done' || !isMapTestResult(result)) {
          throw internalError("The quality check result did not reach AoE2RMSIDE's main process.");
        }
        run.setDetails({ kind: 'quality', result, path: scriptPath } satisfies RunDetails);
        return textResult(qualitySummary(run.id, result), {
          outcome: result.report?.quality?.result === 'failed' ? 'failed' : 'done',
          facts: { file, seeds: plan.run.seedCount, count: plan.maps },
        });
      },
    );
  }

  private async laneRun(
    args: ConnectorToolArguments,
    context: ConnectorToolContext,
    prefix: RunPrefix,
    ticketKind: AppRunTicketKind,
    request: Omit<AppRunRequest, 'token' | 'app'>,
    finish: (
      reply: AppRunReply,
      ticket: AppRunTicket,
      run: RunContext,
    ) => Promise<ConnectorToolResult>,
  ): Promise<ConnectorToolResult> {
    const wait = waitMilliseconds(
      args.wait_seconds,
      context.limits.defaultWaitSeconds,
      context.limits.maxWaitSeconds,
    );
    await this.deps.lane.admit(context.signal);
    const registry = this.runs(context);
    const app = context.app.displayName;
    const run = registry.start(prefix, async (runContext) => {
      const ticket = this.deps.tickets.issue(ticketKind, app);
      ticket.onProgress = (done, total) => runContext.progress(done, total);
      const stop = () => {
        const executionId = this.deps.tickets.cancel(ticket.token);
        if (executionId) this.deps.stopExecution(executionId);
      };
      runContext.signal.addEventListener('abort', stop, { once: true });
      try {
        runContext.progress(
          0,
          0,
          request.kind === 'map-test' || request.kind === 'quality-check'
            ? 'Running'
            : 'Generating',
        );
        let reply = await this.send(request, ticket, app, runContext.signal);
        if (reply.outcome === 'busy') {
          await this.deps.lane.admit(runContext.signal);
          reply = await this.send(request, ticket, app, runContext.signal);
          if (reply.outcome === 'busy') throw busyError(this.deps.leaseState(), this.deps.now());
        }
        if (reply.outcome === 'cancelled') {
          if (runContext.signal.aborted) throw stoppedError(runContext);
          throw new ConnectorToolError('stopped', 'The user stopped the run in AoE2RMSIDE.', {
            details: { by: 'user' },
            hint: 'Ask the user before running it again.',
          });
        }
        if (reply.outcome === 'superseded') {
          if (reply.reason === 'other-execution') {
            throw busyError(this.deps.leaseState(), this.deps.now());
          }
          throw new ConnectorToolError(
            'stopped',
            reply.reason === 'source-changed'
              ? 'The script changed while the run was going, so its result was dropped.'
              : 'A newer run in AoE2RMSIDE replaced this run.',
            { details: { by: 'user' }, hint: 'Run it again when the user is done.' },
          );
        }
        return await finish(reply, ticket, runContext);
      } catch (error) {
        if (
          runContext.signal.aborted &&
          !(error instanceof ConnectorToolError && error.code === 'stopped')
        ) {
          throw stoppedError(runContext);
        }
        throw error;
      } finally {
        runContext.signal.removeEventListener('abort', stop);
        this.deps.tickets.finish(ticket.token);
      }
    });
    return this.answer(run.id, wait, context, true);
  }

  private async send(
    request: Omit<AppRunRequest, 'token' | 'app'>,
    ticket: AppRunTicket,
    app: string,
    signal: AbortSignal,
  ): Promise<AppRunReply> {
    const payload: AppRunRequest = { token: ticket.token, app, ...request };
    const reply = await this.deps.bridge.request('run', payload, {
      timeoutMilliseconds:
        request.kind === 'map-test' || request.kind === 'quality-check'
          ? mapTestTimeoutMilliseconds
          : generationTimeoutMilliseconds,
      signal,
    });
    try {
      return validateAppRunReply(reply);
    } catch {
      throw internalError();
    }
  }

  private async answer(
    id: string,
    waitMs: number,
    context: ConnectorToolContext,
    stopOnCancel: boolean,
  ): Promise<ConnectorToolResult> {
    const registry = this.runs(context);
    try {
      const outcome = await registry.wait(id, waitMs, context.signal, (progress) =>
        context.progress(progress.done, progress.total, progress.message),
      );
      if (outcome.kind === 'finished') return outcome.result;
      return connectorTextResult(runningAnswer(outcome.run, this.deps.now()));
    } catch (error) {
      if (stopOnCancel && context.signal.aborted) registry.stop(id, 'app');
      throw error;
    }
  }

  async inspect(
    args: ConnectorToolArguments,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    const id = stringArgument(args, 'map')!;
    const map = this.maps(context).get(id);
    if (!map) throw mapExpired(id);
    const area = args.area as { x: number; y: number; w: number; h: number } | undefined;
    const player = integerArgument(args, 'player');
    if (area && player !== undefined) {
      throw new ConnectorToolError('invalid_arguments', 'Give area or player, not both.');
    }
    const scope = JSON.stringify([
      id,
      area ?? null,
      player ?? null,
      args.radius ?? null,
      args.what ?? null,
      args.objects ?? null,
      args.sources ?? null,
    ]);
    return textResult(
      inspectSummary(
        map,
        {
          ...(area ? { area } : {}),
          ...(player === undefined ? {} : { player }),
          radius: integerArgument(args, 'radius') ?? 20,
          what:
            (stringArgument(args, 'what') as 'objects' | 'terrain' | 'both' | undefined) ?? 'both',
          ...(Array.isArray(args.objects)
            ? {
                objects: args.objects.filter((entry): entry is string => typeof entry === 'string'),
              }
            : {}),
          list: args.list === true,
          sources: args.sources === true,
          cursor: args.cursor,
          limit: integerArgument(args, 'limit') ?? 40,
        },
        scope,
      ),
    );
  }

  async status(
    args: ConnectorToolArguments,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    const id = stringArgument(args, 'run')!;
    const registry = this.runs(context);
    const run = registry.get(id);
    if (!run) throw expired(id);
    if (args.stop === true) {
      if (registry.stop(id, 'app')) {
        return connectorTextResult({ run: id, status: 'stopped', by: 'app' });
      }
    }
    const wait = waitMilliseconds(
      args.wait_seconds,
      context.limits.defaultWaitSeconds,
      context.limits.maxWaitSeconds,
    );
    return this.answer(id, wait, context, false);
  }

  async details(
    args: ConnectorToolArguments,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    const id = stringArgument(args, 'id')!;
    const part = stringArgument(args, 'part')!;
    const limit = integerArgument(args, 'limit') ?? 25;
    if (id.startsWith('m') || id.includes('.')) {
      const map = this.maps(context).get(id);
      if (!map) throw mapExpired(id);
      return textResult(mapDetails(map, part, { cursor: args.cursor, limit }));
    }
    const run = this.runs(context).get(id);
    if (!run) throw expired(id);
    if (!run.settled) {
      throw new ConnectorToolError('busy', `${id} is still running.`, {
        hint: `Wait for it with run_status {run:'${id}'}.`,
        retryAfterSeconds: 5,
      });
    }
    const details = run.details as RunDetails | undefined;
    if (!details) {
      throw new ConnectorToolError('not_found', `${id} ended without a result to show.`);
    }
    switch (details.kind) {
      case 'map': {
        const map = this.maps(context).get(details.mapId);
        if (!map) throw mapExpired(details.mapId);
        return textResult(mapDetails(map, part, { cursor: args.cursor, limit }));
      }
      case 'map-test':
        return textResult(
          mapTestDetails(id, details.result, {
            part,
            ...(stringArgument(args, 'assertion') === undefined
              ? {}
              : { assertion: stringArgument(args, 'assertion') }),
            ...(integerArgument(args, 'seed') === undefined
              ? {}
              : { seed: unsignedSeed(integerArgument(args, 'seed')!) }),
            cursor: args.cursor,
            limit,
          }),
        );
      case 'quality':
        return textResult(
          qualityDetails(id, details.result, {
            part,
            ...(stringArgument(args, 'case') === undefined
              ? {}
              : { case: stringArgument(args, 'case') }),
            ...(integerArgument(args, 'seed') === undefined
              ? {}
              : { seed: unsignedSeed(integerArgument(args, 'seed')!) }),
            ...(stringArgument(args, 'setting') === undefined
              ? {}
              : { setting: stringArgument(args, 'setting') }),
            cursor: args.cursor,
            limit,
          }),
        );
      case 'custom':
        return textResult(details.details(args));
    }
  }
}

export function registerRunTools(
  registry: ConnectorToolRegistry,
  deps: RunToolDependencies,
): () => void {
  const tools = new RunTools(deps);
  const removals = [
    registry.register('generate_map', (args, context) => tools.generate(args, context, 'generate')),
    registry.register('show_map', (args, context) => tools.generate(args, context, 'show')),
    registry.register('inspect_map', (args, context) => tools.inspect(args, context)),
    registry.register('run_map_test', (args, context) => tools.mapTest(args, context)),
    registry.register('run_quality_check', (args, context) => tools.qualityCheck(args, context)),
    registry.register('run_status', (args, context) => tools.status(args, context)),
    registry.register('get_details', (args, context) => tools.details(args, context)),
  ];
  return () => {
    for (const remove of removals) remove();
  };
}
