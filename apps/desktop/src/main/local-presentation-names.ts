import { join } from 'node:path';
import type {
  LocalDisplayStringStatus,
  LocalPresentationName,
  LocalPresentationNames,
  TerrainMinimapColor,
} from '../shared/api';
import { gameLanguageFor } from '../shared/i18n/languages';
import { activeTranslator } from '../shared/i18n/translator';
import { isConstant, localPresentationNameLimits } from '../shared/local-presentation-names';
import {
  localMinimapPaletteLimits,
  localMinimapPaletteRelativePath,
  parseJascPalette,
  resolveTerrainMinimapColors,
  type TerrainMinimapIndices,
} from './local-presentation-palette';

export const fallbackPresentationLanguage = 'en';

export function activePresentationLanguage(): string {
  return gameLanguageFor(activeTranslator().locale);
}

export function presentationLanguageFor(reader: 'preview' | 'definition-file'): string {
  return reader === 'preview' ? activePresentationLanguage() : fallbackPresentationLanguage;
}

export function isPresentationLanguage(language: unknown): language is string {
  return typeof language === 'string' && /^[a-z]{2,8}$/u.test(language);
}

export const localPresentationFileLimits = Object.freeze({
  maximumDefinitionBytes: 4 * 1024 * 1024,
  maximumDefinitionLines: 200_000,
  maximumIncludeFiles: 4_096,
  maximumTotalDefinitionBytes: 32 * 1024 * 1024,
  maximumStringTableBytes: 32 * 1024 * 1024,
  maximumStringTableLines: 400_000,
  maximumSupplementaryStringTables: 16,
  maximumTotalStringTableBytes: 96 * 1024 * 1024,
});

export type ConstantSection = 'terrain' | 'object' | 'other' | 'unclassified';

export interface DatMembership {
  objectIds: ReadonlySet<number>;
  terrainSlotCount: number;
}

export interface ConstantNameTable {
  objects: Map<number, string[]>;
  terrains: Map<number, string[]>;
  seen: Set<string>;
}

export function emptyConstantNameTable(): ConstantNameTable {
  return { objects: new Map(), terrains: new Map(), seen: new Set() };
}

