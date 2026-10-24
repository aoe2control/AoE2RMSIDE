import {
  appMapSizeTiles,
  type AppQualityRun,
  type AppQualitySetting,
  type AppRunPlayer,
} from './connector-run-api';

export const qualityCaseIds = [
  'generation',
  'start-resources',
  'resource-distances',
  'shared-resources',
  'wood',
  'trapped',
  'paths',
  'building-space',
  'hills',
  'water',
  'spacing',
  'chokepoints',
  'variation',
  'looks',
] as const;

export type QualityCaseId = (typeof qualityCaseIds)[number];

export const qualityAlwaysOnCase = 'generation' satisfies QualityCaseId;

export const qualityScriptName = '@rmside/quality';

export const qualityCheckSeeds = Object.freeze({
  ideDefault: 20,
  minimum: 1,
  maximum: 4096,
});

export function isQualityCaseId(value: unknown): value is QualityCaseId {
  return typeof value === 'string' && (qualityCaseIds as readonly string[]).includes(value);
}

export function qualityCasesToRun(
  selected: readonly string[],
  catalog: readonly string[] = qualityCaseIds,
): string[] {
  const wanted = new Set(selected);
  const cases = catalog.filter((id) => id !== qualityAlwaysOnCase && wanted.has(id));
  return [qualityAlwaysOnCase, ...cases];
}

export function normalizeQualityCasesOff(value: unknown): QualityCaseId[] {
  if (!Array.isArray(value)) return [];
  const off = new Set(value.filter(isQualityCaseId));
  return qualityCaseIds.filter((id) => id !== qualityAlwaysOnCase && off.has(id));
}

export function qualityCasesSelected(casesOff: readonly string[]): QualityCaseId[] {
  const off = new Set(normalizeQualityCasesOff(casesOff));
  return qualityCaseIds.filter((id) => !off.has(id));
}

export function qualityCasesNarrowed(casesOff: readonly string[]): QualityCaseId[] | null {
  return normalizeQualityCasesOff(casesOff).length === 0 ? null : qualityCasesSelected(casesOff);
}

export function boundedQualitySeedCount(value: unknown): number | null {
  return Number.isSafeInteger(value) &&
    (value as number) >= qualityCheckSeeds.minimum &&
    (value as number) <= qualityCheckSeeds.maximum
    ? (value as number)
    : null;
}

export function qualitySeedCountFromDraft(draft: string): number | null {
  const trimmed = draft.trim();
  if (!/^\d{1,4}$/u.test(trimmed)) return null;
  return boundedQualitySeedCount(Number(trimmed));
}

export function qualitySeedRange(
  seedStart: number,
  seedCount: number,
): { first: number; last: number } {
  const first = seedStart >>> 0;
  return { first, last: (first + Math.max(1, seedCount) - 1) % 0x1_0000_0000 };
}

export const qualityCheckBounds = Object.freeze({ maps: 1600, settings: 16 });

export const qualityMultiSettings = Object.freeze([
  { mapSize: 'tiny', layout: '1v1' },
  { mapSize: 'medium', layout: '2v2' },
  { mapSize: 'huge', layout: '4v4' },
] as const);

export const qualityMultiSettingSeeds = 10;

function layoutTeams(layout: string): number[] {
  return layout
    .split('v')
    .flatMap((size, team) => Array.from({ length: Number(size) }, () => team + 1));
}

export function qualitySettingPlayers(
  base: readonly AppRunPlayer[],
  count: number,
  teams?: readonly number[],
): AppRunPlayer[] {
  const usedSlots = new Set<number>();
  const usedColors = new Set<number>();
  const players: AppRunPlayer[] = [];
  const firstCivilization = base[0]?.civilizationId ?? 0;
  for (let index = 0; index < Math.min(count, 8); index += 1) {
    const own = base[index];
    let slot = own && own.slot >= 1 && own.slot <= 8 && !usedSlots.has(own.slot) ? own.slot : 0;
    for (let candidate = 1; slot === 0 && candidate <= 8; candidate += 1) {
      if (!usedSlots.has(candidate)) slot = candidate;
    }
    let color = own && own.color <= 7 && !usedColors.has(own.color) ? own.color : -1;
    for (let candidate = 0; color < 0 && candidate <= 7; candidate += 1) {
      if (!usedColors.has(candidate)) color = candidate;
    }
    usedSlots.add(slot || 1);
    usedColors.add(Math.max(color, 0));
    players.push({
      slot: slot || 1,
      team: teams?.[index] ?? own?.team ?? 0,
      civilizationId: own ? own.civilizationId : firstCivilization,
      color: Math.max(color, 0),
    });
  }
  return players;
}

