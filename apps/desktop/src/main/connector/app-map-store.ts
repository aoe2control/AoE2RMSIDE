import type { PreviewGenerationResult } from '../../shared/api';
import { knownCrashReference } from '../../shared/known-crashes';
import type { XsStartOutcome } from '../../shared/xs-start';

export const appMapStoreCapacity = 6;
const townCenterObjectId = 109;

export interface CompactMapObjects {
  count: number;
  ids: Uint32Array;
  x: Float32Array;
  y: Float32Array;
  owners: Uint8Array;
  resourceTypes: Int16Array;
  amounts: Float32Array;
  operations: Int32Array;
}

export interface CompactOperation {
  file: string | null;
  line: number | null;
  cmd: string;
}

export interface CompactPlayer {
  p: number;
  team: number;
  start: [number, number] | null;
}

export interface CompactWarning {
  code: string;
  message: string;
  crash?: string;
}

export interface CompactMap {
  id: string;
  path: string | null;
  name: string;
  seed: number;
  settings: string;
  timeS: number;
  width: number;
  height: number;
  terrain: Uint32Array;
  elevation: Int16Array;
  cliffs: Uint16Array;
  objects: CompactMapObjects;
  classes: ReadonlyMap<number, number>;
  objectNames: ReadonlyMap<number, string>;
  terrainNames: ReadonlyMap<number, string>;
  players: CompactPlayer[];
  operations: CompactOperation[];
  warnings: CompactWarning[];
  xs: XsStartOutcome | null;
  knownCrash: string | null;
  picture?: unknown;
}

export interface CompactMapFacts {
  id: string;
  path: string | null;
  name: string;
  seed: number;
  settings: string;
  timeS: number;
  teams: readonly number[];
}

export interface CompactSource {
  file: string | null;
  text: string | null;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u32Column(bytes: Uint8Array, count: number, label: string): Uint32Array {
  if (bytes.byteLength !== count * 4) throw new Error(`${label} column has an invalid length`);
  const data = view(bytes);
  const values = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) values[index] = data.getUint32(index * 4, true);
  return values;
}

function i16Column(bytes: Uint8Array, count: number, label: string): Int16Array {
  if (bytes.byteLength !== count * 2) throw new Error(`${label} column has an invalid length`);
  const data = view(bytes);
  const values = new Int16Array(count);
  for (let index = 0; index < count; index += 1) values[index] = data.getInt16(index * 2, true);
  return values;
}

function lineStarts(text: string): number[] {
  const bytes = Buffer.from(text, 'utf8');
  const starts = [0];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts: readonly number[], byte: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= byte) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function commandText(bytes: Buffer | null, start: number, end: number, fallback: string): string {
  if (!bytes || start < 0 || end <= start || start >= bytes.length) return fallback;
  const slice = bytes.subarray(start, Math.min(end, start + 160)).toString('utf8');
  const firstLine = slice.split(/\r?\n/u)[0]!.replace(/\s+/gu, ' ').trim();
  if (!firstLine) return fallback;
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
}

function compactOperations(
  result: PreviewGenerationResult,
  source: (sourceId: string) => CompactSource,
): CompactOperation[] {
  const sources = new Map<
    string,
    { file: string | null; starts: number[] | null; bytes: Buffer | null }
  >();
  return result.provenanceOperations.map((operation) => {
    let described = sources.get(operation.sourceId);
    if (!described) {
      const found = source(operation.sourceId);
      described = {
        file: found.file,
        starts: found.text === null ? null : lineStarts(found.text),
        bytes: found.text === null ? null : Buffer.from(found.text, 'utf8'),
      };
      sources.set(operation.sourceId, described);
    }
    return {
      file: described.file,
      line: described.starts ? lineAt(described.starts, operation.byteStart) : null,
      cmd: commandText(
        described.bytes,
        operation.byteStart,
        operation.byteEnd,
        operation.displayName.slice(0, 60),
      ),
    };
  });
}

function players(objects: CompactMapObjects, teams: readonly number[]): CompactPlayer[] {
  return teams.map((team, index) => {
    const owner = index + 1;
    let sumX = 0;
    let sumY = 0;
    let owned = 0;
    for (let object = 0; object < objects.count; object += 1) {
      if (objects.owners[object] !== owner) continue;
      if (objects.ids[object] === townCenterObjectId) {
        return { p: owner, team, start: [objects.x[object]!, objects.y[object]!] };
      }
      sumX += objects.x[object]!;
      sumY += objects.y[object]!;
      owned += 1;
    }
    return { p: owner, team, start: owned > 0 ? [sumX / owned, sumY / owned] : null };
  });
}