export function classifyConstantHeading(text: string): ConstantSection | null {
  if (!/[a-z]/iu.test(text) || /#const/iu.test(text)) return null;
  const heading = text.toLowerCase();
  if (/class/u.test(heading)) return 'other';
  if (/\bterrains?\b/u.test(heading)) return 'terrain';
  if (
    /\b(objects?|gaia|units?|buildings?|animals?|resource constants|exported from the database)\b/u.test(
      heading,
    )
  ) {
    return 'object';
  }
  if (
    /(maps?\b|civili[sz]ation|effect|attribute|amount|technolog|\btechs?\b|cliff|colou?r|water|assign|\bai\b|player|resource|\bages?\b|victory|setting)/u.test(
      heading,
    )
  ) {
    return 'other';
  }
  return 'unclassified';
}

export function classifyConstantValue(
  section: ConstantSection,
  value: number,
  membership?: DatMembership,
): 'object' | 'terrain' | null {
  if (section === 'other') return null;
  if (membership) {
    const object = membership.objectIds.has(value);
    const terrain = value >= 0 && value < membership.terrainSlotCount;
    if (object && !terrain) return 'object';
    if (terrain && !object) return 'terrain';
  }
  return section === 'unclassified' ? null : section;
}

export function parseRmsConstantNames(
  bytes: Uint8Array,
  table: ConstantNameTable = emptyConstantNameTable(),
  membership?: DatMembership,
): ConstantNameTable {
  if (bytes.byteLength > localPresentationFileLimits.maximumDefinitionBytes) {
    throw new Error('RMS definition file exceeds the presentation-name size limit');
  }
  let text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  if (text.startsWith('ï»¿')) text = text.slice(3);
  const lines = text.split(/\r\n|\r|\n/u);
  if (lines.length > localPresentationFileLimits.maximumDefinitionLines) {
    throw new Error('RMS definition file exceeds the presentation-name line limit');
  }
  let section: ConstantSection = 'unclassified';
  let inComment = false;
  for (const line of lines) {
    let code = '';
    let comment = '';
    for (let index = 0; index < line.length; index += 1) {
      if (inComment) {
        if (line.startsWith('*/', index)) {
          inComment = false;
          comment += ' ';
          index += 1;
        } else {
          comment += line[index];
        }
      } else if (line.startsWith('/*', index)) {
        inComment = true;
        index += 1;
      } else {
        code += line[index];
      }
    }
    const trimmedCode = code.trim();
    const headingText =
      trimmedCode === '' || /^#define\s+\S+$/u.test(trimmedCode) ? comment.trim() : '';
    if (headingText) {
      section = classifyConstantHeading(headingText) ?? section;
    }
    if (section === 'other') continue;
    const definition = /^#const\s+(\S+)\s+([+-]?\d{1,10})$/u.exec(trimmedCode);
    if (!definition) continue;
    const name = definition[1]!;
    const value = Number(definition[2]);
    const kind = classifyConstantValue(section, value, membership);
    if (!kind) continue;
    const maximum =
      kind === 'terrain'
        ? localPresentationNameLimits.maximumTerrainId
        : localPresentationNameLimits.maximumObjectId;
    if (!isConstant(name) || table.seen.has(name) || value < 0 || value > maximum) continue;
    table.seen.add(name);
    const names = kind === 'terrain' ? table.terrains : table.objects;
    const existing = names.get(value);
    if (!existing) names.set(value, [name]);
    else if (existing.length <= localPresentationNameLimits.maximumAliases) existing.push(name);
  }
  return table;
}

export function parseKeyValueStrings(
  bytes: Uint8Array,
  wanted: ReadonlySet<number>,
): Map<number, string> {
  if (bytes.byteLength > localPresentationFileLimits.maximumStringTableBytes) {
    throw new Error('string table exceeds the presentation-name size limit');
  }
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (text.startsWith('﻿')) text = text.slice(1);
  const lines = text.split(/\r\n|\r|\n/u);
  if (lines.length > localPresentationFileLimits.maximumStringTableLines) {
    throw new Error('string table exceeds the presentation-name line limit');
  }
  const strings = new Map<number, string>();
  for (const line of lines) {
    const match = /^\s*(\d{1,9})\s+"((?:[^"\\]|\\.)*)"/u.exec(line);
    if (!match) continue;
    const id = Number(match[1]);
    if (!wanted.has(id) || strings.has(id)) continue;
    const value = match[2]!
      .replace(/\\(.)/gu, (_, escaped: string) =>
        escaped === 'n' || escaped === 't' ? ' ' : escaped,
      )
      .replace(/(?![‌‍])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    if (value.length === 0) continue;
    strings.set(id, truncateDisplayName(value));
  }
  return strings;
}

