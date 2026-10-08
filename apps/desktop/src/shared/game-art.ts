import { t, type MessageId } from './i18n/translator';

export type PreviewPerspective = 'top-down' | 'diamond';
export type PreviewLook = 'minimap' | 'texture-colors' | 'game-textures';

export const previewPerspectives: readonly PreviewPerspective[] = ['top-down', 'diamond'];
export const previewLooks: readonly PreviewLook[] = ['minimap', 'texture-colors', 'game-textures'];

export function isPreviewPerspective(value: unknown): value is PreviewPerspective {
  return value === 'top-down' || value === 'diamond';
}

export function isPreviewLook(value: unknown): value is PreviewLook {
  return value === 'minimap' || value === 'texture-colors' || value === 'game-textures';
}

export function previewLookUsesGameArt(look: PreviewLook): boolean {
  return look === 'game-textures';
}

export function nextPreviewLook(look: PreviewLook, gameArtOffered: boolean): PreviewLook {
  if (look === 'minimap') return 'texture-colors';
  if (look === 'texture-colors' && gameArtOffered) return 'game-textures';
  return 'minimap';
}

export function shownPreviewLook(look: PreviewLook, gameArtOffered: boolean): PreviewLook {
  return look === 'game-textures' && !gameArtOffered ? 'texture-colors' : look;
}

export function flatPreviewLook(
  shownLook: PreviewLook,
  gameTexturesExpected: boolean,
): PreviewLook {
  return shownLook === 'game-textures' && !gameTexturesExpected ? 'texture-colors' : shownLook;
}

export type GameArtPhase = 'catalog' | 'terrain' | 'blends' | 'masks' | 'sprites';

export type GameArtStatus =
  | { state: 'unlinked' }
  | { state: 'idle' }
  | { state: 'preparing'; phase: GameArtPhase | null; completed: number; total: number }
  | {
      state: 'ready';
      revision: number;
      fallbackCount: number;
      sprites?: { completed: number; total: number };
    }
  | { state: 'failed'; reason: string }
  | { state: 'unavailable'; reason: string };

export interface GameArtConversionProgress {
  fraction: number;
  what: 'terrain' | 'sprites';
  phase: GameArtPhase;
  completed: number;
  total: number;
}

export function gameArtConversionProgress(status: GameArtStatus): GameArtConversionProgress | null {
  if (status.state === 'preparing') {
    const total = status.phase === 'catalog' || status.phase === null ? 0 : status.total;
    return {
      fraction: total > 0 ? Math.min(1, status.completed / total) : 0,
      what: 'terrain',
      phase: status.phase ?? 'catalog',
      completed: total > 0 ? status.completed : 0,
      total,
    };
  }
  if (status.state === 'ready' && status.sprites && status.sprites.total > minimumSpriteBatch) {
    const { completed, total } = status.sprites;
    return {
      fraction: Math.min(1, completed / total),
      what: 'sprites',
      phase: 'sprites',
      completed,
      total,
    };
  }
  return null;
}

const gameArtProgressActions: Record<
  GameArtPhase,
  { action: MessageId; detail: MessageId; counted: MessageId }
> = {
  catalog: {
    action: 'game-art.progress.catalog.action',
    detail: 'game-art.progress.catalog.detail',
    counted: 'game-art.progress.catalog.detail-counted',
  },
  terrain: {
    action: 'game-art.progress.terrain.action',
    detail: 'game-art.progress.terrain.detail',
    counted: 'game-art.progress.terrain.detail-counted',
  },
  blends: {
    action: 'game-art.progress.blends.action',
    detail: 'game-art.progress.blends.detail',
    counted: 'game-art.progress.blends.detail-counted',
  },
  masks: {
    action: 'game-art.progress.masks.action',
    detail: 'game-art.progress.masks.detail',
    counted: 'game-art.progress.masks.detail-counted',
  },
  sprites: {
    action: 'game-art.progress.sprites.action',
    detail: 'game-art.progress.sprites.detail',
    counted: 'game-art.progress.sprites.detail-counted',
  },
};

export function gameArtProgressAction(progress: GameArtConversionProgress): string {
  return t(gameArtProgressActions[progress.phase].action);
}

export function gameArtProgressDetail(progress: GameArtConversionProgress): string {
  const words = gameArtProgressActions[progress.phase];
  if (progress.total <= 0) return t(words.detail);
  return t(words.counted, {
    percent: Math.round(progress.fraction * 100),
    completed: progress.completed,
    total: progress.total,
    unit: progress.what === 'sprites' ? 'graphics' : 'files',
  });
}

export const minimumSpriteBatch = 8;

export function gameArtLookOffered(status: GameArtStatus): boolean {
  return status.state !== 'unlinked' && status.state !== 'unavailable';
}

