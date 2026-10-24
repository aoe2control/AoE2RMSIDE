import { appMapSizes, type AppMapSize, type AppRunSettings } from '../../shared/connector-run-api';
import { ConnectorToolError } from './dispatcher';
import type { ConnectorJsonValue, ConnectorToolArguments } from './validator';

const seedRange = 0x1_0000_0000;

export function unsignedSeed(value: number): number {
  if (!Number.isSafeInteger(value) || value < -0x8000_0000 || value > 0xffff_ffff) {
    throw new ConnectorToolError('invalid_arguments', "The seed is outside the game's range.", {
      hint: 'Use 0 to 4294967295, or the signed form -2147483648 to -1.',
    });
  }
  return value < 0 ? value + seedRange : value;
}

export function parseMapSize(
  value: string,
  field = 'map_size',
): { name: AppMapSize; tiles: number } {
  const named = appMapSizes.find((size) => size.name === value);
  if (named) return { name: named.name, tiles: named.tiles };
  const tiles = /^[0-9]+$/u.test(value) ? Number(value) : Number.NaN;
  const bySize = appMapSizes.find((size) => size.tiles === tiles);
  if (bySize) return { name: bySize.name, tiles: bySize.tiles };
  throw new ConnectorToolError('invalid_arguments', `${field} ${value} is not a lobby map size.`, {
    hint: `Use ${appMapSizes.map((size) => `${size.name} (${size.tiles})`).join(', ')}.`,
  });
}

export interface ParsedTeams {
  players: number;
  teams: number[];
}

export function parseTeams(
  value: string,
  players: number | undefined,
  field = 'teams',
  fallbackPlayers?: number,
): ParsedTeams {
  if (value === 'ffa') {
    const count = players ?? fallbackPlayers;
    if (count === undefined) {
      throw new ConnectorToolError('invalid_arguments', `${field} ffa needs players.`);
    }
    return { players: count, teams: Array.from({ length: count }, () => 0) };
  }
  const sizes = value.split('v').map(Number);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (sizes.some((size) => !Number.isInteger(size) || size < 1)) {
    throw new ConnectorToolError(
      'invalid_arguments',
      `${field} ${value} is not a team layout such as 2v2, 2v1v1 or ffa.`,
    );
  }
  if (total > 8) {
    throw new ConnectorToolError('invalid_arguments', `${field} ${value} has more than 8 players.`);
  }
  if (players !== undefined && players !== total) {
    throw new ConnectorToolError(
      'invalid_arguments',
      `${field} ${value} has ${total} players, but players is ${players}.`,
    );
  }
  if (sizes.length > 4) {
    if (sizes.every((size) => size === 1)) {
      return { players: total, teams: Array.from({ length: total }, () => 0) };
    }
    throw new ConnectorToolError('invalid_arguments', `${field} ${value} has more than 4 teams.`, {
      hint: 'The lobby has teams 1 to 4; use ffa for players without a team.',
    });
  }
  const teams: number[] = [];
  sizes.forEach((size, index) => {
    for (let player = 0; player < size; player += 1) teams.push(index + 1);
  });
  return { players: total, teams };
}

function optionalString(value: ConnectorJsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalInteger(value: ConnectorJsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

export function optionKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, '-');
}

function lobbyOption(value: string, field: string): string {
  const key = optionKey(value);
  if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(key)) {
    throw new ConnectorToolError(
      'invalid_arguments',
      `${field} has the unknown value ${value.slice(0, 40)}.`,
    );
  }
  return key;
}

const settingsField = (name: string) => `settings.${name}`;

export function parseRunSettings(
  value: ConnectorJsonValue | undefined,
): AppRunSettings | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as ConnectorToolArguments;
  const settings: AppRunSettings = {};
  const size = optionalString(raw.map_size);
  if (size !== undefined) settings.mapSize = parseMapSize(size, settingsField('map_size')).name;
  const players = optionalInteger(raw.players);
  if (players !== undefined) settings.players = players;
  const teams = optionalString(raw.teams);
  if (teams === 'ffa') {
    settings.teams = 'ffa';
  } else if (teams !== undefined) {
    const parsed = parseTeams(teams, players, settingsField('teams'));
    settings.players = parsed.players;
    settings.teams = parsed.teams;
  }
  if (Array.isArray(raw.civs)) {
    settings.civs = raw.civs
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => lobbyOption(entry, settingsField('civs')));
    const count = settings.players;
    if (count !== undefined && settings.civs.length > count) {
      throw new ConnectorToolError(
        'invalid_arguments',
        `settings.civs names ${settings.civs.length} civilizations for ${count} players.`,
      );
    }
  }
  for (const [key, target] of [
    ['game_mode', 'gameMode'],
    ['age', 'age'],
    ['resources', 'resources'],
  ] as const) {
    const entry = optionalString(raw[key]);
    if (entry !== undefined) settings[target] = lobbyOption(entry, `settings.${key}`);
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

export function waitMilliseconds(
  value: ConnectorJsonValue | undefined,
  defaultSeconds: number,
  maximumSeconds: number,
): number {
  const seconds = typeof value === 'number' ? value : defaultSeconds;
  return Math.max(0, Math.min(maximumSeconds, seconds)) * 1000;
}
