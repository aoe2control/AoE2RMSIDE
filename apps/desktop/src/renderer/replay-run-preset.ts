import type { MapTestReport } from '../shared/api';
import { t } from '../shared/i18n/translator';
import {
  computerRunSettings,
  runGameModeOptions,
  runMapSizeOptions,
  runPositionPolicyOptions,
  runStartingAgeOptions,
  runStartingResourceOptions,
  validateRunConfiguration,
  withLockedSeed,
  type RunConfiguration,
} from './run-configuration';

export interface ReplayedLobbySettings {
  width: number;
  height: number;
  mapSize: string;
  players: { slot: number; team: number; civilizationId: number; color: number }[];
  gameMode: string;
  startingResources: string;
  startingAge: string;
  positionPolicy: string;
}

export function testConfigName(): string {
  return t('run-menu.preset.test-config-name');
}

export function replayedLobbySettings(
  report: Pick<MapTestReport, 'findings' | 'settings' | 'settingsVariants'>,
  findingId: string,
): ReplayedLobbySettings | null {
  const finding = report.findings.find((entry) => entry.findingId === findingId);
  if (!finding) return null;
  const settings =
    finding.settingsIndex === undefined
      ? report.settings
      : report.settingsVariants?.[finding.settingsIndex];
  const setup = report.settings?.setupContext;
  if (!settings || !setup) return null;
  return {
    width: settings.width,
    height: settings.height,
    mapSize: settings.mapSize,
    players: settings.players.map(({ slot, team, civilizationId, color }) => ({
      slot,
      team,
      civilizationId,
      color,
    })),
    gameMode: setup.gameMode,
    startingResources: setup.startingResources,
    startingAge: setup.startingAge,
    positionPolicy: setup.positionPolicy,
  };
}

export function replayedLobbyMatches(
  configuration: RunConfiguration,
  lobby: ReplayedLobbySettings,
): boolean {
  return (
    configuration.mapSize === lobby.mapSize &&
    configuration.width === lobby.width &&
    configuration.height === lobby.height &&
    configuration.playerCount === lobby.players.length &&
    lobby.players.every((player, index) => {
      return (
        configuration.playerSlots[index] === player.slot &&
        configuration.teamIds[index] === player.team &&
        configuration.playerColors[index] === player.color &&
        configuration.civilizationIds[index] === player.civilizationId
      );
    }) &&
    configuration.modeContext === lobby.gameMode &&
    configuration.startingResources === lobby.startingResources &&
    configuration.startingAge === lobby.startingAge &&
    configuration.positionPolicy === lobby.positionPolicy
  );
}

export function replayedLobbyConfiguration(
  current: RunConfiguration,
  lobby: ReplayedLobbySettings,
  seed: number,
): RunConfiguration | null {
  const mapSize = runMapSizeOptions.find(
    (option) =>
      option.value === lobby.mapSize &&
      option.width === lobby.width &&
      option.height === lobby.height,
  );
  const gameMode = runGameModeOptions.find((option) => option.value === lobby.gameMode);
  const resources = runStartingResourceOptions.find(
    (option) => option.value === lobby.startingResources,
  );
  const ageIndex = runStartingAgeOptions.findIndex((option) => option.value === lobby.startingAge);
  const positions = runPositionPolicyOptions.find(
    (option) => option.value === lobby.positionPolicy,
  );
  const count = lobby.players.length;
  if (!mapSize || !gameMode || !resources || ageIndex < 0 || !positions) return null;
  if (count < 1 || count > 8) return null;
  const slots = lobby.players.map((player) => player.slot);
  const colors = lobby.players.map((player) => player.color);
  const computerSlots = new Set(
    current.playerSlots
      .slice(0, current.playerCount)
      .filter((_, index) => current.computerPlayers[index] === true),
  );
  const startingAge = runStartingAgeOptions[ageIndex]!.value;
  const endingAgeIndex = runStartingAgeOptions.findIndex(
    (option) => option.value === current.endingAge,
  );
  const configuration: RunConfiguration = {
    ...current,
    mapSize: mapSize.value,
    width: mapSize.width,
    height: mapSize.height,
    playerCount: count,
    playerSlots: withFreeValues(slots, 1),
    playerColors: withFreeValues(colors, 0),
    teamIds: current.teamIds.map((team, index) => lobby.players[index]?.team ?? team),
    civilizationIds: current.civilizationIds.map(
      (civilization, index) => lobby.players[index]?.civilizationId ?? civilization,
    ),
    computerPlayers: current.computerPlayers.map((computer, index) =>
      index < count ? computerSlots.has(slots[index]!) : computer,
    ),
    modeContext: gameMode.value,
    startingResources: resources.value,
    startingAge,
    endingAge: endingAgeIndex < ageIndex ? 'post-imperial-age' : current.endingAge,
    positionPolicy: positions.value,
  };
  if (
    slots.some((slot) => !Number.isInteger(slot) || slot < 1 || slot > 8) ||
    colors.some((color) => !Number.isInteger(color) || color < 0 || color > 7) ||
    validateRunConfiguration(configuration).length > 0
  ) {
    return null;
  }
  return withLockedSeed(configuration, seed);
}

function withFreeValues(active: readonly number[], start: number): number[] {
  const free = Array.from({ length: 8 }, (_, index) => index + start).filter(
    (value) => !active.includes(value),
  );
  return [...active, ...free].slice(0, 8);
}

export interface TemporaryRunConfiguration {
  previous: RunConfiguration;
}

export interface ReplayRunState {
  configuration: RunConfiguration;
  temporary: TemporaryRunConfiguration | null;
}

export function userRunConfiguration(state: ReplayRunState): RunConfiguration {
  if (!state.temporary) return state.configuration;
  return {
    ...state.temporary.previous,
    recentSeeds: [...state.configuration.recentSeeds],
    ...computerRunSettings(state.configuration),
  };
}

export function revertTemporaryRun(state: ReplayRunState): ReplayRunState {
  return { configuration: userRunConfiguration(state), temporary: null };
}

export function replayedRunChange(options: {
  state: ReplayRunState;
  lobby: ReplayedLobbySettings | null;
  seed: number;
}): ReplayRunState {
  const { state, lobby, seed } = options;
  const seedOnCurrent: ReplayRunState = {
    configuration: withLockedSeed(state.configuration, seed),
    temporary: state.temporary,
  };
  if (!lobby) return seedOnCurrent;
  if (state.temporary && replayedLobbyMatches(state.configuration, lobby)) return seedOnCurrent;
  const user = userRunConfiguration(state);
  if (replayedLobbyMatches(user, lobby)) {
    return { configuration: withLockedSeed(user, seed), temporary: null };
  }
  const replayed = replayedLobbyConfiguration(user, lobby, seed);
  if (!replayed) return seedOnCurrent;
  return {
    configuration: replayed,
    temporary: { previous: state.temporary?.previous ?? state.configuration },
  };
}
