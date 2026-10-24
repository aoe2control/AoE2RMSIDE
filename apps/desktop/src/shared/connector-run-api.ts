export const appRunKinds = ['generate', 'show', 'map-test', 'quality-check'] as const;
export type AppRunKind = (typeof appRunKinds)[number];

export const appMapSizes = [
  { name: 'tiny', tiles: 120 },
  { name: 'small', tiles: 144 },
  { name: 'medium', tiles: 168 },
  { name: 'normal', tiles: 200 },
  { name: 'large', tiles: 220 },
  { name: 'huge', tiles: 240 },
  { name: 'ludicrous', tiles: 480 },
] as const;
export type AppMapSize = (typeof appMapSizes)[number]['name'];

export const appRunLimits = Object.freeze({
  token: 64,
  app: 128,
  path: 4096,
  name: 512,
  option: 32,
  label: 200,
  message: 2048,
  changed: 8,
  qualityCases: 32,
  qualitySettings: 16,
  qualitySeeds: 4096,
});

export interface AppRunSettings {
  mapSize?: AppMapSize;
  players?: number;
  teams?: number[] | 'ffa';
  civs?: string[];
  gameMode?: string;
  age?: string;
  resources?: string;
}

export interface AppRunPlayer {
  slot: number;
  team: number;
  civilizationId: number;
  color: number;
}

export interface AppQualitySetting {
  mapSize: string;
  width: number;
  height: number;
  players: AppRunPlayer[];
  seedCount: number;
}

export interface AppQualityRun {
  caseIds: string[];
  seedStart: number;
  seedCount: number;
  settings: AppQualitySetting[];
}

export interface AppRunRequest {
  token: string;
  app: string;
  kind: AppRunKind;
  path: string | null;
  seed?: number;
  settings?: AppRunSettings;
  quality?: AppQualityRun;
}

export type AppRunSupersededReason = 'newer-run' | 'source-changed' | 'other-execution';

export type AppRunReply =
  | {
      outcome: 'done';
      path: string | null;
      name: string;
      seed: number;
      settings: string;
      players: { team: number }[];
      changed: string[];
    }
  | {
      outcome: 'failed';
      path: string | null;
      name: string;
      stage: string;
      message: string;
    }
  | { outcome: 'cancelled' }
  | { outcome: 'superseded'; reason: AppRunSupersededReason }
  | { outcome: 'busy' };

export interface AppRunContextRequest {
  path: string | null;
}

export interface AppRunContext {
  path: string | null;
  name: string;
  mapSize: string;
  width: number;
  height: number;
  players: AppRunPlayer[];
  qualityCases: string[] | null;
}

const tokenPattern = /^[A-Za-z0-9-]{8,64}$/u;
const optionPattern = /^[a-z][a-z0-9_-]{0,31}$/u;
const casePattern = /^[a-z][a-z0-9-]{0,63}$/u;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${label} has the unknown field ${key}`);
  }
}

function text(value: unknown, minimum: number, maximum: number, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`${label} is not text of ${minimum} to ${maximum} characters`);
  }
  return value;
}

function nullablePath(value: unknown, label: string): string | null {
  return value === null ? null : text(value, 1, appRunLimits.path, label);
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} is not an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new Error(`${label} is not one of ${values.join(', ')}`);
  }
  return value as T;
}

function list<T>(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
  item: (entry: unknown, label: string) => T,
): T[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} is not a list of ${minimum} to ${maximum}`);
  }
  return value.map((entry, index) => item(entry, `${label}[${index}]`));
}

function option(value: unknown, label: string): string {
  if (typeof value !== 'string' || !optionPattern.test(value)) {
    throw new Error(`${label} is not an option name`);
  }
  return value;
}

export function appMapSizeTiles(name: string): number | undefined {
  return appMapSizes.find((size) => size.name === name)?.tiles;
}

