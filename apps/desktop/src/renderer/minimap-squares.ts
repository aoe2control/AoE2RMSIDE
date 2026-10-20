import type { MapIconArtObjectDescriptor, SelectedMinimapPalette } from '../shared/api';
import {
  isDecorationPreviewObject,
  isVisiblePreviewObject,
  ownerPreviewColor,
} from './preview-materials';
import {
  previewProjectionVerticalScale,
  previewScale,
  previewVisibleFitRatio,
  type PreviewCamera,
  type PreviewViewport,
  type ZoomSizeLaw,
} from './top-down-preview';

export type PreviewObjectsMode = 'markers' | 'minimap' | 'off';

export const previewObjectsModes: readonly PreviewObjectsMode[] = Object.freeze([
  'markers',
  'minimap',
  'off',
]);

export function nextPreviewObjectsMode(mode: PreviewObjectsMode): PreviewObjectsMode {
  const index = previewObjectsModes.indexOf(mode);
  return previewObjectsModes[(index + 1) % previewObjectsModes.length]!;
}

export type MinimapSquareClass =
  | 'tree'
  | 'gold'
  | 'stone'
  | 'relic'
  | 'forage'
  | 'herdable'
  | 'fish'
  | 'gaia'
  | 'player'
  | 'town-center';

export const minimapSquareColors = Object.freeze({
  tree: 0x015318,
  gold: 0xffb74b,
  stone: 0x776363,
  relic: 0xffffff,
  forage: 0x9fd994,
  herdable: 0xa0785a,
  fish: 0x8fd3ff,
  gaia: 0xc8c8c8,
} as const satisfies Record<Exclude<MinimapSquareClass, 'player' | 'town-center'>, number>);

export const minimapSquareSizing = Object.freeze({
  tileWidths: 1.5,
  minimumObject: 5,
  treeFraction: 2 / 3,
  townCenter: 32,
  townCenterTileHeights: 3,
});

export interface MinimapSquareSizes {
  object: number;
  tree: number;
  townCenter: number;
}

export interface MinimapSquareSizeInput {
  component: number;
  baseComponent: number;
  verticalScale: number;
  unit?: number;
}

export function minimapSquareSizes(input: MinimapSquareSizeInput): MinimapSquareSizes {
  const unit = input.unit ?? 1;
  const base = Math.max(
    minimapSquareSizing.minimumObject * unit,
    minimapSquareSizing.tileWidths * 2 * input.baseComponent,
  );
  const tileHeight = 2 * input.component * input.verticalScale;
  const minimum = input.verticalScale < 1 ? tileHeight : tileHeight / 2;
  const object = Math.max(base, minimum);
  return {
    object,
    tree: object * minimapSquareSizing.treeFraction,
    townCenter: Math.max(
      minimapSquareSizing.townCenter * unit,
      minimapSquareSizing.townCenterTileHeights * tileHeight,
    ),
  };
}

export function minimapSquareSizeLaws(
  input: MinimapSquareSizeInput,
): Record<keyof MinimapSquareSizes, ZoomSizeLaw> {
  const unit = input.unit ?? 1;
  const base = Math.max(
    minimapSquareSizing.minimumObject * unit,
    minimapSquareSizing.tileWidths * 2 * input.baseComponent,
  );
  const tileHeight = 2 * input.component * input.verticalScale;
  const minimum = input.verticalScale < 1 ? tileHeight : tileHeight / 2;
  const tree = minimapSquareSizing.treeFraction;
  return {
    object: { base: minimum, minimum: base, maximum: Number.POSITIVE_INFINITY },
    tree: { base: minimum * tree, minimum: base * tree, maximum: Number.POSITIVE_INFINITY },
    townCenter: {
      base: minimapSquareSizing.townCenterTileHeights * tileHeight,
      minimum: minimapSquareSizing.townCenter * unit,
      maximum: Number.POSITIVE_INFINITY,
    },
  };
}

export const minimapSquareTownCenterBorderColor = 0x000000;

export const minimapSquareTownCenterObjectId = 109;