export type QualityOwnSetting = Omit<AppQualitySetting, 'seedCount'>;

function sameSetting(left: QualityOwnSetting, right: QualityOwnSetting): boolean {
  return (
    left.mapSize === right.mapSize &&
    left.width === right.width &&
    left.height === right.height &&
    left.players.length === right.players.length &&
    left.players.every((player, index) => {
      const other = right.players[index]!;
      return (
        player.slot === other.slot &&
        player.team === other.team &&
        player.civilizationId === other.civilizationId &&
        player.color === other.color
      );
    })
  );
}

export function qualityMultiSettingPlan(
  own: QualityOwnSetting,
  seedCount: number,
): AppQualitySetting[] {
  const variants = qualityMultiSettings
    .map(({ mapSize, layout }) => {
      const tiles = appMapSizeTiles(mapSize)!;
      const teams = layoutTeams(layout);
      return {
        mapSize,
        width: tiles,
        height: tiles,
        players: qualitySettingPlayers(own.players, teams.length, teams),
      };
    })
    .filter((variant) => !sameSetting(variant, own))
    .slice(0, qualityCheckBounds.settings - 1)
    .map((variant) => ({ ...variant, seedCount: qualityMultiSettingSeeds }));
  const room = qualityCheckBounds.maps - variants.length * qualityMultiSettingSeeds;
  const ownSeeds = Math.max(qualityCheckSeeds.minimum, Math.min(seedCount, room));
  return [{ ...structuredClone(own), seedCount: ownSeeds }, ...variants];
}

export function ideQualityRun(options: {
  casesOff: readonly string[];
  seedStart: number;
  seedCount: number;
  multiSetting?: QualityOwnSetting | null;
}): AppQualityRun {
  const seedCount = boundedQualitySeedCount(options.seedCount) ?? qualityCheckSeeds.ideDefault;
  const settings = options.multiSetting
    ? qualityMultiSettingPlan(options.multiSetting, seedCount)
    : [];
  return {
    caseIds: qualityCasesSelected(options.casesOff),
    seedStart: options.seedStart >>> 0,
    seedCount: settings[0]?.seedCount ?? seedCount,
    settings,
  };
}

export const qualityLibraryModule = '@rmside/quality';

export function scriptLoadsQualityLibrary(source: string): boolean {
  const recent: string[] = [];
  const push = (token: string) => {
    recent.push(token);
    if (recent.length > 3) recent.shift();
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '#') {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    let quoteAt = -1;
    if (char === '"' || char === "'") quoteAt = index;
    else if (/[A-Za-z_]/u.test(char)) {
      let end = index + 1;
      while (end < source.length && /\w/u.test(source[end]!)) end += 1;
      const word = source.slice(index, end);
      if (/^(?:r|b|rb|br)$/iu.test(word) && (source[end] === '"' || source[end] === "'")) {
        quoteAt = end;
      } else {
        push(`name:${word}`);
        index = end;
        continue;
      }
    }
    if (quoteAt >= 0) {
      const quote = source[quoteAt]!;
      const delimiter = source.startsWith(quote.repeat(3), quoteAt) ? quote.repeat(3) : quote;
      let end = quoteAt + delimiter.length;
      while (end < source.length && !source.startsWith(delimiter, end)) {
        if (delimiter.length === 1 && source[end] === '\n') break;
        end += source[end] === '\\' ? 2 : 1;
      }
      const value = source.slice(quoteAt + delimiter.length, Math.min(end, source.length));
      if (
        value === qualityLibraryModule &&
        recent.at(-1) === 'punct:(' &&
        recent.at(-2) === 'name:load' &&
        recent.at(-3) !== 'punct:.'
      ) {
        return true;
      }
      push('string');
      index = end + delimiter.length;
      continue;
    }
    push(`punct:${char}`);
    index += 1;
  }
  return false;
}

export function qualityRunMaps(run: AppQualityRun): number {
  return run.settings.length === 0
    ? run.seedCount
    : run.settings.reduce((sum, setting) => sum + (setting.seedCount || run.seedCount), 0);
}
