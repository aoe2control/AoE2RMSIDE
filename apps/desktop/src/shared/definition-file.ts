import { isReservedWindowsDeviceName } from './windows-names';

export const definitionGroupIds = ['terrains', 'objects'] as const;
export type DefinitionGroupId = (typeof definitionGroupIds)[number];

export interface DefinitionName {
  id: number;
  name: string;
}

export interface DefinitionCandidate {
  id: number;
  base: string;
}

export interface DefinitionCandidates {
  builtIn: Record<DefinitionGroupId, DefinitionName[]>;
  gameFolder: Record<DefinitionGroupId, DefinitionCandidate[]>;
  reservedNames: string[];
}

export interface ProjectDefinitionFile {
  file: string;
  names: string[];
}

export interface ResolvedDefinitionGroup {
  builtIn: DefinitionName[];
  gameFolder: DefinitionName[];
  definedInProject: number;
  withoutUniqueName: number;
}

export type ResolvedDefinitions = Record<DefinitionGroupId, ResolvedDefinitionGroup>;

export interface DefinitionFileIdentities {
  gameVersion: string;
  gameVersionVerified: boolean;
}

export interface DefinitionFileOptions {
  groups: readonly DefinitionGroupId[];
  includeBuiltIn: boolean;
}

export const maximumDefinitionBaseLength = 60;

export const lobbyLabels: readonly string[] = Object.freeze([
  '0_TEAM_GAME',
  '1_PLAYER_GAME',
  '1_TEAM_GAME',
  '2_PLAYER_GAME',
  '2_TEAM_GAME',
  '3_PLAYER_GAME',
  '3_TEAM_GAME',
  '4_PLAYER_GAME',
  '4_TEAM_GAME',
  '5_PLAYER_GAME',
  '6_PLAYER_GAME',
  '7_PLAYER_GAME',
  '8_PLAYER_GAME',
  'AI_PLAYERS',
  'ANTIQUITY_MODE',
  'BATTLE_ROYALE',
  'CAPTURE_THE_RELIC',
  'CASTLE_AGE_START',
  'DARK_AGE_START',
  'DEATH_MATCH',
  'DEFAULT_RESOURCES',
  'DEFEND_WONDER',
  'DE_AVAILABLE',
  'DE_GAME_AGE2',
  'EMPIRE_WARS',
  'FEUDAL_AGE_START',
  'FIXED_POSITIONS',
  'FULL_TECH_TREE',
  'GIGANTIC_MAP',
  'HIGH_RESOURCES',
  'HUGE_MAP',
  'IMPERIAL_AGE_START',
  'INFINITE_RESOURCES',
  'KING_OT_HILL',
  'LARGE_MAP',
  'LOW_RESOURCES',
  'LUDIKRIS_MAP',
  'MAPSIZE_HUGE',
  'MAPSIZE_LARGE',
  'MAPSIZE_LUDICROUS',
  'MAPSIZE_MEDIUM',
  'MAPSIZE_NORMAL',
  'MAPSIZE_SMALL',
  'MAPSIZE_TINY',
  'MEDIUM_MAP',
  'MEDIUM_RESOURCES',
  ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((player) =>
    Array.from({ length: Math.min(player, 4) + 1 }, (_, team) => `PLAYER${player}_TEAM${team}`),
  ),
  'POST_IMPERIAL_AGE_START',
  'RANDOM_MAP',
  'RANDOM_RESOURCES',
  'REGICIDE',
  'SMALL_MAP',
  'SOLID_FARMS',
  'SUDDEN_DEATH',
  'TEAM0_SIZE0',
  ...[1, 2, 3, 4].flatMap((team) =>
    Array.from(
      { length: team === 1 ? 8 : 10 - team },
      (_, index) => `TEAM${team}_SIZE${team === 1 ? index + 1 : index}`,
    ),
  ),
  'TEAM_POSITIONS',
  'TINY_MAP',
  'TURBO_MODE',
  'TURBO_RANDOM_MAP',
  'WONDER_RACE',
]);

export function definitionIdentifier(text: string, group: DefinitionGroupId): string | null {
  const plain = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  if (plain.length === 0) return null;
  const prefixed = /^[0-9]/u.test(plain)
    ? `${group === 'terrains' ? 'TERRAIN' : 'OBJECT'}_${plain}`
    : plain;
  return prefixed.slice(0, maximumDefinitionBaseLength).replace(/_+$/u, '');
}

export function suffixedDefinitionName(base: string, id: number): string {
  return `${base}_${id}`;
}

export function isDefinitionName(name: string): boolean {
  return /^[A-Z0-9_]{1,80}$/u.test(name) && /[A-Z0-9]/u.test(name);
}

