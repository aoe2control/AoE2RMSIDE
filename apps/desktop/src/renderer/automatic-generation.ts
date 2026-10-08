import type { RootExecutionState } from '../shared/api';
import { isPreviewScriptName } from './preview-execution';
import type { RunConfiguration } from './run-configuration';

export function automaticGenerationIdentity(configuration: RunConfiguration | null): string | null {
  return configuration
    ? JSON.stringify({
        seed: configuration.seed,
        mapSize: configuration.mapSize,
        width: configuration.width,
        height: configuration.height,
        playerCount: configuration.playerCount,
        playerSlots: configuration.playerSlots,
        playerColors: configuration.playerColors,
        teamIds: configuration.teamIds,
        civilizationIds: configuration.civilizationIds,
        computerPlayers: configuration.computerPlayers,
        modeContext: configuration.modeContext,
        gameModeModifiers: configuration.gameModeModifiers,
        turboMode: configuration.turboMode,
        fullTechTree: configuration.fullTechTree,
        antiquityMode: configuration.antiquityMode,
        solidFarms: configuration.solidFarms,
        startingResources: configuration.startingResources,
        startingAge: configuration.startingAge,
        endingAge: configuration.endingAge,
        positionPolicy: configuration.positionPolicy,
        profileId: configuration.profileId,
        traceLevel: configuration.traceLevel,
      })
    : null;
}

export type AutomaticGenerationAction = 'none' | 'schedule' | 'supersede' | 'defer';

export interface AutomaticGenerationChange {
  contentChanged: boolean;
  configurationChanged: boolean;
  runOnEdit: boolean;
  previewActive: boolean;
  execution: Pick<RootExecutionState, 'phase' | 'kind'>;
  ownPreviewExecution: boolean;
  documentRunnable?: boolean;
}

export function automaticRunApplies(input: {
  documentName: string;
  sourceEmpty: boolean;
  blockingReason: string | null;
  sourceInvalid: boolean;
  fixture: boolean;
}): boolean {
  if (!isPreviewScriptName(input.documentName) || input.sourceEmpty) return false;
  if (input.fixture) return true;
  return input.blockingReason === null || input.sourceInvalid;
}

export function automaticGenerationAction(
  change: AutomaticGenerationChange,
): AutomaticGenerationAction {
  const { contentChanged, configurationChanged, execution } = change;
  if (!contentChanged && !configurationChanged) return 'none';
  if (change.documentRunnable === false) return 'none';
  if (contentChanged && !change.runOnEdit) return 'none';
  if (!change.previewActive) return 'none';
  if (execution.phase === 'idle') return 'schedule';
  if (change.ownPreviewExecution) {
    return execution.phase === 'running' ? 'supersede' : 'defer';
  }
  if (execution.kind === 'map-icon') return 'defer';
  return 'none';
}
