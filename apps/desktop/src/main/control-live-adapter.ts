import type {
  ControlCapabilities as PublicControlCapabilities,
  ControlCatalog as PublicControlCatalog,
  ControlEndpointStatus,
  ControlRandomMapSource,
  ControlSafetyAttestation as PublicControlSafetyAttestation,
  ControlSetupContext,
} from '../shared/api';
import type {
  ControlCapabilities,
  ControlCatalog,
  ControlCleanEndResult,
  ControlLastTransaction,
  ControlLiveSessionPort,
  ControlSafetyAttestation,
  ControlSessionIdentity,
  ControlSourceIdentity,
  ControlStartRequest,
  ControlStartResult,
  ControlStatus,
  LiveEffectiveSetupContext,
} from './control-live-workflow';
import type { ControlSessionBridge } from './control-session-bridge';

export class ControlLiveSessionAdapter implements ControlLiveSessionPort {
  private identity: ControlSessionIdentity | undefined;

  constructor(private readonly bridge: ControlSessionBridge) {}

  async connect(
    reason: 'live-run',
    options: { recovery?: boolean } = {},
  ): Promise<ControlCapabilities> {
    const session = await this.bridge.connect(reason, undefined, options);
    if (
      session.connection !== 'ready' ||
      !session.capabilities ||
      !session.launcher.fingerprintSha256
    ) {
      throw new Error('control-live-session-not-ready');
    }
    this.identity = mapIdentity(session.capabilities, session.launcher.fingerprintSha256);
    return mapCapabilities(session.capabilities, this.identity);
  }

  async getStatus(): Promise<ControlStatus> {
    return mapStatus(await this.bridge.getStatus(), this.requireIdentity());
  }

  async cleanEnd(): Promise<ControlCleanEndResult> {
    const result = await this.bridge.cleanEnd();
    return {
      identity: this.requireIdentity(),
      safety: mapSafety(result.safety),
      status: result.status,
      resetEvidence: structuredClone(result.resetEvidence),
    };
  }

  async refreshCatalog(): Promise<ControlCatalog> {
    const result = await this.bridge.refreshCatalog();
    return mapCatalog(result, this.requireIdentity());
  }

  async startRandomMap(request: ControlStartRequest): Promise<ControlStartResult> {
    const result = await this.bridge.startRandomMap({
      requestId: request.requestId,
      setup: request.setup as ControlSetupContext,
      mapSize: request.mapSize as Parameters<ControlSessionBridge['startRandomMap']>[0]['mapSize'],
      endingAge: request.endingAge as Parameters<
        ControlSessionBridge['startRandomMap']
      >[0]['endingAge'],
      seed: request.seed,
      source: {
        catalogGeneration: request.source.catalogGeneration,
        sourceIdentity: request.source.sourceIdentity,
        authoredSourceSha256: request.source.authoredSourceSha256,
        modIdentity: request.source.modIdentity,
      },
    });
    const source = mapManagedSource(result.source);
    if (!result.effectiveSetup || !source) throw new Error('control-start-readback-incomplete');
    return {
      identity: this.requireIdentity(),
      safety: mapSafety(result.safety),
      requestId: result.requestId,
      dispatchAccepted: result.dispatchAccepted,
      rollbackComplete: result.rollbackComplete,
      requestedSetup: result.requestedSetup as LiveEffectiveSetupContext,
      effectiveSetup: result.effectiveSetup as LiveEffectiveSetupContext,
      requestedSeed: result.requestedSeed,
      source,
      route: result.route,
    };
  }

  private requireIdentity(): ControlSessionIdentity {
    if (!this.identity) throw new Error('control-live-session-not-ready');
    return structuredClone(this.identity);
  }
}

function mapIdentity(
  capabilities: PublicControlCapabilities,
  launcherSha256: string,
): ControlSessionIdentity {
  return {
    launcherSha256,
    gameProcessId: capabilities.identity.engine.gameProcessId,
    injectionId: capabilities.identity.engine.injectionId,
    endpointInstanceId: capabilities.identity.engine.endpointInstanceId,
    controlVersion: capabilities.identity.control.productVersion,
    buildFlavor: capabilities.identity.control.buildFlavor,
    gameVersion: capabilities.identity.gameBuild.fileVersion,
    gameBuild: capabilities.identity.gameBuild.peTimestamp,
  };
}

function mapCapabilities(
  capabilities: PublicControlCapabilities,
  identity: ControlSessionIdentity,
): ControlCapabilities {
  return {
    contractVersion: capabilities.contractVersion,
    capabilityRevision: capabilities.identity.control.capabilityRevision,
    multiplayerSafetyContract: capabilities.safetyContract,
    identity: structuredClone(identity),
    safety: mapSafety(capabilities.safety),
    features: structuredClone(capabilities.features),
    ...(capabilities.setupContextVersions
      ? { setupContextVersions: [...capabilities.setupContextVersions] }
      : {}),
  };
}

function mapStatus(status: ControlEndpointStatus, identity: ControlSessionIdentity): ControlStatus {
  return {
    identity: structuredClone(identity),
    safety: mapSafety(status.safety),
    match: structuredClone(status.match),
    resetEvidence: structuredClone(status.resetEvidence),
    lastTransaction: mapTransaction(status.lastTransaction),
    effectiveSeed: status.effectiveSeed,
    effectiveSource: mapManagedSource(status.effectiveSource),
  };
}

function mapCatalog(
  catalog: PublicControlCatalog,
  identity: ControlSessionIdentity,
): ControlCatalog {
  return {
    identity: structuredClone(identity),
    safety: mapSafety(catalog.safety),
    catalogGeneration: catalog.catalogGeneration,
    sources: catalog.sources.flatMap((source) => {
      const managed = mapManagedSource(source);
      return managed ? [managed] : [];
    }),
  };
}

function mapManagedSource(source: ControlRandomMapSource | null): ControlSourceIdentity | null {
  if (
    !source ||
    source.sourceKind !== 'local-mod' ||
    source.modIdentity === null ||
    source.authoredSourceSha256 === null
  ) {
    return null;
  }
  return {
    sourceKind: 'local-mod',
    modIdentity: source.modIdentity,
    sourceIdentity: source.sourceIdentity,
    authoredSourceSha256: source.authoredSourceSha256,
    catalogGeneration: source.catalogGeneration,
  };
}

function mapTransaction(
  transaction: ControlEndpointStatus['lastTransaction'],
): ControlLastTransaction | null {
  if (!transaction) return null;
  return {
    requestId: transaction.requestId,
    state: transaction.state,
    requestedSetup: transaction.requestedSetup as LiveEffectiveSetupContext,
    effectiveSetup: transaction.effectiveSetup as LiveEffectiveSetupContext | null,
    requestedSeed: transaction.requestedSeed,
    effectiveSeed: transaction.effectiveSeed,
    sourceIdentity: transaction.sourceIdentity,
    authoredSourceSha256: transaction.authoredSourceSha256,
    catalogGeneration: transaction.catalogGeneration,
    matchEpoch: transaction.matchEpoch,
    route: transaction.route,
  };
}

function mapSafety(safety: PublicControlSafetyAttestation): ControlSafetyAttestation {
  return structuredClone(safety);
}