export const gameArtTextureRepeatTiles = 10;
export const gameArtBlendAtlasCount = 9;
export const maximumGameArtTerrains = 256;
export const maximumGameArtSpriteObjects = 4096;
export const maximumGameArtSpriteGraphics = 4096;
export const maximumGameArtFacings = 64;
export const maximumGameArtImagesPerRequest = 64;
export const maximumGameArtImageBytes = 8 * 1024 * 1024;
export const maximumGameArtImageRequestBytes = 48 * 1024 * 1024;
export const maximumGameArtReasonLength = 1024;

export interface GameArtTerrain {
  id: number;
  texture: string | null;
  blendPriority: number;
  blendType: number;
  overlayMask: string | null;
  waterClass: number;
}

export interface GameArtTerrainIndex {
  revision: number;
  source?: string;
  textureRepeatTiles: number;
  terrains: GameArtTerrain[];
  blends: (string | null)[];
  playerColors?: GameArtTeamColors;
}

export interface GameArtTeamColor {
  red: number;
  green: number;
  blue: number;
  pivot: number;
}

export interface GameArtTeamColors {
  gaia: GameArtTeamColor | null;
  players: (GameArtTeamColor | null)[];
}

export const gameArtPlayerColorCount = 8;

function validateTeamColor(value: unknown): GameArtTeamColor | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error('game art team colour is invalid');
  const channels = [value.red, value.green, value.blue, value.pivot];
  if (!channels.every((channel) => typeof channel === 'number' && channel >= 0 && channel <= 1)) {
    throw new Error('game art team colour is invalid');
  }
  return {
    red: value.red as number,
    green: value.green as number,
    blue: value.blue as number,
    pivot: value.pivot as number,
  };
}

export function validateGameArtTeamColors(value: unknown): GameArtTeamColors {
  if (
    !isRecord(value) ||
    !Array.isArray(value.players) ||
    value.players.length !== gameArtPlayerColorCount
  ) {
    throw new Error('game art team colours are invalid');
  }
  return {
    gaia: validateTeamColor(value.gaia ?? null),
    players: value.players.map((entry: unknown) => validateTeamColor(entry)),
  };
}

export interface GameArtSpriteRequestObject {
  objectId: number;
  civilizationId: number;
}

export interface GameArtSpritePart {
  graphic: number;
  offsetX: number;
  offsetY: number;
}

export interface GameArtSpriteAnnex {
  objectId: number;
  offsetX: number;
  offsetY: number;
}

export interface GameArtSpriteObject {
  objectId: number;
  civilizationId: number;
  table: number;
  parts: GameArtSpritePart[];
  foundationTerrain: number | null;
  annexes: GameArtSpriteAnnex[];
  invisible: boolean;
}

export const maximumGameArtAnnexes = 8;

export const cliffPieceRecordBytes = 20;
export const maximumCliffPieces = 65_536;

export interface CliffPieceRecord {
  objectId: number;
  x: number;
  y: number;
  facet: number;
  edges: readonly [number, number, number, number];
}

export function decodeCliffPieceColumn(
  bytes: Uint8Array,
  width: number,
  height: number,
): CliffPieceRecord[] | null {
  if (
    bytes.byteLength % cliffPieceRecordBytes !== 0 ||
    bytes.byteLength / cliffPieceRecordBytes > maximumCliffPieces
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pieces: CliffPieceRecord[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += cliffPieceRecordBytes) {
    const x256 = view.getUint32(offset + 4, true);
    const y256 = view.getUint32(offset + 8, true);
    const edges = [0, 1, 2, 3].map((side) => view.getInt8(offset + 14 + side)) as [
      number,
      number,
      number,
      number,
    ];
    if (
      x256 >= width * 256 ||
      y256 >= height * 256 ||
      edges.some((edge) => edge < -1 || edge > 1)
    ) {
      return null;
    }
    pieces.push({
      objectId: view.getUint32(offset, true),
      x: x256 / 256,
      y: y256 / 256,
      facet: view.getUint16(offset + 12, true),
      edges,
    });
  }
  return pieces;
}

export interface GameArtSpriteFacing {
  image: string;
  playerMask: string | null;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  averageColor: number | null;
}

export interface GameArtSpriteGraphic {
  id: number;
  layer: number;
  facings: GameArtSpriteFacing[];
}

export interface GameArtSpriteSet {
  revision: number;
  objects: GameArtSpriteObject[];
  graphics: GameArtSpriteGraphic[];
  fallbackCount: number;
}

export interface GameArtImage {
  key: string;
  bytes: Uint8Array;
}

const assetKeyPattern =
  /^(?:terrain|blends|masks|sprites)\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,95}\.png$/u;

export function isGameArtAssetKey(value: unknown): value is string {
  return typeof value === 'string' && assetKeyPattern.test(value) && !value.includes('..');
}

function isInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