function truncateDisplayName(value: string): string {
  const maximum = localPresentationNameLimits.maximumDisplayNameLength;
  if (value.length <= maximum) return value;
  const last = value.charCodeAt(maximum - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? maximum - 1 : maximum;
  return value.slice(0, end).trimEnd();
}

export interface PresentationStringIdsResult {
  status: 'available' | 'unsupported-layout' | 'unreadable';
  objects: ReadonlyArray<{ id: number; stringId: number }>;
  terrains: ReadonlyArray<{ id: number; stringId: number }>;
  objectSlots?: ReadonlyArray<{ id: number; standingGraphic: boolean }>;
  terrainSlotCount?: number;
  terrainMinimapIndices?: ReadonlyArray<TerrainMinimapIndices>;
}

export function datMembership(
  ids: PresentationStringIdsResult | undefined,
): DatMembership | undefined {
  if (ids?.status !== 'available' || !ids.objectSlots || ids.objectSlots.length === 0) {
    return undefined;
  }
  return {
    objectIds: new Set(ids.objectSlots.map((slot) => slot.id)),
    terrainSlotCount: ids.terrainSlotCount ?? 0,
  };
}

export function buildLocalPresentationNames(input: {
  constants: ConstantNameTable;
  productVersion: string | null;
  productVersionVerified: boolean;
  displayStrings: LocalDisplayStringStatus;
  objectText?: ReadonlyMap<number, string>;
  terrainText?: ReadonlyMap<number, string>;
  graphiclessObjectIds?: readonly number[];
  terrainColors?: readonly TerrainMinimapColor[];
}): LocalPresentationNames {
  const entries = (
    constants: Map<number, string[]>,
    text: ReadonlyMap<number, string> | undefined,
    maximumId: number,
  ): LocalPresentationName[] => {
    const ids = new Set<number>(constants.keys());
    for (const id of text?.keys() ?? []) if (id >= 0 && id <= maximumId) ids.add(id);
    return [...ids]
      .sort((left, right) => left - right)
      .map((id) => {
        const names = constants.get(id) ?? [];
        return {
          id,
          displayName: text?.get(id) ?? null,
          constant: names[0] ?? null,
          aliases: names.slice(1, 1 + localPresentationNameLimits.maximumAliases),
        };
      });
  };
  return {
    contractVersion: { major: 1, minor: 2, patch: 0 },
    productVersion: input.productVersion,
    productVersionVerified: input.productVersionVerified,
    displayStrings: input.displayStrings,
    objects: entries(
      input.constants.objects,
      input.objectText,
      localPresentationNameLimits.maximumObjectId,
    ),
    terrains: entries(
      input.constants.terrains,
      input.terrainText,
      localPresentationNameLimits.maximumTerrainId,
    ),
    graphiclessObjectIds: [...new Set(input.graphiclessObjectIds ?? [])]
      .filter(
        (id) =>
          Number.isInteger(id) && id >= 0 && id <= localPresentationNameLimits.maximumObjectId,
      )
      .sort((left, right) => left - right),
    terrainColors: (input.terrainColors ?? []).map((entry) => ({ ...entry })),
  };
}

export interface FileStamp {
  size: number;
  mtimeMs: number;
}

export function localPresentationCacheKey(
  installationRoot: string,
  productVersion: string | null,
  files: ReadonlyArray<readonly [string, FileStamp | null]>,
): string {
  const root = installationRoot.replaceAll('\\', '/').toLocaleLowerCase('en-US');
  const stamps = files
    .map(([name, stamp]) => `${name}=${stamp ? `${stamp.size}:${stamp.mtimeMs}` : '-'}`)
    .join('|');
  return `${root}\u0000${productVersion ?? ''}\u0000${stamps}`;
}

export interface LocalPresentationNameHost {
  stat(path: string): Promise<FileStamp | null>;
  readFile(path: string, maximumBytes: number): Promise<Uint8Array | null>;
  listDirectory?(path: string): Promise<string[] | null>;
  readStringIds(datPath: string): Promise<PresentationStringIdsResult>;
}

export interface LocalPresentationInstallation {
  installationRoot: string;
  gamedataRoot: string;
  productVersion: string | null;
  productVersionVerified: boolean;
  standardIncludes: readonly string[];
}

export const localDatRelativePath = join('resources', '_common', 'dat', 'empires2_x2_p1.dat');

export function localStringTableRelativePath(language = fallbackPresentationLanguage): string {
  return join(localStringTableDirectory(language), localBaseStringTableName);
}

export function localStringTableDirectory(language = fallbackPresentationLanguage): string {
  return join('resources', language, 'strings', 'key-value');
}

const localBaseStringTableName = 'key-value-strings-utf8.txt';

export function supplementaryStringTableNames(names: readonly string[]): string[] {
  return [
    ...new Set(
      names.filter(
        (name) =>
          /^key-value-[a-z0-9]+(?:-[a-z0-9]+)*-strings-utf8\.txt$/iu.test(name) &&
          name.toLowerCase() !== localBaseStringTableName,
      ),
    ),
  ]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, localPresentationFileLimits.maximumSupplementaryStringTables);
}