export function compactMapFromResult(
  result: PreviewGenerationResult,
  facts: CompactMapFacts,
  source: (sourceId: string) => CompactSource,
): CompactMap {
  const tiles = result.width * result.height;
  if (!Number.isSafeInteger(tiles) || tiles < 1 || tiles > 512 * 512) {
    throw new Error('the map dimensions are invalid');
  }
  const count = result.objects.owners.byteLength;
  const quantities = u32Column(result.objects.resourceQuantityF32BitsLe, count, 'resource');
  const amounts = new Float32Array(new Uint32Array(quantities).buffer);
  const positionsX = u32Column(result.objects.xLe, count, 'object x');
  const positionsY = u32Column(result.objects.yLe, count, 'object y');
  const operationIndices = u32Column(result.objectOperationIndicesLe, count, 'object operation');
  const operations = compactOperations(result, source);
  const objects: CompactMapObjects = {
    count,
    ids: u32Column(result.objects.idsLe, count, 'object id'),
    x: Float32Array.from(positionsX, (value) => value / 256),
    y: Float32Array.from(positionsY, (value) => value / 256),
    owners: new Uint8Array(result.objects.owners),
    resourceTypes: i16Column(result.objects.resourceTypeLe, count, 'resource type'),
    amounts,
    operations: Int32Array.from(operationIndices, (value) =>
      value === 0xffff_ffff || value >= operations.length ? -1 : value,
    ),
  };
  if (result.cliffEdges.byteLength % 12 !== 0)
    throw new Error('cliff column has an invalid length');
  const cliffData = view(result.cliffEdges);
  const cliffs = new Uint16Array((result.cliffEdges.byteLength / 12) * 4);
  for (let segment = 0; segment * 12 < result.cliffEdges.byteLength; segment += 1) {
    for (let part = 0; part < 4; part += 1) {
      cliffs[segment * 4 + part] = cliffData.getUint16(segment * 12 + part * 2, true);
    }
  }
  const objectNames = new Map<number, string>();
  for (const entry of result.objectNames) objectNames.set(entry.objectId, entry.name);
  for (const entry of result.constantNames?.objects ?? [])
    objectNames.set(entry.objectId, entry.name);
  const terrainNames = new Map<number, string>();
  for (const entry of result.terrainNames) terrainNames.set(entry.terrainId, entry.name);
  for (const entry of result.constantNames?.terrains ?? []) {
    terrainNames.set(entry.terrainId, entry.name);
  }
  const warnings: CompactWarning[] = result.warnings.map((warning) => {
    const crash = knownCrashReference(warning.knownCrash);
    return {
      code: warning.code,
      message: warning.message,
      ...(crash ? { crash: crash.crashId } : {}),
    };
  });
  return {
    id: facts.id,
    path: facts.path,
    name: facts.name,
    seed: facts.seed,
    settings: facts.settings,
    timeS: facts.timeS,
    width: result.width,
    height: result.height,
    terrain: u32Column(result.terrainIdsLe, tiles, 'terrain'),
    elevation: i16Column(result.elevations, tiles, 'elevation'),
    cliffs,
    objects,
    classes: new Map((result.objectClasses ?? []).map((entry) => [entry.objectId, entry.classId])),
    objectNames,
    terrainNames,
    players: players(objects, facts.teams),
    operations,
    warnings,
    xs: result.xsStart ?? null,
    knownCrash: warnings.find((warning) => warning.crash)?.crash ?? null,
  };
}

export class AppMapStore {
  private readonly maps = new Map<string, CompactMap>();
  private sheet = new Map<string, CompactMap>();
  private counter = 0;
  private latestId: string | undefined;

  constructor(private readonly capacity = appMapStoreCapacity) {}

  putSheet(maps: readonly CompactMap[]): void {
    this.sheet = new Map(maps.slice(0, 9).map((map) => [map.id, map]));
  }

  nextId(): string {
    this.counter = this.counter >= 999_999 ? 1 : this.counter + 1;
    return `m${this.counter}`;
  }

  put(map: CompactMap): void {
    this.maps.delete(map.id);
    this.maps.set(map.id, map);
    this.latestId = map.id;
    while (this.maps.size > this.capacity) {
      this.maps.delete(this.maps.keys().next().value!);
    }
  }

  get(id: string): CompactMap | undefined {
    const map = this.maps.get(id);
    if (!map) return this.sheet.get(id);
    this.maps.delete(id);
    this.maps.set(id, map);
    return map;
  }

  latest(): CompactMap | undefined {
    return this.latestId ? this.maps.get(this.latestId) : undefined;
  }

  ids(): string[] {
    return [...this.maps.keys(), ...this.sheet.keys()];
  }

  get size(): number {
    return this.maps.size;
  }
}