function isFiniteWithin(value: unknown, bound: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= bound;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalKey(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (!isGameArtAssetKey(value)) throw new Error(`${label} is not a converted asset`);
  return value;
}

export function validateGameArtStatus(value: unknown): GameArtStatus {
  if (!isRecord(value)) throw new Error('game art status is invalid');
  const reason = () => {
    if (typeof value.reason !== 'string' || value.reason.length > maximumGameArtReasonLength) {
      throw new Error('game art status reason is invalid');
    }
    return value.reason;
  };
  switch (value.state) {
    case 'unlinked':
    case 'idle':
      return { state: value.state };
    case 'preparing': {
      const phases: readonly (GameArtPhase | null)[] = [
        null,
        'catalog',
        'terrain',
        'blends',
        'masks',
        'sprites',
      ];
      if (
        !phases.includes(value.phase as GameArtPhase | null) ||
        !isInteger(value.completed, 0, 1_000_000) ||
        !isInteger(value.total, 0, 1_000_000)
      ) {
        throw new Error('game art progress is invalid');
      }
      return {
        state: 'preparing',
        phase: value.phase as GameArtPhase | null,
        completed: value.completed,
        total: value.total,
      };
    }
    case 'ready':
      if (!isInteger(value.revision, 0, 2 ** 31) || !isInteger(value.fallbackCount, 0, 2 ** 31)) {
        throw new Error('game art status is invalid');
      }
      if (value.sprites === undefined) {
        return { state: 'ready', revision: value.revision, fallbackCount: value.fallbackCount };
      }
      if (
        !isRecord(value.sprites) ||
        !isInteger(value.sprites.completed, 0, 1_000_000) ||
        !isInteger(value.sprites.total, 1, 1_000_000) ||
        value.sprites.completed > value.sprites.total
      ) {
        throw new Error('game art sprite progress is invalid');
      }
      return {
        state: 'ready',
        revision: value.revision,
        fallbackCount: value.fallbackCount,
        sprites: { completed: value.sprites.completed, total: value.sprites.total },
      };
    case 'failed':
    case 'unavailable':
      return { state: value.state, reason: reason() };
    default:
      throw new Error('game art status is invalid');
  }
}

export function validateGameArtTerrainIndex(value: unknown): GameArtTerrainIndex {
  if (!isRecord(value)) throw new Error('game art terrain index is invalid');
  if (!isInteger(value.revision, 0, 2 ** 31)) throw new Error('game art revision is invalid');
  if (
    value.source !== undefined &&
    (typeof value.source !== 'string' || !/^[0-9a-f]{8,64}$/u.test(value.source))
  ) {
    throw new Error('game art cache source is invalid');
  }
  if (value.textureRepeatTiles !== gameArtTextureRepeatTiles) {
    throw new Error('game art texture repeat is unsupported');
  }
  if (!Array.isArray(value.terrains) || value.terrains.length > maximumGameArtTerrains) {
    throw new Error('game art terrains are invalid');
  }
  const seen = new Set<number>();
  const terrains = value.terrains.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      !isInteger(entry.id, 0, 255) ||
      seen.has(entry.id) ||
      !isInteger(entry.blendPriority, -(2 ** 31), 2 ** 31 - 1) ||
      !isInteger(entry.blendType, -(2 ** 31), 2 ** 31 - 1) ||
      !isInteger(entry.waterClass, 0, 255)
    ) {
      throw new Error('game art terrain is invalid');
    }
    seen.add(entry.id);
    return {
      id: entry.id,
      texture: optionalKey(entry.texture, 'terrain texture'),
      blendPriority: entry.blendPriority,
      blendType: entry.blendType,
      overlayMask: optionalKey(entry.overlayMask, 'overlay mask'),
      waterClass: entry.waterClass,
    };
  });
  if (!Array.isArray(value.blends) || value.blends.length !== gameArtBlendAtlasCount) {
    throw new Error('game art blend atlases are invalid');
  }
  return {
    revision: value.revision,
    ...(value.source === undefined ? {} : { source: value.source as string }),
    textureRepeatTiles: value.textureRepeatTiles,
    terrains,
    blends: value.blends.map((key: unknown) => optionalKey(key, 'blend atlas')),
    ...(value.playerColors === undefined
      ? {}
      : { playerColors: validateGameArtTeamColors(value.playerColors) }),
  };
}

