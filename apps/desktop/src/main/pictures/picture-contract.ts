import type { PreviewLook } from '../../shared/game-art';
import { PictureError } from './picture-error';
import { pictureFontSupports } from './picture-font';
import { validatePictureMap, type PictureMap } from './picture-map';

export { PictureError, type PictureErrorCode } from './picture-error';

export const pictureContract = Object.freeze({
  version: 1,
  minimumSide: 256,
  maximumSide: 1024,
  maximumMaps: 9,
  maximumCells: 9,
  maximumColumns: 9,
  maximumMarks: 256,
  maximumLines: 64,
  maximumCaptionLength: 24,
  maximumPngBytes: Math.floor(1.5 * 1024 * 1024),
  maximumAreaPixelsPerTile: 16,
  maximumBaseRadius: 60,
  maximumTexelsPerTile: 16,
  maximumTextureTexels: 2048 * 2048,
  maximumRequestTextureTexels: 2 * 2048 * 2048,
});

export type PictureLook = 'minimap' | 'texture-colors' | 'terrain-textures';
export const pictureLooks: readonly PictureLook[] = Object.freeze([
  'minimap',
  'texture-colors',
  'terrain-textures',
]);

export function isPictureLook(value: unknown): value is PictureLook {
  return value === 'minimap' || value === 'texture-colors' || value === 'terrain-textures';
}

export function pictureColourLook(look: PictureLook): 'minimap' | 'texture-colors' {
  return look === 'minimap' ? 'minimap' : 'texture-colors';
}

export function pictureLookForPreviewLook(look: PreviewLook): PictureLook {
  return look === 'minimap' || look === 'texture-colors' ? look : 'terrain-textures';
}

export interface PictureTerrainTexture {
  left: number;
  top: number;
  columns: number;
  rows: number;
  texelsPerTile: number;
  pixels: Uint8Array;
}

export type PicturePerspective = 'grid' | 'top_down' | 'diamond';
export const picturePerspectives: readonly PicturePerspective[] = Object.freeze([
  'grid',
  'top_down',
  'diamond',
]);

export type PictureObjects = 'markers' | 'minimap' | 'none';

export type PictureRelief = 'off' | 'shaded' | 'raised';

export type PictureRegion =
  | { kind: 'whole' }
  | { kind: 'tiles'; x: number; y: number; w: number; h: number }
  | { kind: 'base'; player: number; radius: number }
  | {
      kind: 'camera';
      centerX: number;
      centerY: number;
      zoom: number;
      viewportWidth: number;
      viewportHeight: number;
      padding?: number;
    };

export interface PictureCell {
  map: number;
  region: PictureRegion;
  look?: PictureLook;
  perspective?: PicturePerspective;
  caption?: string;
}

export interface PictureMark {
  map: number;
  x: number;
  y: number;
  kind: 'error' | 'warning';
}

export interface PictureLine {
  map: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  player?: number;
}

export interface PictureOverlays {
  grid?: boolean;
  players?: boolean;
  marks?: PictureMark[];
  lines?: PictureLine[];
}

export interface PictureRequest {
  contractVersion: typeof pictureContract.version;
  maps: PictureMap[];
  cells: PictureCell[];
  columns?: number;
  look: PictureLook;
  perspective: PicturePerspective;
  objects: PictureObjects;
  relief: PictureRelief;
  overlays?: PictureOverlays;
  maxSide: number;
  terrainTextures?: (PictureTerrainTexture | null)[];
}