export function validateAppRunSettings(value: unknown, label: string): AppRunSettings {
  const settings = record(value, label);
  knownKeys(
    settings,
    ['mapSize', 'players', 'teams', 'civs', 'gameMode', 'age', 'resources'],
    label,
  );
  const result: AppRunSettings = {};
  if (settings.mapSize !== undefined) {
    result.mapSize = oneOf(
      settings.mapSize,
      appMapSizes.map((size) => size.name),
      `${label}.mapSize`,
    );
  }
  if (settings.players !== undefined) {
    result.players = integer(settings.players, 1, 8, `${label}.players`);
  }
  if (settings.teams === 'ffa') {
    result.teams = 'ffa';
  } else if (settings.teams !== undefined) {
    const teams = list(settings.teams, 1, 8, `${label}.teams`, (entry, entryLabel) =>
      integer(entry, 0, 4, entryLabel),
    );
    if (result.players === undefined || teams.length !== result.players) {
      throw new Error(`${label}.teams does not match the player count`);
    }
    result.teams = teams;
  }
  if (settings.civs !== undefined) {
    result.civs = list(settings.civs, 1, 8, `${label}.civs`, option);
  }
  for (const key of ['gameMode', 'age', 'resources'] as const) {
    if (settings[key] !== undefined) result[key] = option(settings[key], `${label}.${key}`);
  }
  return result;
}

function validatePlayer(value: unknown, label: string): AppRunPlayer {
  const player = record(value, label);
  knownKeys(player, ['slot', 'team', 'civilizationId', 'color'], label);
  return {
    slot: integer(player.slot, 1, 8, `${label}.slot`),
    team: integer(player.team, 0, 8, `${label}.team`),
    civilizationId: integer(player.civilizationId, 0, 0xffff_ffff, `${label}.civilizationId`),
    color: integer(player.color, 0, 255, `${label}.color`),
  };
}

function validatePlayers(value: unknown, label: string): AppRunPlayer[] {
  const players = list(value, 1, 8, label, validatePlayer);
  if (new Set(players.map((player) => player.slot)).size !== players.length) {
    throw new Error(`${label} repeats a slot`);
  }
  return players;
}

export function validateAppQualityRun(value: unknown, label: string): AppQualityRun {
  const quality = record(value, label);
  knownKeys(quality, ['caseIds', 'seedStart', 'seedCount', 'settings'], label);
  const caseIds = list(
    quality.caseIds,
    1,
    appRunLimits.qualityCases,
    `${label}.caseIds`,
    (entry, entryLabel) => {
      if (typeof entry !== 'string' || !casePattern.test(entry)) {
        throw new Error(`${entryLabel} is not a case id`);
      }
      return entry;
    },
  );
  if (new Set(caseIds).size !== caseIds.length) throw new Error(`${label}.caseIds repeats a case`);
  const seedCount = integer(quality.seedCount, 1, appRunLimits.qualitySeeds, `${label}.seedCount`);
  const settings = list(
    quality.settings,
    0,
    appRunLimits.qualitySettings,
    `${label}.settings`,
    (entry, entryLabel) => {
      const setting = record(entry, entryLabel);
      knownKeys(setting, ['mapSize', 'width', 'height', 'players', 'seedCount'], entryLabel);
      return {
        mapSize: text(setting.mapSize, 1, 64, `${entryLabel}.mapSize`),
        width: integer(setting.width, 1, 512, `${entryLabel}.width`),
        height: integer(setting.height, 1, 512, `${entryLabel}.height`),
        players: validatePlayers(setting.players, `${entryLabel}.players`),
        seedCount: integer(
          setting.seedCount,
          0,
          appRunLimits.qualitySeeds,
          `${entryLabel}.seedCount`,
        ),
      };
    },
  );
  const maps =
    settings.length === 0
      ? seedCount
      : settings.reduce((sum, setting) => sum + (setting.seedCount || seedCount), 0);
  if (maps > appRunLimits.qualitySeeds) throw new Error(`${label} asks for too many maps`);
  return {
    caseIds,
    seedStart: integer(quality.seedStart, 0, 0xffff_ffff, `${label}.seedStart`),
    seedCount,
    settings,
  };
}

export function validateAppRunRequest(value: unknown): AppRunRequest {
  const request = record(value, 'app run request');
  knownKeys(
    request,
    ['token', 'app', 'kind', 'path', 'seed', 'settings', 'quality'],
    'app run request',
  );
  if (typeof request.token !== 'string' || !tokenPattern.test(request.token)) {
    throw new Error('app run token is invalid');
  }
  const kind = oneOf(request.kind, appRunKinds, 'app run kind');
  if ((kind === 'quality-check') !== (request.quality !== undefined)) {
    throw new Error('app run quality options belong to a quality check and only to it');
  }
  return {
    token: request.token,
    app: text(request.app, 1, appRunLimits.app, 'app run app'),
    kind,
    path: nullablePath(request.path, 'app run path'),
    ...(request.seed === undefined
      ? {}
      : { seed: integer(request.seed, 0, 0xffff_ffff, 'app run seed') }),
    ...(request.settings === undefined
      ? {}
      : { settings: validateAppRunSettings(request.settings, 'app run settings') }),
    ...(request.quality === undefined
      ? {}
      : { quality: validateAppQualityRun(request.quality, 'app run quality') }),
  };
}

