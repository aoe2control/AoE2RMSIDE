import type {
  MapIconArtObjectDescriptor,
  PreviewBackend,
  PreviewGenerationResult,
  SelectedMinimapPalette,
  TerrainNameDescriptor,
  TexturePaletteDescriptor,
} from '../../shared/api';
import { isTexturePaletteDescriptor } from '../../shared/texture-palette';
import { previewHelperObjectIds } from '../../renderer/preview-materials';
import { decodeTopDownScene, type TopDownScene } from '../../renderer/top-down-preview';
import { PictureError } from './picture-error';

export const pictureMapFormat = 1;
export const pictureMapLimits = Object.freeze({
  maximumDimension: 480,
  maximumObjects: 1_000_000,
  maximumCliffs: 4 * 480 * 480,
  maximumPaletteEntries: 65_536,
});

export interface PicturePlayer {
  owner: number;
  colorId: number;
  x: number;
  y: number;
  source: 'town-center' | 'centroid';
}

export interface PictureMapObjects {
  ids: Uint32Array;
  x: Float32Array;
  y: Float32Array;
  owners: Uint8Array;
  classes: Int16Array;
  footprintWidths: Float32Array;
  footprintHeights: Float32Array;
  walls: Uint8Array;
  resourceTypes: Int16Array;
  trees: Uint8Array;
}

export interface PictureMap {
  format: typeof pictureMapFormat;
  width: number;
  height: number;
  backend: PreviewBackend;
  terrainIds: Uint16Array;
  layerIds?: Uint16Array;
  elevations: Int16Array;
  cliffs: { points: Float32Array; types: Uint32Array };
  objects: PictureMapObjects;
  players: PicturePlayer[];
  playerColorIds: number[];
  minimapPalette: SelectedMinimapPalette | null;
  texturePalette: TexturePaletteDescriptor | null;
  terrainNames: TerrainNameDescriptor[];
  artObjects: MapIconArtObjectDescriptor[];
  helperObjectIds: number[];
}

const townCenterObjectId = 109;