export const minimapSquareClassObjectIds = Object.freeze({
  fish: Object.freeze([53, 61, 69, 450, 451, 452, 454, 455, 456, 457, 458, 459, 460, 461, 1141]),
  forage: Object.freeze([59, 1059, 1549, 2599, 2650]),
  hunt: Object.freeze([
    48, 65, 89, 126, 158, 202, 486, 707, 810, 812, 822, 835, 860, 884, 936, 1019, 1026, 1029, 1031,
    1135, 1137, 1139, 1239, 1241, 1247, 1301, 1796, 1896, 1924, 1965, 2084, 2086, 2088, 2089, 2090,
    2091, 2092, 2093, 2094, 2095, 2096, 2097, 2098, 2099, 2100, 2340, 2537, 2589, 2591, 2592, 2594,
    2595, 2597, 2615, 2735, 2736, 2737, 2739,
  ]),
  herdable: Object.freeze([
    305, 594, 705, 814, 833, 897, 1060, 1142, 1237, 1243, 1245, 1356, 1596, 1598, 1600, 1602, 1604,
    1606, 1869, 1963, 2083, 2085, 2087, 2525, 2590, 2614, 2714, 2715,
  ]),
  relic: Object.freeze([285, 287, 288, 289, 290, 292, 294, 295, 296, 297, 298, 688]),
  gold: Object.freeze([66, 841]),
  stone: Object.freeze([102, 839]),
  tree: Object.freeze([
    284, 302, 348, 349, 350, 351, 399, 400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411,
    413, 414, 768, 1051, 1052, 1053, 1054, 1063, 1144, 1146, 1248, 1249, 1250, 1347, 1348, 1349,
    1350, 1539, 1540, 1541, 1542, 1717, 1984, 2016, 2017, 2025, 2027, 2028, 2567, 2570, 2580, 2583,
    2731, 2732, 2733,
  ]),
  bird: Object.freeze([
    96, 544, 816, 1028, 1291, 1305, 1956, 2381, 2551, 2553, 2555, 2563, 2593, 2596, 2729,
  ]),
  flag: Object.freeze([
    112, 162, 201, 304, 600, 601, 602, 603, 604, 720, 721, 722, 837, 851, 901, 1150, 1151, 1152,
    1153, 1270, 1282, 1283, 1284, 1285, 1307, 1543, 1544, 1545, 1546, 1547, 1774, 1775, 1872, 1873,
    1874, 1875, 1876, 1902, 1905, 1909, 1912, 1921, 2010, 2011, 2012, 2013, 2014, 2015, 2253, 2254,
    2255, 2256, 2257, 2258, 2259, 2260, 2261, 2352, 2353, 2354, 2355, 2498, 2499, 2500, 2513, 2577,
    2601, 2602, 2603, 2604, 2605, 2741, 2746, 2749,
  ]),
});

const resourceTypes = Object.freeze({ wood: 1, stone: 2, gold: 3 });

export interface MinimapSquareObject {
  objectId: number;
  owner: number;
  resourceType?: number;
  appearance?: 'tree' | 'decoration';
}

export interface MinimapSquareClassifierInput {
  artObjects?: readonly MapIconArtObjectDescriptor[];
  minimapPalette?: Pick<SelectedMinimapPalette, 'neutralObjectColors'> | null;
  helperObjectIds?: ReadonlySet<number>;
}

export interface MinimapSquareClassifier {
  classify(object: MinimapSquareObject): MinimapSquareClass | null;
}

const gaiaClasses: readonly (readonly [MinimapSquareClass, readonly number[]])[] = [
  ['fish', minimapSquareClassObjectIds.fish],
  ['forage', minimapSquareClassObjectIds.forage],
  ['herdable', minimapSquareClassObjectIds.hunt],
  ['herdable', minimapSquareClassObjectIds.herdable],
  ['relic', minimapSquareClassObjectIds.relic],
  ['gold', minimapSquareClassObjectIds.gold],
  ['stone', minimapSquareClassObjectIds.stone],
  ['tree', minimapSquareClassObjectIds.tree],
];

const hiddenGaiaIds: ReadonlySet<number> = new Set([
  ...minimapSquareClassObjectIds.bird,
  ...minimapSquareClassObjectIds.flag,
]);

export function minimapSquareClassifier(
  input: MinimapSquareClassifierInput = {},
): MinimapSquareClassifier {
  const known = new Map<number, MinimapSquareClass>();
  for (const [kind, ids] of gaiaClasses) {
    for (const id of ids) if (!known.has(id)) known.set(id, kind);
  }
  for (const object of input.artObjects ?? []) known.set(object.objectId, object.kind);
  const listed = input.minimapPalette
    ? new Set(input.minimapPalette.neutralObjectColors.map((entry) => entry.objectId))
    : null;
  const helpers = input.helperObjectIds ?? new Set<number>();
  return {
    classify(object) {
      if (isDecorationPreviewObject(object) || !isVisiblePreviewObject(object)) return null;
      if (helpers.has(object.objectId)) return null;
      if (object.owner > 0) {
        return object.objectId === minimapSquareTownCenterObjectId ? 'town-center' : 'player';
      }
      if (object.appearance === 'tree') return 'tree';
      if (hiddenGaiaIds.has(object.objectId)) return null;
      const kind = known.get(object.objectId);
      if (kind) return kind;
      if (object.resourceType === resourceTypes.gold) return 'gold';
      if (object.resourceType === resourceTypes.stone) return 'stone';
      if (object.resourceType === resourceTypes.wood) return 'tree';
      return listed === null || listed.has(object.objectId) ? 'gaia' : null;
    },
  };
}