interface StringTableSet {
  language: string;
  paths: string[];
}

const maximumCachedLanguages = 2;

export class LocalPresentationNameService {
  private readonly cache = new Map<string, { key: string; value: LocalPresentationNames }>();
  private readonly pending = new Map<string, Promise<LocalPresentationNames>>();

  constructor(private readonly host: LocalPresentationNameHost) {}

  async names(
    installation: LocalPresentationInstallation,
    language: string = fallbackPresentationLanguage,
  ): Promise<LocalPresentationNames> {
    const requested = isPresentationLanguage(language) ? language : fallbackPresentationLanguage;
    const includes = [...new Set(installation.standardIncludes)]
      .filter((path) => isSafeRelativeInclude(path))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .slice(0, localPresentationFileLimits.maximumIncludeFiles);
    const definitionFiles = [
      'random_map.def',
      ...includes.filter((path) => path.toLowerCase() !== 'random_map.def'),
    ];
    const datPath = join(installation.installationRoot, localDatRelativePath);
    const tableLanguages =
      requested === fallbackPresentationLanguage
        ? [requested]
        : [requested, fallbackPresentationLanguage];
    const tables: StringTableSet[] = [];
    for (const tableLanguage of tableLanguages) {
      const directory = join(
        installation.installationRoot,
        localStringTableDirectory(tableLanguage),
      );
      let listed: string[] | null = null;
      try {
        listed = (await this.host.listDirectory?.(directory)) ?? null;
      } catch {
        listed = null;
      }
      tables.push({
        language: tableLanguage,
        paths: [
          join(directory, localBaseStringTableName),
          ...supplementaryStringTableNames(listed ?? []).map((name) => join(directory, name)),
        ],
      });
    }
    const stamps: Array<readonly [string, FileStamp | null]> = [];
    for (const relativePath of definitionFiles) {
      stamps.push([
        relativePath,
        await this.host.stat(join(installation.gamedataRoot, relativePath)),
      ]);
    }
    stamps.push(['dat', await this.host.stat(datPath)]);
    const palettePath = join(installation.installationRoot, localMinimapPaletteRelativePath);
    stamps.push(['palette', await this.host.stat(palettePath)]);
    for (const table of tables) {
      for (const [index, path] of table.paths.entries()) {
        const name =
          index === 0
            ? `strings[${table.language}]`
            : `strings[${table.language}]:${path.split(/[\\/]/u).at(-1)}`;
        stamps.push([name, await this.host.stat(path)]);
      }
    }
    const key = `${localPresentationCacheKey(
      installation.installationRoot,
      installation.productVersion,
      stamps,
    )}\u0000${installation.productVersionVerified ? 'verified' : 'unverified'}\u0000${requested}`;
    const cached = this.cache.get(requested);
    if (cached?.key === key) {
      this.cache.delete(requested);
      this.cache.set(requested, cached);
      return cached.value;
    }
    const pending = this.pending.get(key);
    if (pending) return pending;
    const value = this.build(installation, definitionFiles, stamps, datPath, tables, palettePath);
    const shared = value.then((built) => built.names);
    this.pending.set(key, shared);
    try {
      const built = await value;
      if (built.complete) {
        this.cache.delete(requested);
        this.cache.set(requested, { key, value: built.names });
        while (this.cache.size > maximumCachedLanguages) {
          this.cache.delete(this.cache.keys().next().value!);
        }
      }
      return built.names;
    } finally {
      if (this.pending.get(key) === shared) this.pending.delete(key);
    }
  }