export function resolveDefinitionNames(
  candidates: DefinitionCandidates,
  project: readonly ProjectDefinitionFile[],
  excludedFile: string | null,
): ResolvedDefinitions {
  const projectNames = new Set<string>();
  for (const file of project) {
    if (excludedFile !== null && file.file === excludedFile) continue;
    for (const name of file.names) projectNames.add(name);
  }
  const taken = new Set<string>([...candidates.reservedNames, ...projectNames]);
  const baseUses = new Map<string, number>();
  for (const group of definitionGroupIds) {
    for (const candidate of candidates.gameFolder[group]) {
      baseUses.set(candidate.base, (baseUses.get(candidate.base) ?? 0) + 1);
    }
  }
  const proposed = new Map<DefinitionGroupId, DefinitionName[]>();
  const nameUses = new Map<string, number>();
  for (const group of definitionGroupIds) {
    const names = candidates.gameFolder[group].map((candidate) => ({
      id: candidate.id,
      name:
        baseUses.get(candidate.base) === 1 && !taken.has(candidate.base)
          ? candidate.base
          : suffixedDefinitionName(candidate.base, candidate.id),
    }));
    for (const entry of names) nameUses.set(entry.name, (nameUses.get(entry.name) ?? 0) + 1);
    proposed.set(group, names);
  }
  const resolved = {} as ResolvedDefinitions;
  for (const group of definitionGroupIds) {
    const builtIn = candidates.builtIn[group].filter((entry) => !projectNames.has(entry.name));
    const names = proposed.get(group)!;
    const gameFolder = names.filter(
      (entry) => nameUses.get(entry.name) === 1 && !taken.has(entry.name),
    );
    resolved[group] = {
      builtIn,
      gameFolder,
      definedInProject: candidates.builtIn[group].length - builtIn.length,
      withoutUniqueName: names.length - gameFolder.length,
    };
  }
  return resolved;
}

export function definitionGroupCount(
  resolved: ResolvedDefinitions,
  group: DefinitionGroupId,
  includeBuiltIn: boolean,
): number {
  const entries = resolved[group];
  return entries.gameFolder.length + (includeBuiltIn ? entries.builtIn.length : 0);
}

const groupHeadings: Readonly<Record<DefinitionGroupId, string>> = Object.freeze({
  terrains: 'Terrains',
  objects: 'Objects',
});

export function renderDefinitionFile(
  identities: DefinitionFileIdentities,
  resolved: ResolvedDefinitions,
  options: DefinitionFileOptions,
): string {
  const groups = definitionGroupIds.filter((group) => options.groups.includes(group));
  const builtIn = options.includeBuiltIn && groups.some((group) => resolved[group].builtIn.length);
  const gameFolder = groups.some((group) => resolved[group].gameFolder.length);
  const sources = [
    builtIn ? 'built-in' : null,
    gameFolder ? 'names from linked game folder' : null,
  ].filter((source): source is string => source !== null);
  const lines = [
    '/* Definition File generated by AoE2RMSIDE',
    `   Game version: ${identities.gameVersion}${identities.gameVersionVerified ? '' : ' (unverified)'}`,
    `   Groups: ${groups.join(', ')}`,
    `   Names: ${sources.join(' and ')} */`,
  ];
  const ordered = (entries: readonly DefinitionName[]) =>
    [...entries].sort(
      (left, right) =>
        left.id - right.id || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    );
  for (const group of groups) {
    const sections: Array<[string, readonly DefinitionName[]]> = [
      [
        `${groupHeadings[group]}: built-in names`,
        options.includeBuiltIn ? resolved[group].builtIn : [],
      ],
      [`${groupHeadings[group]}: names from the game folder`, resolved[group].gameFolder],
    ];
    for (const [heading, entries] of sections) {
      if (entries.length === 0) continue;
      lines.push('', `/* ${heading} */`);
      for (const entry of ordered(entries)) lines.push(`#const ${entry.name} ${entry.id}`);
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function suggestedDefinitionFileName(
  groups: readonly DefinitionGroupId[],
  reservedFileNames: ReadonlySet<string>,
): string {
  const stem = groups.length === 1 ? groups[0]! : 'definitions';
  const reserved = (name: string) => reservedFileNames.has(name.toLocaleLowerCase('en-US'));
  if (!reserved(`${stem}.inc`)) return `${stem}.inc`;
  for (let ordinal = 1; ordinal <= reservedFileNames.size + 1; ordinal += 1) {
    const candidate = `${stem}${ordinal === 1 ? '-local' : `-local-${ordinal}`}.inc`;
    if (!reserved(candidate)) return candidate;
  }
  return `${stem}-local.inc`;
}

export type DefinitionFileNameProblem = 'empty' | 'invalid' | 'extension' | 'reserved';

export function definitionFileNameProblem(
  name: string,
  reservedFileNames: ReadonlySet<string>,
): DefinitionFileNameProblem | null {
  if (name.trim().length === 0) return 'empty';
  if (
    name !== name.trim() ||
    /[<>:"/\\|?*\u0000-\u001f]/u.test(name) ||
    /[. ]$/u.test(name) ||
    isReservedWindowsDeviceName(name) ||
    new TextEncoder().encode(name).byteLength > 255
  ) {
    return 'invalid';
  }
  const stem = /^(.*)\.inc$/iu.exec(name)?.[1];
  if (stem === undefined || !/[^.\s]/u.test(stem)) return 'extension';
  if (reservedFileNames.has(name.toLocaleLowerCase('en-US'))) return 'reserved';
  return null;
}

export function definitionFileKey(relativePath: string): string {
  return relativePath.replaceAll('\\', '/').toLocaleLowerCase('en-US');
}

export const maximumProjectNamesPerFile = 20_000;

export function projectDefinedNames(text: string): string[] {
  const plain = text.replace(/\/\*[\s\S]*?(?:\*\/|$)/gu, ' ');
  const names = new Set<string>();
  for (const match of plain.matchAll(/(?:^|\s)#(?:const|define)\s+(\S+)/gu)) {
    names.add(match[1]!);
    if (names.size >= maximumProjectNamesPerFile) break;
  }
  return [...names].sort();
}