export function validateGameArtSpriteSet(value: unknown): GameArtSpriteSet {
  if (!isRecord(value)) throw new Error('game art sprites are invalid');
  if (!isInteger(value.revision, 0, 2 ** 31) || !isInteger(value.fallbackCount, 0, 2 ** 31)) {
    throw new Error('game art sprites are invalid');
  }
  if (
    !Array.isArray(value.objects) ||
    value.objects.length > maximumGameArtSpriteObjects * 2 ||
    !Array.isArray(value.graphics) ||
    value.graphics.length > maximumGameArtSpriteGraphics
  ) {
    throw new Error('game art sprites exceed their bounds');
  }
  const objects = value.objects.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      !isInteger(entry.objectId, 0, 65_535) ||
      !isInteger(entry.civilizationId, 0, 255) ||
      !isInteger(entry.table, 0, 255) ||
      !Array.isArray(entry.parts) ||
      entry.parts.length > 64 ||
      !(entry.foundationTerrain === null || isInteger(entry.foundationTerrain, 0, 255))
    ) {
      throw new Error('game art sprite object is invalid');
    }
    const annexes = entry.annexes ?? [];
    if (!Array.isArray(annexes) || annexes.length > maximumGameArtAnnexes) {
      throw new Error('game art sprite annexes are invalid');
    }
    return {
      objectId: entry.objectId,
      civilizationId: entry.civilizationId,
      table: entry.table,
      foundationTerrain: entry.foundationTerrain as number | null,
      invisible: entry.invisible === true,
      annexes: annexes.map((annex: unknown) => {
        if (
          !isRecord(annex) ||
          !isInteger(annex.objectId, 0, 65_535) ||
          !isFiniteWithin(annex.offsetX, 64) ||
          !isFiniteWithin(annex.offsetY, 64)
        ) {
          throw new Error('game art sprite annex is invalid');
        }
        return { objectId: annex.objectId, offsetX: annex.offsetX, offsetY: annex.offsetY };
      }),
      parts: entry.parts.map((part: unknown) => {
        if (
          !isRecord(part) ||
          !isInteger(part.graphic, 0, 65_535) ||
          !isInteger(part.offsetX, -65_536, 65_536) ||
          !isInteger(part.offsetY, -65_536, 65_536)
        ) {
          throw new Error('game art sprite part is invalid');
        }
        return { graphic: part.graphic, offsetX: part.offsetX, offsetY: part.offsetY };
      }),
    };
  });
  const graphics = value.graphics.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      !isInteger(entry.id, 0, 65_535) ||
      !isInteger(entry.layer, 0, 255) ||
      !Array.isArray(entry.facings) ||
      entry.facings.length < 1 ||
      entry.facings.length > maximumGameArtFacings
    ) {
      throw new Error('game art sprite graphic is invalid');
    }
    return {
      id: entry.id,
      layer: entry.layer,
      facings: entry.facings.map((facing: unknown) => {
        if (
          !isRecord(facing) ||
          !isGameArtAssetKey(facing.image) ||
          !isInteger(facing.width, 1, 4096) ||
          !isInteger(facing.height, 1, 4096) ||
          !isInteger(facing.anchorX, -8192, 8192) ||
          !isInteger(facing.anchorY, -8192, 8192) ||
          !(
            facing.averageColor === undefined ||
            facing.averageColor === null ||
            isInteger(facing.averageColor, 0, 0xffffff)
          )
        ) {
          throw new Error('game art sprite facing is invalid');
        }
        return {
          image: facing.image,
          playerMask: optionalKey(facing.playerMask, 'player mask'),
          width: facing.width,
          height: facing.height,
          anchorX: facing.anchorX,
          anchorY: facing.anchorY,
          averageColor: typeof facing.averageColor === 'number' ? facing.averageColor : null,
        };
      }),
    };
  });
  return { revision: value.revision, objects, graphics, fallbackCount: value.fallbackCount };
}

export function validateGameArtSpriteRequest(value: unknown): GameArtSpriteRequestObject[] {
  if (!Array.isArray(value) || value.length > maximumGameArtSpriteObjects) {
    throw new Error('game art sprite request is invalid');
  }
  return value.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      !isInteger(entry.objectId, 0, 65_535) ||
      !isInteger(entry.civilizationId, 0, 255)
    ) {
      throw new Error('game art sprite request is invalid');
    }
    return { objectId: entry.objectId, civilizationId: entry.civilizationId };
  });
}

export function validateGameArtImageKeys(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximumGameArtImagesPerRequest ||
    !value.every(isGameArtAssetKey)
  ) {
    throw new Error('game art image request is invalid');
  }
  return [...value];
}

export function validateGameArtImages(value: unknown): GameArtImage[] {
  if (!Array.isArray(value) || value.length > maximumGameArtImagesPerRequest) {
    throw new Error('game art images are invalid');
  }
  let total = 0;
  return value.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      !isGameArtAssetKey(entry.key) ||
      !(entry.bytes instanceof Uint8Array) ||
      entry.bytes.byteLength > maximumGameArtImageBytes
    ) {
      throw new Error('game art image is invalid');
    }
    total += entry.bytes.byteLength;
    if (total > maximumGameArtImageRequestBytes) throw new Error('game art images are too large');
    return { key: entry.key, bytes: entry.bytes };
  });
}