  private async build(
    installation: LocalPresentationInstallation,
    definitionFiles: readonly string[],
    stamps: ReadonlyArray<readonly [string, FileStamp | null]>,
    datPath: string,
    tables: readonly StringTableSet[],
    palettePath: string,
  ): Promise<{ names: LocalPresentationNames; complete: boolean }> {
    let ids: PresentationStringIdsResult | undefined;
    let complete = true;
    try {
      ids = await this.host.readStringIds(datPath);
    } catch {
      ids = undefined;
      complete = false;
    }
    const membership = datMembership(ids);
    const constants = emptyConstantNameTable();
    let totalBytes = 0;
    for (const [index, relativePath] of definitionFiles.entries()) {
      if (!stamps[index]?.[1]) continue;
      const bytes = await this.host.readFile(
        join(installation.gamedataRoot, relativePath),
        localPresentationFileLimits.maximumDefinitionBytes,
      );
      if (!bytes) continue;
      totalBytes += bytes.byteLength;
      if (totalBytes > localPresentationFileLimits.maximumTotalDefinitionBytes) break;
      try {
        parseRmsConstantNames(bytes, constants, membership);
      } catch {}
    }
    let displayStrings: LocalDisplayStringStatus = 'unavailable';
    let objectText: Map<number, string> | undefined;
    let terrainText: Map<number, string> | undefined;
    if (ids?.status === 'unsupported-layout') displayStrings = 'unsupported-dat-layout';
    if (ids?.status === 'available') {
      const wanted = new Set<number>([
        ...ids.objects.map((entry) => entry.stringId),
        ...ids.terrains.map((entry) => entry.stringId),
      ]);
      const strings = new Map<number, string>();
      let baseRead = false;
      let stringBytes = 0;
      readTables: for (const table of tables) {
        if (baseRead && strings.size === wanted.size) break;
        let tableBaseRead = false;
        for (const [index, path] of table.paths.entries()) {
          if (index > 0 && (!tableBaseRead || strings.size === wanted.size)) break;
          const bytes = await this.host.readFile(
            path,
            localPresentationFileLimits.maximumStringTableBytes,
          );
          if (!bytes) continue;
          stringBytes += bytes.byteLength;
          if (stringBytes > localPresentationFileLimits.maximumTotalStringTableBytes) {
            break readTables;
          }
          try {
            const remaining = new Set([...wanted].filter((id) => !strings.has(id)));
            for (const [id, text] of parseKeyValueStrings(bytes, remaining)) strings.set(id, text);
            if (index === 0) {
              tableBaseRead = true;
              baseRead = true;
            }
          } catch {}
        }
      }
      if (baseRead) {
        const resolveText = (
          entries: PresentationStringIdsResult['objects'],
          maximumId: number,
        ): Map<number, string> => {
          const text = new Map<number, string>();
          for (const entry of entries) {
            const value = strings.get(entry.stringId);
            if (value && entry.id >= 0 && entry.id <= maximumId) text.set(entry.id, value);
          }
          return text;
        };
        objectText = resolveText(ids.objects, localPresentationNameLimits.maximumObjectId);
        terrainText = resolveText(ids.terrains, localPresentationNameLimits.maximumTerrainId);
        displayStrings = 'available';
      }
    }
    let terrainColors: TerrainMinimapColor[] = [];
    if (ids?.status === 'available' && (ids.terrainMinimapIndices?.length ?? 0) > 0) {
      const bytes = await this.host.readFile(palettePath, localMinimapPaletteLimits.maximumBytes);
      if (bytes) {
        try {
          terrainColors = resolveTerrainMinimapColors(
            ids.terrainMinimapIndices ?? [],
            parseJascPalette(bytes),
          );
        } catch {}
      }
    }
    const names = buildLocalPresentationNames({
      constants,
      productVersion: installation.productVersion,
      productVersionVerified: installation.productVersionVerified,
      displayStrings,
      ...(objectText ? { objectText } : {}),
      ...(terrainText ? { terrainText } : {}),
      graphiclessObjectIds:
        ids?.status === 'available'
          ? (ids.objectSlots ?? []).filter((slot) => !slot.standingGraphic).map((slot) => slot.id)
          : [],
      terrainColors,
    });
    return { names, complete };
  }
}

function isSafeRelativeInclude(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !path.startsWith('/') &&
    !path.startsWith('\\') &&
    !/^[a-z]:/iu.test(path) &&
    path.split(/[\\/]/u).every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}