export function minimapSquareColor(
  kind: MinimapSquareClass,
  owner: number,
  playerColorIds: readonly number[] = [],
): number {
  return kind === 'player' || kind === 'town-center'
    ? ownerPreviewColor(owner, playerColorIds)
    : minimapSquareColors[kind];
}

export function minimapSquareGaiaObjectColors(
  objects: Iterable<MinimapSquareObject>,
  classifier: MinimapSquareClassifier,
): Map<number, number> {
  const colors = new Map<number, number>();
  for (const object of objects) {
    if (object.owner > 0 || colors.has(object.objectId)) continue;
    const kind = classifier.classify(object);
    if (kind) colors.set(object.objectId, minimapSquareColor(kind, 0));
  }
  return colors;
}

export function minimapSquareDrawLayer(kind: MinimapSquareClass): 0 | 1 | 2 | 3 {
  if (kind === 'tree') return 0;
  if (kind === 'player') return 2;
  if (kind === 'town-center') return 3;
  return 1;
}

export const minimapSquareBaseZoom = 0.95;

export function previewMinimapSquareSizes(
  mapWidth: number,
  mapHeight: number,
  camera: PreviewCamera,
  viewport: PreviewViewport,
): MinimapSquareSizes {
  return minimapSquareSizes(previewMinimapSquareSizeInput(mapWidth, mapHeight, camera, viewport));
}

export function previewMinimapSquareSizeLaws(
  mapWidth: number,
  mapHeight: number,
  camera: PreviewCamera,
  viewport: PreviewViewport,
): Record<keyof MinimapSquareSizes, ZoomSizeLaw> {
  return minimapSquareSizeLaws(
    previewMinimapSquareSizeInput(mapWidth, mapHeight, camera, viewport),
  );
}

function previewMinimapSquareSizeInput(
  mapWidth: number,
  mapHeight: number,
  camera: PreviewCamera,
  viewport: PreviewViewport,
): MinimapSquareSizeInput {
  const component = previewScale(mapWidth, mapHeight, camera, viewport) * Math.SQRT1_2;
  const baseComponent =
    previewScale(
      mapWidth,
      mapHeight,
      { ...camera, zoom: minimapSquareBaseZoom * previewVisibleFitRatio(viewport) },
      viewport,
    ) * Math.SQRT1_2;
  return { component, baseComponent, verticalScale: previewProjectionVerticalScale(viewport) };
}

export function minimapSquareSide(kind: MinimapSquareClass, sizes: MinimapSquareSizes): number {
  return kind === 'tree' ? sizes.tree : sizes.object;
}

const townCenterDomeSegments = 16;

export const minimapSquareTownCenterOutline: readonly (readonly [number, number])[] = Object.freeze(
  [
    [1, 20],
    [1, 10],
    ...Array.from({ length: townCenterDomeSegments + 1 }, (_, index) => {
      const angle = (Math.PI * index) / townCenterDomeSegments;
      const round = (value: number) => Math.round(value * 1e6) / 1e6;
      return [round(12 - 6 * Math.cos(angle)), round(10 - 6 * Math.sin(angle))];
    }),
    [23, 10],
    [23, 20],
    [19, 20],
    [19, 16],
    [16, 16],
    [16, 20],
    [8, 20],
    [8, 16],
    [5, 16],
    [5, 20],
  ].map((point) => Object.freeze(point as [number, number])),
);

const townCenterBounds = { left: 1, right: 23, top: 4, bottom: 20 };

export function minimapSquareTownCenterPolygon(
  centerX: number,
  centerY: number,
  width: number,
): number[] {
  const scale = width / (townCenterBounds.right - townCenterBounds.left);
  const middleX = (townCenterBounds.left + townCenterBounds.right) / 2;
  const middleY = (townCenterBounds.top + townCenterBounds.bottom) / 2;
  const points: number[] = [];
  for (const [x, y] of minimapSquareTownCenterOutline) {
    points.push(centerX + (x - middleX) * scale, centerY + (y - middleY) * scale);
  }
  return points;
}

export function minimapSquarePolygon(centerX: number, centerY: number, side: number): number[] {
  const half = side / 2;
  return [
    centerX - half,
    centerY - half,
    centerX + half,
    centerY - half,
    centerX + half,
    centerY + half,
    centerX - half,
    centerY + half,
  ];
}
