import type {
  ControlLiveSynchronizationRequest,
  ControlSessionStatus,
  ControlSetupContext,
  PreviewGenerationResult,
} from '../shared/api';
import { lobbyOptionFields } from '../shared/lobby-options';
import {
  computerPlayerSlots,
  generationSettingsMatchConfiguration,
  liveTestComputerPlayerSlots,
  parseGenerationSettingsKey,
  randomCivilizationResolutions,
  runSetupContextMinor,
  selectedLobbyOptions,
  type RunConfiguration,
} from './run-configuration';

export interface ControlLiveRequestOptions {
  requestId: string;
  documentUri: string;
  documentRevision: number;
  requestedGenerationSettingsKey: string;
  resultGenerationSettingsKey: string | undefined;
  includePreviewImage: boolean;
  replaceActiveMatch: boolean;
  overwriteDeploymentConflicts: boolean;
}

export function isCurrentLivePreview(
  result: PreviewGenerationResult,
  configuration: RunConfiguration,
  options: Pick<
    ControlLiveRequestOptions,
    | 'documentUri'
    | 'documentRevision'
    | 'requestedGenerationSettingsKey'
    | 'resultGenerationSettingsKey'
  >,
): boolean {
  if (
    result.backend !== 'exact' ||
    result.provenanceStatus !== 'exact' ||
    result.documentUri !== options.documentUri ||
    result.documentRevision !== options.documentRevision ||
    result.resolvedRmsSourceIds.length < 1 ||
    options.resultGenerationSettingsKey === undefined ||
    options.resultGenerationSettingsKey !== options.requestedGenerationSettingsKey
  ) {
    return false;
  }
  const settings = parseGenerationSettingsKey(options.resultGenerationSettingsKey);
  const trace = result.traceIdentity;
  return (
    settings !== null &&
    generationSettingsMatchConfiguration(settings, configuration) &&
    settings.width === result.width &&
    settings.height === result.height &&
    settings.profileId === trace.profileId &&
    settings.profileHash === trace.profileHash &&
    settings.contentPackId === trace.contentPackId &&
    settings.contentPackVersion === trace.contentPackVersion &&
    settings.contentHash === trace.contentPackHash &&
    settings.traceLevel === trace.traceLevel
  );
}

export function buildControlLiveRequest(
  result: PreviewGenerationResult,
  configuration: RunConfiguration,
  options: ControlLiveRequestOptions,
): ControlLiveSynchronizationRequest {
  const randomCivilizations = new Map(
    randomCivilizationResolutions(configuration).map((entry) => [
      entry.playerIndex,
      entry.civilizationId,
    ]),
  );
  if (!isCurrentLivePreview(result, configuration, options)) {
    throw new Error('live testing requires the current successful preview request');
  }
  const computers = liveTestComputerPlayerSlots(configuration);
  if (computers.join(',') !== computerPlayerSlots(configuration).join(',')) {
    throw new Error('live testing requires a preview with every player after slot 1 a computer');
  }
  const minor = runSetupContextMinor(configuration);
  return {
    contractVersion: { major: 1, minor: 0, patch: 0 },
    requestId: options.requestId,
    preview: {
      backend: 'exact',
      provenanceStatus: 'exact',
      documentUri: result.documentUri,
      documentRevision: result.documentRevision,
      currentDocumentUri: options.documentUri,
      currentDocumentRevision: options.documentRevision,
      requestHash: result.requestHash,
      semanticProgramHash: result.semanticProgramHash,
      sourceCatalogRevision: result.sourceCatalogRevision,
      sourceCatalogHash: result.sourceCatalogHash,
      sourceGraphHash: result.sourceGraphHash,
      externalAssetHash: result.externalAssetHash,
      profileId: result.traceIdentity.profileId,
      profileHash: result.traceIdentity.profileHash,
      contentPackId: result.traceIdentity.contentPackId,
      contentPackHash: result.traceIdentity.contentPackHash,
      width: result.width,
      height: result.height,
      mapSize: configuration.mapSize,
      seed: configuration.seed,
    },
    deployment: {
      contractVersion: { major: 1, minor: 0, patch: 0 },
      documentUri: result.documentUri,
      documentRevision: result.documentRevision,
      sourceCatalogRevision: result.sourceCatalogRevision,
      sourceCatalogHash: result.sourceCatalogHash,
      sourceGraphHash: result.sourceGraphHash,
      externalAssetHash: result.externalAssetHash,
      resolvedRmsSourceIds: [...result.resolvedRmsSourceIds],
      externalAssetSourceIds: [...result.externalAssetSourceIds],
      includePreviewImage: options.includePreviewImage,
    },
    setup: {
      schemaVersion: minor === 2 ? '1.2.0' : minor === 1 ? '1.1.0' : '1.0.0',
      compatibility: { minimumMajor: 1, maximumMajor: 1 },
      gameMode: configuration.modeContext,
      startingResources: configuration.startingResources,
      startingAge: configuration.startingAge,
      revealMap: 'all-visible',
      positionPolicy: configuration.positionPolicy,
      players: Array.from({ length: configuration.playerCount }, (_, index) => ({
        slot: configuration.playerSlots[index]!,
        team: configuration.teamIds[index]!,
        civilizationId: randomCivilizations.get(index) ?? configuration.civilizationIds[index]!,
        color: configuration.playerColors[index]!,
      })),
      ...(computers.length > 0 ? { computerPlayerSlots: computers } : {}),
      ...lobbyOptionFields(selectedLobbyOptions(configuration)),
    },
    endingAge: configuration.endingAge,
    replaceActiveMatch: options.replaceActiveMatch,
    overwriteDeploymentConflicts: options.overwriteDeploymentConflicts,
  };
}

export function controlAcceptsLiveSetup(
  session: Pick<ControlSessionStatus, 'capabilities'>,
  setup: Pick<ControlSetupContext, 'schemaVersion'>,
): boolean {
  if (setup.schemaVersion !== '1.2.0' || !session.capabilities) return true;
  return (
    session.capabilities.features.lobbyOptions === true &&
    (session.capabilities.setupContextVersions ?? []).includes('1.2.0')
  );
}