export function validateAppRunReply(value: unknown): AppRunReply {
  const reply = record(value, 'app run reply');
  const outcome = oneOf(
    reply.outcome,
    ['done', 'failed', 'cancelled', 'superseded', 'busy'] as const,
    'app run outcome',
  );
  switch (outcome) {
    case 'done': {
      knownKeys(
        reply,
        ['outcome', 'path', 'name', 'seed', 'settings', 'players', 'changed'],
        'app run reply',
      );
      return {
        outcome,
        path: nullablePath(reply.path, 'app run reply path'),
        name: text(reply.name, 1, appRunLimits.name, 'app run reply name'),
        seed: integer(reply.seed, 0, 0xffff_ffff, 'app run reply seed'),
        settings: text(reply.settings, 1, appRunLimits.label, 'app run reply settings'),
        players: list(reply.players, 1, 8, 'app run reply players', (entry, label) => {
          const player = record(entry, label);
          knownKeys(player, ['team'], label);
          return { team: integer(player.team, 0, 8, `${label}.team`) };
        }),
        changed: list(
          reply.changed,
          0,
          appRunLimits.changed,
          'app run reply changed',
          (entry, label) => option(entry, label),
        ),
      };
    }
    case 'failed':
      knownKeys(reply, ['outcome', 'path', 'name', 'stage', 'message'], 'app run reply');
      return {
        outcome,
        path: nullablePath(reply.path, 'app run reply path'),
        name: text(reply.name, 1, appRunLimits.name, 'app run reply name'),
        stage: option(reply.stage, 'app run reply stage'),
        message: text(reply.message, 1, appRunLimits.message, 'app run reply message'),
      };
    case 'superseded':
      knownKeys(reply, ['outcome', 'reason'], 'app run reply');
      return {
        outcome,
        reason: oneOf(
          reply.reason,
          ['newer-run', 'source-changed', 'other-execution'] as const,
          'app run reply reason',
        ),
      };
    default:
      knownKeys(reply, ['outcome'], 'app run reply');
      return { outcome };
  }
}

export function validateAppRunContextRequest(value: unknown): AppRunContextRequest {
  const request = record(value, 'app run context request');
  knownKeys(request, ['path'], 'app run context request');
  return { path: nullablePath(request.path, 'app run context path') };
}

export function validateAppRunContext(value: unknown): AppRunContext {
  const context = record(value, 'app run context');
  knownKeys(
    context,
    ['path', 'name', 'mapSize', 'width', 'height', 'players', 'qualityCases'],
    'app run context',
  );
  return {
    path: nullablePath(context.path, 'app run context path'),
    name: text(context.name, 1, appRunLimits.name, 'app run context name'),
    mapSize: text(context.mapSize, 1, 64, 'app run context mapSize'),
    width: integer(context.width, 1, 512, 'app run context width'),
    height: integer(context.height, 1, 512, 'app run context height'),
    players: validatePlayers(context.players, 'app run context players'),
    qualityCases:
      context.qualityCases === null
        ? null
        : list(
            context.qualityCases,
            1,
            appRunLimits.qualityCases,
            'app run context qualityCases',
            (entry, label) => {
              if (typeof entry !== 'string' || !casePattern.test(entry)) {
                throw new Error(`${label} is not a case id`);
              }
              return entry;
            },
          ),
  };
}

export function appTeamsText(teams: readonly number[]): string {
  if (teams.every((team) => team === 0)) return 'ffa';
  const sizes = new Map<number, number>();
  let solo = 0;
  for (const team of teams) {
    if (team === 0) solo += 1;
    else sizes.set(team, (sizes.get(team) ?? 0) + 1);
  }
  const groups = [...sizes.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
  for (let index = 0; index < solo; index += 1) groups.push(1);
  return groups.join('v');
}