export function pictureMapFromPreviewResult(result: PreviewGenerationResult): PictureMap {
  let scene: TopDownScene;
  try {
    scene = decodeTopDownScene(result, { appearances: true });
  } catch (error) {
    throw new PictureError(
      'invalid-map',
      `the map cannot be decoded: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  if (
    scene.width > pictureMapLimits.maximumDimension ||
    scene.height > pictureMapLimits.maximumDimension
  ) {
    throw new PictureError('invalid-map', 'the map is larger than 480 tiles per edge');
  }
  const objects = scene.objects.filter((object) => object.appearance !== 'decoration');
  if (objects.length > pictureMapLimits.maximumObjects) {
    throw new PictureError('invalid-map', 'the map has more objects than a picture draws');
  }
  const count = objects.length;
  const columns: PictureMapObjects = {
    ids: new Uint32Array(count),
    x: new Float32Array(count),
    y: new Float32Array(count),
    owners: new Uint8Array(count),
    classes: new Int16Array(count),
    footprintWidths: new Float32Array(count),
    footprintHeights: new Float32Array(count),
    walls: new Uint8Array(count),
    resourceTypes: new Int16Array(count),
    trees: new Uint8Array(count),
  };
  objects.forEach((object, index) => {
    columns.ids[index] = object.objectId;
    columns.x[index] = object.x;
    columns.y[index] = object.y;
    columns.owners[index] = Math.max(0, Math.min(255, object.owner));
    columns.classes[index] = object.objectClass ?? -1;
    columns.footprintWidths[index] = object.footprintWidth;
    columns.footprintHeights[index] = object.footprintHeight;
    columns.walls[index] = object.presentationKind === 'wall' ? 1 : 0;
    columns.resourceTypes[index] = object.resourceType;
    columns.trees[index] = object.appearance === 'tree' ? 1 : 0;
  });
  const points = new Float32Array(scene.cliffs.length * 4);
  const types = new Uint32Array(scene.cliffs.length);
  scene.cliffs.forEach((cliff, index) => {
    points.set([cliff.from.x, cliff.from.y, cliff.to.x, cliff.to.y], index * 4);
    types[index] = cliff.cliffType;
  });
  const texturePalette = result.texturePalette ?? null;
  return {
    format: pictureMapFormat,
    width: scene.width,
    height: scene.height,
    backend: result.backend,
    terrainIds: Uint16Array.from(scene.terrainIds, (id) => Math.min(0xffff, Math.max(0, id))),
    layerIds: Uint16Array.from(scene.layerIds, (id) => Math.min(0xffff, Math.max(0, id))),
    elevations: Int16Array.from(scene.elevations),
    cliffs: { points, types },
    objects: columns,
    players: picturePlayers(columns, result.playerColorIds),
    playerColorIds: [...result.playerColorIds],
    minimapPalette: result.minimapPalette,
    texturePalette:
      texturePalette && isTexturePaletteDescriptor(texturePalette) ? texturePalette : null,
    terrainNames: result.terrainNames,
    artObjects: result.mapIconArtObjects ?? [],
    helperObjectIds: [...previewHelperObjectIds(result, null)].sort((a, b) => a - b),
  };
}

export function picturePlayers(
  objects: Pick<PictureMapObjects, 'ids' | 'x' | 'y' | 'owners'>,
  playerColorIds: readonly number[],
): PicturePlayer[] {
  const townCenters = new Map<number, { x: number; y: number }>();
  const sums = new Map<number, { x: number; y: number; count: number }>();
  for (let index = 0; index < objects.owners.length; index += 1) {
    const owner = objects.owners[index]!;
    if (owner < 1 || owner > 8) continue;
    const x = objects.x[index]!;
    const y = objects.y[index]!;
    if (objects.ids[index] === townCenterObjectId && !townCenters.has(owner)) {
      townCenters.set(owner, { x, y });
    }
    const sum = sums.get(owner) ?? { x: 0, y: 0, count: 0 };
    sum.x += x;
    sum.y += y;
    sum.count += 1;
    sums.set(owner, sum);
  }
  const players: PicturePlayer[] = [];
  for (let owner = 1; owner <= 8; owner += 1) {
    const colorId = playerColorIds[owner];
    if (colorId === undefined || !Number.isInteger(colorId) || colorId < 0) continue;
    const townCenter = townCenters.get(owner);
    if (townCenter) {
      players.push({ owner, colorId, ...townCenter, source: 'town-center' });
      continue;
    }
    const sum = sums.get(owner);
    if (sum) {
      players.push({
        owner,
        colorId,
        x: sum.x / sum.count,
        y: sum.y / sum.count,
        source: 'centroid',
      });
    }
  }
  return players;
}

function bad(message: string): never {
  throw new PictureError('invalid-map', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typed<T extends ArrayBufferView>(
  value: unknown,
  type: new (length: number) => T,
  length: number,
  what: string,
): T {
  if (!(value instanceof type) || (value as unknown as { length: number }).length !== length) {
    bad(`${what} has an invalid type or length`);
  }
  return value as T;
}

function validColorEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length <= pictureMapLimits.maximumPaletteEntries;
}

export function validatePictureMap(value: unknown): PictureMap {
  if (!isRecord(value)) bad('a picture map is not an object');
  if (value.format !== pictureMapFormat)
    bad(`picture map format ${String(value.format)} is not supported`);
  const { width, height } = value;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    (width as number) < 1 ||
    (height as number) < 1 ||
    (width as number) > pictureMapLimits.maximumDimension ||
    (height as number) > pictureMapLimits.maximumDimension
  ) {
    bad('a picture map must be 1-480 tiles per edge');
  }
  const tiles = (width as number) * (height as number);
  if (value.backend !== 'exact' && value.backend !== 'synthetic') bad('the map backend is unknown');
  typed(value.terrainIds, Uint16Array, tiles, 'terrain ids');
  if (value.layerIds !== undefined) typed(value.layerIds, Uint16Array, tiles, 'layer ids');
  typed(value.elevations, Int16Array, tiles, 'elevations');
  if (!isRecord(value.cliffs)) bad('cliffs are missing');
  const cliffTypes = value.cliffs.types;
  if (!(cliffTypes instanceof Uint32Array) || cliffTypes.length > pictureMapLimits.maximumCliffs) {
    bad('cliff types have an invalid type or length');
  }
  typed(value.cliffs.points, Float32Array, cliffTypes.length * 4, 'cliff points');
  if (!isRecord(value.objects)) bad('objects are missing');
  const objects = value.objects;
  if (
    !(objects.ids instanceof Uint32Array) ||
    objects.ids.length > pictureMapLimits.maximumObjects
  ) {
    bad('object ids have an invalid type or length');
  }
  const count = objects.ids.length;
  typed(objects.x, Float32Array, count, 'object x');
  typed(objects.y, Float32Array, count, 'object y');
  typed(objects.owners, Uint8Array, count, 'object owners');
  typed(objects.classes, Int16Array, count, 'object classes');
  typed(objects.footprintWidths, Float32Array, count, 'object footprint widths');
  typed(objects.footprintHeights, Float32Array, count, 'object footprint heights');
  typed(objects.walls, Uint8Array, count, 'object wall flags');
  typed(objects.resourceTypes, Int16Array, count, 'object resource types');
  typed(objects.trees, Uint8Array, count, 'object tree flags');
  if (!Array.isArray(value.players) || value.players.length > 8) bad('players are invalid');
  const owners = new Set<number>();
  for (const player of value.players as unknown[]) {
    if (
      !isRecord(player) ||
      !Number.isInteger(player.owner) ||
      (player.owner as number) < 1 ||
      (player.owner as number) > 8 ||
      owners.has(player.owner as number) ||
      !Number.isInteger(player.colorId) ||
      typeof player.x !== 'number' ||
      typeof player.y !== 'number' ||
      !Number.isFinite(player.x) ||
      !Number.isFinite(player.y) ||
      (player.source !== 'town-center' && player.source !== 'centroid')
    ) {
      bad('a player start is invalid');
    }
    owners.add(player.owner as number);
  }
  if (
    !Array.isArray(value.playerColorIds) ||
    value.playerColorIds.length > 256 ||
    !value.playerColorIds.every((id) => Number.isInteger(id))
  ) {
    bad('player color ids are invalid');
  }
  if (value.minimapPalette !== null) {
    const palette = value.minimapPalette;
    if (
      !isRecord(palette) ||
      !validColorEntries(palette.terrainColors) ||
      !validColorEntries(palette.neutralObjectColors) ||
      !validColorEntries(palette.cliffColors)
    ) {
      bad('the minimap palette is invalid');
    }
  }
  if (value.texturePalette !== null && !isTexturePaletteDescriptor(value.texturePalette)) {
    bad('the texture palette is invalid');
  }
  for (const [list, what] of [
    [value.terrainNames, 'terrain names'],
    [value.artObjects, 'art objects'],
    [value.helperObjectIds, 'helper object ids'],
  ] as const) {
    if (!Array.isArray(list) || list.length > pictureMapLimits.maximumPaletteEntries) {
      bad(`${what} are invalid`);
    }
  }
  return value as unknown as PictureMap;
}