export interface PictureCellLayout {
  map: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PictureResult {
  png: Uint8Array;
  width: number;
  height: number;
  pixelsPerTile: number;
  description: string;
  cells: PictureCellLayout[];
}

function fail(message: string): never {
  throw new PictureError('invalid-request', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integerIn(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function finiteIn(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum
  );
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${what} has an unknown field ${key}`);
  }
}

function validateRegion(value: unknown, map: PictureMap): PictureRegion {
  if (!isRecord(value)) fail('a cell region is missing');
  switch (value.kind) {
    case 'whole':
      onlyKeys(value, ['kind'], 'a whole region');
      return { kind: 'whole' };
    case 'tiles': {
      onlyKeys(value, ['kind', 'x', 'y', 'w', 'h'], 'a tile region');
      const { x, y, w, h } = value;
      if (
        !integerIn(x, 0, map.width - 1) ||
        !integerIn(y, 0, map.height - 1) ||
        !integerIn(w, 1, 480) ||
        !integerIn(h, 1, 480)
      ) {
        fail('a tile region lies outside the map');
      }
      return { kind: 'tiles', x, y, w: Math.min(w, map.width - x), h: Math.min(h, map.height - y) };
    }
    case 'base': {
      onlyKeys(value, ['kind', 'player', 'radius'], 'a base region');
      const { player, radius } = value;
      if (!integerIn(player, 1, 8)) fail('a base region names no player 1-8');
      if (!integerIn(radius, 1, pictureContract.maximumBaseRadius)) {
        fail(`a base radius must be 1-${pictureContract.maximumBaseRadius} tiles`);
      }
      if (!map.players.some((entry) => entry.owner === player)) {
        fail(`player ${player} has no start on this map`);
      }
      return { kind: 'base', player, radius };
    }
    case 'camera': {
      onlyKeys(
        value,
        ['kind', 'centerX', 'centerY', 'zoom', 'viewportWidth', 'viewportHeight', 'padding'],
        'a camera region',
      );
      const { centerX, centerY, zoom, viewportWidth, viewportHeight, padding } = value;
      if (
        !finiteIn(centerX, -map.width, 2 * map.width) ||
        !finiteIn(centerY, -map.height, 2 * map.height) ||
        !finiteIn(zoom, 0.05, 64) ||
        !finiteIn(viewportWidth, 16, 16_384) ||
        !finiteIn(viewportHeight, 16, 16_384) ||
        (padding !== undefined && !finiteIn(padding, 0, 1024))
      ) {
        fail('a camera region is out of range');
      }
      return {
        kind: 'camera',
        centerX,
        centerY,
        zoom,
        viewportWidth,
        viewportHeight,
        ...(padding === undefined ? {} : { padding }),
      };
    }
    default:
      return fail('a cell region kind is unknown');
  }
}

function validateCaption(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    value.length > pictureContract.maximumCaptionLength ||
    !pictureFontSupports(value)
  ) {
    fail('a caption uses characters the picture font does not draw');
  }
  return value;
}

function validateTerrainTexture(value: unknown, map: PictureMap): PictureTerrainTexture {
  if (!isRecord(value)) fail('a terrain texture is not an object');
  onlyKeys(
    value,
    ['left', 'top', 'columns', 'rows', 'texelsPerTile', 'pixels'],
    'a terrain texture',
  );
  const { left, top, columns, rows, texelsPerTile, pixels } = value;
  if (
    !integerIn(left, 0, map.width - 1) ||
    !integerIn(top, 0, map.height - 1) ||
    !integerIn(columns, 1, map.width - left) ||
    !integerIn(rows, 1, map.height - top)
  ) {
    fail('a terrain texture lies outside its map');
  }
  if (!integerIn(texelsPerTile, 1, pictureContract.maximumTexelsPerTile)) {
    fail(`a terrain texture must have 1-${pictureContract.maximumTexelsPerTile} texels per tile`);
  }
  const texels = columns * texelsPerTile * rows * texelsPerTile;
  if (texels > pictureContract.maximumTextureTexels) fail('a terrain texture is too large');
  if (!(pixels instanceof Uint8Array) || pixels.length !== texels * 4) {
    fail('a terrain texture has the wrong number of pixels');
  }
  return { left, top, columns, rows, texelsPerTile, pixels };
}

function validatePoint(value: unknown, map: PictureMap): { x: number; y: number } {
  if (!isRecord(value) || !finiteIn(value.x, 0, map.width) || !finiteIn(value.y, 0, map.height)) {
    fail('a line point lies outside its map');
  }
  return { x: value.x, y: value.y };
}

export function validatePictureRequest(value: unknown): PictureRequest {
  if (!isRecord(value)) fail('the picture request is not an object');
  if (value.contractVersion !== pictureContract.version) {
    throw new PictureError(
      'unsupported-version',
      `picture contract ${String(value.contractVersion)} is not supported`,
    );
  }
  onlyKeys(
    value,
    [
      'contractVersion',
      'maps',
      'cells',
      'columns',
      'look',
      'perspective',
      'objects',
      'relief',
      'overlays',
      'maxSide',
      'terrainTextures',
    ],
    'the picture request',
  );
  if (!isPictureLook(value.look)) {
    fail('the look must be minimap, texture-colors or terrain-textures');
  }
  if (!picturePerspectives.includes(value.perspective as PicturePerspective)) {
    fail('the perspective is unknown');
  }
  if (value.objects !== 'markers' && value.objects !== 'minimap' && value.objects !== 'none') {
    fail('the objects mode is unknown');
  }
  if (value.relief !== 'off' && value.relief !== 'shaded' && value.relief !== 'raised') {
    fail('the relief mode is unknown');
  }
  if (!integerIn(value.maxSide, pictureContract.minimumSide, pictureContract.maximumSide)) {
    throw new PictureError(
      'invalid-request',
      `the picture size must be ${pictureContract.minimumSide}-${pictureContract.maximumSide} pixels`,
    );
  }
  if (
    !Array.isArray(value.maps) ||
    value.maps.length < 1 ||
    value.maps.length > pictureContract.maximumMaps
  ) {
    fail(`a picture needs 1-${pictureContract.maximumMaps} maps`);
  }
  const maps = value.maps.map((map) => validatePictureMap(map));
  if (
    !Array.isArray(value.cells) ||
    value.cells.length < 1 ||
    value.cells.length > pictureContract.maximumCells
  ) {
    fail(`a picture needs 1-${pictureContract.maximumCells} cells`);
  }
  const cells = value.cells.map((cell): PictureCell => {
    if (!isRecord(cell)) fail('a cell is not an object');
    onlyKeys(cell, ['map', 'region', 'look', 'perspective', 'caption'], 'a cell');
    if (!integerIn(cell.map, 0, maps.length - 1)) fail('a cell names a map the request lacks');
    if (cell.look !== undefined && !isPictureLook(cell.look)) {
      fail('a cell look must be minimap, texture-colors or terrain-textures');
    }
    if (
      cell.perspective !== undefined &&
      !picturePerspectives.includes(cell.perspective as PicturePerspective)
    ) {
      fail('a cell perspective is unknown');
    }
    const caption = validateCaption(cell.caption);
    return {
      map: cell.map,
      region: validateRegion(cell.region, maps[cell.map]!),
      ...(cell.look === undefined ? {} : { look: cell.look }),
      ...(cell.perspective === undefined
        ? {}
        : { perspective: cell.perspective as PicturePerspective }),
      ...(caption === undefined ? {} : { caption }),
    };
  });
  if (
    value.columns !== undefined &&
    !integerIn(value.columns, 1, Math.min(pictureContract.maximumColumns, cells.length))
  ) {
    fail('the column count must be 1 to the number of cells');
  }
  let overlays: PictureOverlays | undefined;
  if (value.overlays !== undefined) {
    if (!isRecord(value.overlays)) fail('the overlays are not an object');
    onlyKeys(value.overlays, ['grid', 'players', 'marks', 'lines'], 'the overlays');
    const { grid, players, marks, lines } = value.overlays;
    if (grid !== undefined && typeof grid !== 'boolean') fail('the grid overlay is not a boolean');
    if (players !== undefined && typeof players !== 'boolean') {
      fail('the players overlay is not a boolean');
    }
    if (
      marks !== undefined &&
      (!Array.isArray(marks) || marks.length > pictureContract.maximumMarks)
    ) {
      fail(`at most ${pictureContract.maximumMarks} marks fit one picture`);
    }
    if (
      lines !== undefined &&
      (!Array.isArray(lines) || lines.length > pictureContract.maximumLines)
    ) {
      fail(`at most ${pictureContract.maximumLines} lines fit one picture`);
    }
    overlays = {
      ...(grid === undefined ? {} : { grid }),
      ...(players === undefined ? {} : { players }),
      ...(marks === undefined
        ? {}
        : {
            marks: (marks as unknown[]).map((mark): PictureMark => {
              if (!isRecord(mark)) fail('a mark is not an object');
              onlyKeys(mark, ['map', 'x', 'y', 'kind'], 'a mark');
              if (!integerIn(mark.map, 0, maps.length - 1)) fail('a mark names no map');
              const map = maps[mark.map]!;
              if (!finiteIn(mark.x, 0, map.width) || !finiteIn(mark.y, 0, map.height)) {
                fail('a mark lies outside its map');
              }
              if (mark.kind !== 'error' && mark.kind !== 'warning') fail('a mark kind is unknown');
              return { map: mark.map, x: mark.x, y: mark.y, kind: mark.kind };
            }),
          }),
      ...(lines === undefined
        ? {}
        : {
            lines: (lines as unknown[]).map((line): PictureLine => {
              if (!isRecord(line)) fail('a line is not an object');
              onlyKeys(line, ['map', 'from', 'to', 'player'], 'a line');
              if (!integerIn(line.map, 0, maps.length - 1)) fail('a line names no map');
              const map = maps[line.map]!;
              if (line.player !== undefined && !integerIn(line.player, 1, 8)) {
                fail('a line player must be 1-8');
              }
              return {
                map: line.map,
                from: validatePoint(line.from, map),
                to: validatePoint(line.to, map),
                ...(line.player === undefined ? {} : { player: line.player }),
              };
            }),
          }),
    };
  }
  let terrainTextures: (PictureTerrainTexture | null)[] | undefined;
  if (value.terrainTextures !== undefined) {
    if (!Array.isArray(value.terrainTextures) || value.terrainTextures.length !== maps.length) {
      fail('the terrain textures must name one entry per map');
    }
    terrainTextures = value.terrainTextures.map((texture: unknown, index) =>
      texture === null ? null : validateTerrainTexture(texture, maps[index]!),
    );
    let total = 0;
    for (const texture of terrainTextures) {
      if (texture) total += texture.columns * texture.rows * texture.texelsPerTile ** 2;
    }
    if (total > pictureContract.maximumRequestTextureTexels) {
      fail('the terrain textures are too large together');
    }
  }
  for (const cell of cells) {
    if ((cell.look ?? value.look) === 'terrain-textures' && !terrainTextures?.[cell.map]) {
      fail('a terrain-textures cell has no terrain texture for its map');
    }
  }
  return {
    contractVersion: pictureContract.version,
    maps,
    cells,
    ...(value.columns === undefined ? {} : { columns: value.columns }),
    look: value.look,
    perspective: value.perspective as PicturePerspective,
    objects: value.objects,
    relief: value.relief,
    ...(overlays === undefined ? {} : { overlays }),
    maxSide: value.maxSide,
    ...(terrainTextures === undefined ? {} : { terrainTextures }),
  };
}
