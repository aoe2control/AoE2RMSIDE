import {
  mapIconArtDensity,
  mapIconArtMergeDensities,
  mapIconArtSize,
  mapIconArtSizePercents,
  type MapIconArtKind,
  type MapIconArtLayer,
  type MapIconArtObjectDescriptor,
} from '../shared/api';

export const mapIconTreeSheetLayout = Object.freeze({ columns: 4, rows: 4 });
export const mapIconResourceSheetLayout = Object.freeze({ columns: 2, rows: 2 });

export const mapIconTreeSpecies = Object.freeze([
  'oak',
  'pine',
  'snow-pine',
  'palm',
  'jungle',
  'bamboo',
  'dead',
  'baobab',
  'acacia',
  'mangrove',
  'olive',
  'cypress',
  'dragon',
  'birch',
  'autumn',
  'generic',
] as const);
export type MapIconTreeSpecies = (typeof mapIconTreeSpecies)[number];

export const mapIconGenericTreeCell = mapIconTreeSpecies.indexOf('generic');

export const mapIconResourceCells = Object.freeze({
  gold: Object.freeze({ small: 0, large: 1 }),
  stone: Object.freeze({ small: 2, large: 3 }),
});

export const mapIconLargePileTiles = 5;

export const mapIconTreeKeywords: readonly (readonly [MapIconTreeSpecies, readonly string[]])[] =
  Object.freeze([
    ['snow-pine', ['SNOWPINE', 'SNOW_PINE', 'SNOW']],
    ['bamboo', ['BAMBOO']],
    ['baobab', ['BAOBAB']],
    ['acacia', ['ACACIA']],
    ['mangrove', ['MANGROVE']],
    ['olive', ['OLIVE']],
    ['cypress', ['CYPRESS']],
    ['dragon', ['DRAGON']],
    ['birch', ['BIRCH']],
    ['autumn', ['AUTUMN']],
    ['dead', ['DEAD', 'DRY']],
    ['palm', ['PALM']],
    ['jungle', ['JUNGLE', 'RAINFOREST', 'RAINTREE', 'RAIN_TREE', 'BRAZILWOOD']],
    ['pine', ['PINE', 'SPRUCE', 'CONIFER']],
    ['oak', ['OAK']],
  ]);

export function mapIconTreeCell(names: readonly string[]): number {
  const upper = names.map((name) => name.toUpperCase());
  for (const [species, keywords] of mapIconTreeKeywords) {
    if (keywords.some((keyword) => upper.some((name) => name.includes(keyword)))) {
      return mapIconTreeSpecies.indexOf(species);
    }
  }
  return mapIconGenericTreeCell;
}

export interface MapIconArtClass {
  kind: MapIconArtKind;
  cell: number;
}

export interface MapIconArtClassifier {
  classify(object: {
    objectId: number;
    appearance?: 'tree' | 'decoration';
  }): MapIconArtClass | null;
}

export function mapIconArtClassifier(
  objects: readonly MapIconArtObjectDescriptor[] | undefined,
): MapIconArtClassifier {
  const classes = new Map<number, MapIconArtClass>();
  for (const object of objects ?? []) {
    classes.set(object.objectId, {
      kind: object.kind,
      cell: object.kind === 'tree' ? mapIconTreeCell(object.constants) : 0,
    });
  }
  return {
    classify(object) {
      if (object.appearance === 'decoration') return null;
      const known = classes.get(object.objectId);
      if (object.appearance === 'tree') {
        return known?.kind === 'tree' ? known : { kind: 'tree', cell: mapIconGenericTreeCell };
      }
      return known ?? null;
    },
  };
}

export interface MapIconSheetPixels {
  width: number;
  height: number;
  rgba: Uint8Array | Uint8ClampedArray;
}

export const mapIconSheetMaximumEdge = 4096;

export const mapIconChromaKeyThreshold = 64;

export interface MapIconChromaKey {
  threshold: number;
  maximumBlueExcess: number | null;
}

export const mapIconMagentaKey: Readonly<MapIconChromaKey> = Object.freeze({
  threshold: mapIconChromaKeyThreshold,
  maximumBlueExcess: null,
});

export const mapIconVioletSafeKey: Readonly<MapIconChromaKey> = Object.freeze({
  threshold: mapIconChromaKeyThreshold,
  maximumBlueExcess: 24,
});

export function mapIconKeyedBackground(
  red: number,
  green: number,
  blue: number,
  key: MapIconChromaKey = mapIconMagentaKey,
): boolean {
  if (Math.min(red, blue) - green < key.threshold) return false;
  return key.maximumBlueExcess === null || blue - red < key.maximumBlueExcess;
}
export const mapIconSpriteMinimumPiecePixels = 16;
export const mapIconSpriteOutlineColor = 0x2b1a0e;

export interface MapIconSpriteCell {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export interface MapIconProcessedSheet {
  columns: number;
  rows: number;
  cellPixels: number;
  cells: MapIconSpriteCell[];
}

export function processMapIconSpriteSheet(
  sheet: MapIconSheetPixels,
  layout: { columns: number; rows: number },
  key: MapIconChromaKey = mapIconMagentaKey,
): MapIconProcessedSheet {
  const { width, height, rgba } = sheet;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < layout.columns ||
    height < layout.rows ||
    width > mapIconSheetMaximumEdge ||
    height > mapIconSheetMaximumEdge ||
    rgba.length !== width * height * 4
  ) {
    throw new Error('map icon sprite sheet is invalid');
  }
  const kept = new Uint8Array(width * height);
  for (let index = 0; index < kept.length; index += 1) {
    const offset = index * 4;
    const red = rgba[offset]!;
    const green = rgba[offset + 1]!;
    const blue = rgba[offset + 2]!;
    kept[index] = mapIconKeyedBackground(red, green, blue, key) ? 0 : 1;
  }
  const eroded = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (
        kept[index] &&
        kept[index - 1] &&
        kept[index + 1] &&
        kept[index - width] &&
        kept[index + width] &&
        kept[index - width - 1] &&
        kept[index - width + 1] &&
        kept[index + width - 1] &&
        kept[index + width + 1]
      ) {
        eroded[index] = 1;
      }
    }
  }
  const outline = [
    (mapIconSpriteOutlineColor >> 16) & 0xff,
    (mapIconSpriteOutlineColor >> 8) & 0xff,
    mapIconSpriteOutlineColor & 0xff,
  ] as const;
  const labels = new Int32Array(width * height).fill(-1);
  const pieceCells: number[] = [];
  const cellWidth = width / layout.columns;
  const cellHeight = height / layout.rows;
  const stack: number[] = [];
  for (let start = 0; start < eroded.length; start += 1) {
    if (!eroded[start] || labels[start] !== -1) continue;
    const label = pieceCells.length;
    labels[start] = label;
    stack.push(start);
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % width;
      const y = (index - x) / width;
      count += 1;
      sumX += x;
      sumY += y;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (!eroded[neighbor] || labels[neighbor] !== -1) continue;
          labels[neighbor] = label;
          stack.push(neighbor);
        }
      }
    }
    const column = Math.min(layout.columns - 1, Math.floor(sumX / count / cellWidth));
    const row = Math.min(layout.rows - 1, Math.floor(sumY / count / cellHeight));
    pieceCells.push(count < mapIconSpriteMinimumPiecePixels ? -1 : row * layout.columns + column);
  }
  const cellCount = layout.columns * layout.rows;
  const bounds = Array.from({ length: cellCount }, () => ({
    minimumX: width,
    minimumY: height,
    maximumX: -1,
    maximumY: -1,
  }));
  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index]!;
    if (label < 0 || pieceCells[label]! < 0) continue;
    const box = bounds[pieceCells[label]!]!;
    const x = index % width;
    const y = (index - x) / width;
    if (x < box.minimumX) box.minimumX = x;
    if (x > box.maximumX) box.maximumX = x;
    if (y < box.minimumY) box.minimumY = y;
    if (y > box.maximumY) box.maximumY = y;
  }
  const cells: MapIconSpriteCell[] = [];
  for (let cell = 0; cell < cellCount; cell += 1) {
    const { minimumX, minimumY, maximumX, maximumY } = bounds[cell]!;
    if (maximumX < minimumX) {
      cells.push({ width: 0, height: 0, rgba: new Uint8ClampedArray(0) });
      continue;
    }
    const owned = (index: number) => {
      const label = labels[index]!;
      return label >= 0 && pieceCells[label] === cell;
    };
    const cropWidth = maximumX - minimumX + 1;
    const cropHeight = maximumY - minimumY + 1;
    const pixels = new Uint8ClampedArray(cropWidth * cropHeight * 4);
    for (let y = minimumY; y <= maximumY; y += 1) {
      for (let x = minimumX; x <= maximumX; x += 1) {
        const index = y * width + x;
        if (!owned(index)) continue;
        const edge =
          x === 0 ||
          y === 0 ||
          x === width - 1 ||
          y === height - 1 ||
          !owned(index - 1) ||
          !owned(index + 1) ||
          !owned(index - width) ||
          !owned(index + width);
        const target = ((y - minimumY) * cropWidth + (x - minimumX)) * 4;
        pixels[target] = edge ? outline[0] : rgba[index * 4]!;
        pixels[target + 1] = edge ? outline[1] : rgba[index * 4 + 1]!;
        pixels[target + 2] = edge ? outline[2] : rgba[index * 4 + 2]!;
        pixels[target + 3] = 255;
      }
    }
    cells.push({ width: cropWidth, height: cropHeight, rgba: pixels });
  }
  return {
    columns: layout.columns,
    rows: layout.rows,
    cellPixels: height / layout.rows,
    cells,
  };
}

export interface MapIconSprite {
  width: number;
  height: number;
  premultiplied: Uint8ClampedArray;
  anchorX: number;
  anchorY: number;
  opaque: { left: number; top: number; right: number; bottom: number } | null;
}

export const mapIconSpriteAnchors = Object.freeze({
  trees: Object.freeze({ x: 0.5, y: 0.92 }),
  resources: Object.freeze({ x: 0.5, y: 0.72 }),
});

export const mapIconSpriteMaximumScale = 4;

export function scaleMapIconSprite(
  cell: MapIconSpriteCell,
  scale: number,
  anchor: { x: number; y: number },
): MapIconSprite {
  if (!(scale > 0) || scale > mapIconSpriteMaximumScale || !Number.isFinite(scale)) {
    throw new Error('map icon sprite scale is invalid');
  }
  if (cell.width === 0 || cell.height === 0) {
    return {
      width: 0,
      height: 0,
      premultiplied: new Uint8ClampedArray(0),
      anchorX: 0,
      anchorY: 0,
      opaque: null,
    };
  }
  const width = Math.max(1, Math.ceil(cell.width * scale - 1e-9));
  const height = Math.max(1, Math.ceil(cell.height * scale - 1e-9));
  const columns = boxWeights(cell.width, width, scale);
  const rows = boxWeights(cell.height, height, scale);
  const horizontal = new Float64Array(width * cell.height * 4);
  for (let y = 0; y < cell.height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (const [source, weight] of columns[x]!) {
        const offset = (y * cell.width + source) * 4;
        const a = (cell.rgba[offset + 3]! / 255) * weight;
        red += cell.rgba[offset]! * a;
        green += cell.rgba[offset + 1]! * a;
        blue += cell.rgba[offset + 2]! * a;
        alpha += 255 * a;
      }
      const target = (y * width + x) * 4;
      horizontal[target] = red;
      horizontal[target + 1] = green;
      horizontal[target + 2] = blue;
      horizontal[target + 3] = alpha;
    }
  }
  const premultiplied = new Uint8ClampedArray(width * height * 4);
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (const [source, weight] of rows[y]!) {
        const offset = (source * width + x) * 4;
        red += horizontal[offset]! * weight;
        green += horizontal[offset + 1]! * weight;
        blue += horizontal[offset + 2]! * weight;
        alpha += horizontal[offset + 3]! * weight;
      }
      const a = Math.round(alpha);
      const target = (y * width + x) * 4;
      premultiplied[target] = Math.min(a, Math.round(red));
      premultiplied[target + 1] = Math.min(a, Math.round(green));
      premultiplied[target + 2] = Math.min(a, Math.round(blue));
      premultiplied[target + 3] = a;
      if (a > 0) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return {
    width,
    height,
    premultiplied,
    anchorX: Math.round(cell.width * anchor.x * scale),
    anchorY: Math.round(cell.height * anchor.y * scale),
    opaque: right < 0 ? null : { left, top, right, bottom },
  };
}

function boxWeights(sourceSize: number, targetSize: number, scale: number): [number, number][][] {
  const weights: [number, number][][] = [];
  for (let target = 0; target < targetSize; target += 1) {
    const start = target / scale;
    const end = (target + 1) / scale;
    const entries: [number, number][] = [];
    for (
      let source = Math.floor(start);
      source < Math.min(sourceSize, Math.ceil(end));
      source += 1
    ) {
      const overlap = Math.min(end, source + 1) - Math.max(start, source);
      if (overlap > 0) entries.push([source, overlap * scale]);
    }
    weights.push(entries);
  }
  return weights;
}

export interface MapIconArtSheets {
  trees: MapIconProcessedSheet;
  resources: MapIconProcessedSheet;
  players: {
    squares: MapIconProcessedSheet;
    feet: MapIconProcessedSheet;
  };
}

export interface MapIconArtMetrics {
  pixelsPerTile: number;
  treeCellPixels: number;
  resourceCellPixels: number;
}

export const mapIconArtCellPixels = Object.freeze({
  trees: Object.freeze({ perTile: 6.5, minimum: 20, maximum: 40 }),
  resources: Object.freeze({ perTile: 7, minimum: 22, maximum: 44 }),
});

export function mapIconArtMetrics(projection: { component: number }): MapIconArtMetrics {
  const pixelsPerTile = 2 * projection.component;
  const size = (bounds: { perTile: number; minimum: number; maximum: number }) =>
    Math.min(bounds.maximum, Math.max(bounds.minimum, Math.round(bounds.perTile * pixelsPerTile)));
  return {
    pixelsPerTile,
    treeCellPixels: size(mapIconArtCellPixels.trees),
    resourceCellPixels: size(mapIconArtCellPixels.resources),
  };
}

export function mapIconArtSizedCellPixels(cellPixels: number, size: number): number {
  if (!Number.isInteger(size) || size < mapIconArtSize.minimum || size > mapIconArtSize.maximum) {
    throw new Error('map icon art size is invalid');
  }
  return Math.max(4, Math.round((cellPixels * mapIconArtSizePercents[size]!) / 100));
}

export const mapIconArtFootprintFraction = 0.6;

export const mapIconArtSpacingCurve = Object.freeze([
  1, 0.72, 0.52, 0.37, 0.26, 0.18, 0.12, 0.08, 0.05, 0.02, 0,
]);

export const mapIconArtMergeFractions = Object.freeze([0, 0.06, 0.12, 0.22, 0.36, 0.6]);

function validDensity(density: number): boolean {
  return (
    Number.isInteger(density) &&
    density >= mapIconArtDensity.minimum &&
    density <= mapIconArtDensity.maximum
  );
}

export function mapIconArtSpacing(density: number, footprintTiles: number): number {
  if (!validDensity(density)) throw new Error('map icon art density is invalid');
  const widest = Math.max(1, 2 * footprintTiles);
  const step = Math.max(0, density - mapIconArtMergeDensities);
  return 1 + (widest - 1) * mapIconArtSpacingCurve[step]!;
}

export interface MapIconArtObject {
  kind: MapIconArtKind;
  cell: number;
  x: number;
  y: number;
}

export interface MapIconArtPlacement {
  layer: MapIconArtLayer;
  cell: number;
  x: number;
  y: number;
  count: number;
}

export const mapIconTreeMinimumFill = 0.15;
export const mapIconTreeJitter = 0.35;
export const mapIconArtMaximumSprites = 40_000;

export function mapIconTreePlacements(
  trees: readonly MapIconArtObject[],
  spacing: number,
  mapWidth: number,
  mapHeight: number,
): MapIconArtPlacement[] {
  const cells = treeGridCells(trees, spacing, mapWidth);
  const minimum = Math.max(1, Math.ceil(spacing * spacing * mapIconTreeMinimumFill));
  const jitter = mapIconTreeJitter * (spacing - 1);
  const placements: MapIconArtPlacement[] = [];
  for (const cell of cells) {
    if (cell.count < minimum) continue;
    const dominant = dominantSpecies(cell.species);
    const offsetX = jitter * (hashUnit(cell.row, cell.column, 1) - 0.5);
    const offsetY = jitter * (hashUnit(cell.row, cell.column, 2) - 0.5);
    placements.push({
      layer: 'trees',
      cell: dominant,
      x: clamp(cell.sumX / cell.count + offsetX, 0, mapWidth),
      y: clamp(cell.sumY / cell.count + offsetY, 0, mapHeight),
      count: cell.count,
    });
  }
  return placements;
}

interface TreeGridCell {
  row: number;
  column: number;
  count: number;
  sumX: number;
  sumY: number;
  species: Int32Array;
}

function treeGridCells(
  trees: readonly MapIconArtObject[],
  spacing: number,
  mapWidth: number,
): TreeGridCell[] {
  if (!(spacing >= 1) || !Number.isFinite(spacing)) throw new Error('tree spacing is invalid');
  const columnsPerRow = Math.ceil(mapWidth / spacing) + 2;
  const cells = new Map<number, TreeGridCell>();
  for (const tree of trees) {
    const row = Math.floor(tree.y / spacing);
    const shift = row % 2 === 1 ? spacing / 2 : 0;
    const column = Math.floor((tree.x + shift) / spacing);
    const key = row * columnsPerRow + column;
    let cell = cells.get(key);
    if (!cell) {
      cell = { row, column, count: 0, sumX: 0, sumY: 0, species: new Int32Array(16) };
      cells.set(key, cell);
    }
    cell.count += 1;
    cell.sumX += tree.x;
    cell.sumY += tree.y;
    cell.species[tree.cell] = (cell.species[tree.cell] ?? 0) + 1;
  }
  return [...cells.keys()].sort((left, right) => left - right).map((key) => cells.get(key)!);
}

function dominantSpecies(species: Int32Array): number {
  let dominant = 0;
  for (let cell = 1; cell < species.length; cell += 1) {
    if (species[cell]! > species[dominant]!) dominant = cell;
  }
  return dominant;
}

interface ResourcePileTile {
  x: number;
  y: number;
  sumX: number;
  sumY: number;
  count: number;
}

function resourcePiles(
  mines: readonly MapIconArtObject[],
  kind: 'gold' | 'stone',
  mapWidth: number,
  mapHeight: number,
): ResourcePileTile[][] {
  const tiles = new Map<number, ResourcePileTile>();
  for (const mine of mines) {
    if (mine.kind !== kind) continue;
    const tileX = clamp(Math.floor(mine.x), 0, mapWidth - 1);
    const tileY = clamp(Math.floor(mine.y), 0, mapHeight - 1);
    const key = tileY * mapWidth + tileX;
    const tile = tiles.get(key) ?? { x: tileX, y: tileY, sumX: 0, sumY: 0, count: 0 };
    tile.sumX += mine.x;
    tile.sumY += mine.y;
    tile.count += 1;
    tiles.set(key, tile);
  }
  const visited = new Set<number>();
  const piles: ResourcePileTile[][] = [];
  for (const start of [...tiles.keys()].sort((left, right) => left - right)) {
    if (visited.has(start)) continue;
    const pile: number[] = [];
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const key = queue.pop()!;
      pile.push(key);
      const { x, y } = tiles.get(key)!;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= mapWidth || ny >= mapHeight) {
            continue;
          }
          const neighbor = ny * mapWidth + nx;
          if (!tiles.has(neighbor) || visited.has(neighbor)) continue;
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    piles.push(
      pile
        .map((key) => tiles.get(key)!)
        .sort((left, right) => left.x + left.y - (right.x + right.y) || left.x - right.x),
    );
  }
  return piles;
}

export function mapIconResourcePlacements(
  mines: readonly MapIconArtObject[],
  spacing: number,
  mapWidth: number,
  mapHeight: number,
): MapIconArtPlacement[] {
  if (!(spacing >= 1) || !Number.isFinite(spacing)) throw new Error('pile spacing is invalid');
  const placements: MapIconArtPlacement[] = [];
  for (const kind of ['gold', 'stone'] as const) {
    for (const ordered of resourcePiles(mines, kind, mapWidth, mapHeight)) {
      const parts = clamp(Math.round(ordered.length / (spacing * spacing)), 1, ordered.length);
      for (let part = 0; part < parts; part += 1) {
        const members = ordered.slice(
          Math.floor((part * ordered.length) / parts),
          Math.floor(((part + 1) * ordered.length) / parts),
        );
        let sumX = 0;
        let sumY = 0;
        let count = 0;
        for (const tile of members) {
          sumX += tile.sumX;
          sumY += tile.sumY;
          count += tile.count;
        }
        const size = members.length >= mapIconLargePileTiles ? 'large' : 'small';
        placements.push({
          layer: 'resources',
          cell: mapIconResourceCells[kind][size],
          x: sumX / count,
          y: sumY / count,
          count,
        });
      }
    }
  }
  return placements;
}

export function mapIconLayerPlacements(
  layer: MapIconArtLayer,
  objects: readonly MapIconArtObject[],
  spacing: number,
  mapWidth: number,
  mapHeight: number,
): MapIconArtPlacement[] {
  const place = layer === 'trees' ? mapIconTreePlacements : mapIconResourcePlacements;
  let current = spacing;
  let placements = place(objects, current, mapWidth, mapHeight);
  for (
    let attempt = 0;
    attempt < 24 && placements.length > mapIconArtMaximumSprites;
    attempt += 1
  ) {
    current *= 1.25;
    placements = place(objects, current, mapWidth, mapHeight);
  }
  return placements.slice(0, mapIconArtMaximumSprites);
}

export const mapIconArtMergeGroupLimit = 1024;

interface ArtGroup {
  count: number;
  sumX: number;
  sumY: number;
  tiles: number;
  species: Int32Array | null;
}

export function mapIconArtLayerPlacements(
  layer: MapIconArtLayer,
  objects: readonly MapIconArtObject[],
  density: number,
  footprintTiles: number,
  mapWidth: number,
  mapHeight: number,
): MapIconArtPlacement[] {
  const spacing = mapIconArtSpacing(density, footprintTiles);
  const base = mapIconLayerPlacements(layer, objects, spacing, mapWidth, mapHeight);
  if (density >= mapIconArtMergeDensities) return base;
  const fraction = mapIconArtMergeFractions[density]!;
  const target = (drawn: number) => (density === 0 ? 1 : Math.max(1, Math.round(drawn * fraction)));
  if (layer === 'trees') {
    const groups: ArtGroup[] = treeGridCells(objects, spacing, mapWidth).map((cell) => ({
      count: cell.count,
      sumX: cell.sumX,
      sumY: cell.sumY,
      tiles: 0,
      species: cell.species,
    }));
    return mergeArtGroups(groups, target(base.length), mapWidth, mapHeight).map((group) => ({
      layer: 'trees',
      cell: dominantSpecies(group.species!),
      x: group.sumX / group.count,
      y: group.sumY / group.count,
      count: group.count,
    }));
  }
  const placements: MapIconArtPlacement[] = [];
  for (const kind of ['gold', 'stone'] as const) {
    const cells = mapIconResourceCells[kind];
    const drawn = base.filter(
      (placement) => placement.cell === cells.small || placement.cell === cells.large,
    ).length;
    const groups: ArtGroup[] = resourcePiles(objects, kind, mapWidth, mapHeight).map((pile) => {
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      for (const tile of pile) {
        sumX += tile.sumX;
        sumY += tile.sumY;
        count += tile.count;
      }
      return { count, sumX, sumY, tiles: pile.length, species: null };
    });
    for (const group of mergeArtGroups(groups, target(drawn), mapWidth, mapHeight)) {
      placements.push({
        layer: 'resources',
        cell: group.tiles >= mapIconLargePileTiles ? cells.large : cells.small,
        x: group.sumX / group.count,
        y: group.sumY / group.count,
        count: group.count,
      });
    }
  }
  return placements;
}

function joinArtGroups(left: ArtGroup, right: ArtGroup): ArtGroup {
  let species: Int32Array | null = null;
  if (left.species && right.species) {
    species = new Int32Array(left.species.length);
    for (let cell = 0; cell < species.length; cell += 1) {
      species[cell] = left.species[cell]! + right.species[cell]!;
    }
  }
  return {
    count: left.count + right.count,
    sumX: left.sumX + right.sumX,
    sumY: left.sumY + right.sumY,
    tiles: left.tiles + right.tiles,
    species,
  };
}

function mergeArtGroups(
  groups: readonly ArtGroup[],
  target: number,
  mapWidth: number,
  mapHeight: number,
): ArtGroup[] {
  if (groups.length === 0) return [];
  let pooled: ArtGroup[] = [...groups];
  if (pooled.length > mapIconArtMergeGroupLimit) {
    const buckets = new Map<number, ArtGroup>();
    for (const group of pooled) {
      const column = clamp(Math.floor(((group.sumX / group.count) * 32) / mapWidth), 0, 31);
      const row = clamp(Math.floor(((group.sumY / group.count) * 32) / mapHeight), 0, 31);
      const key = row * 32 + column;
      const bucket = buckets.get(key);
      buckets.set(key, bucket ? joinArtGroups(bucket, group) : group);
    }
    pooled = [...buckets.values()];
  }
  const labels = mapIconWardPartition(
    pooled.map((group) => ({
      x: group.sumX / group.count,
      y: group.sumY / group.count,
      weight: group.count,
    })),
    target,
  );
  const merged: ArtGroup[] = [];
  for (const [index, group] of pooled.entries()) {
    const label = labels[index]!;
    merged[label] = merged[label] ? joinArtGroups(merged[label], group) : group;
  }
  return merged;
}

export function mapIconWardPartition(
  points: readonly { x: number; y: number; weight: number }[],
  target: number,
): Int32Array {
  const n = points.length;
  const labels = new Int32Array(n);
  if (n === 0) return labels;
  const clusters = Math.max(1, Math.min(n, Math.floor(target)));
  if (clusters === n) {
    for (let index = 0; index < n; index += 1) labels[index] = index;
    return labels;
  }
  if (clusters > 1) {
    const capacity = 2 * n - 1;
    const cx = new Float64Array(capacity);
    const cy = new Float64Array(capacity);
    const cw = new Float64Array(capacity);
    for (const [index, point] of points.entries()) {
      cx[index] = point.x;
      cy[index] = point.y;
      cw[index] = point.weight;
    }
    const alive: number[] = Array.from({ length: n }, (_, index) => index);
    const position = new Int32Array(capacity).fill(-1);
    for (let index = 0; index < n; index += 1) position[index] = index;
    const remove = (id: number) => {
      const at = position[id]!;
      const last = alive.pop()!;
      if (last !== id) {
        alive[at] = last;
        position[last] = at;
      }
      position[id] = -1;
    };
    const cost = (a: number, b: number) => {
      const dx = cx[a]! - cx[b]!;
      const dy = cy[a]! - cy[b]!;
      return ((cw[a]! * cw[b]!) / (cw[a]! + cw[b]!)) * (dx * dx + dy * dy);
    };
    const merges: { a: number; b: number; id: number; cost: number }[] = [];
    const chain: number[] = [];
    let next = n;
    while (alive.length > 1) {
      if (chain.length === 0) {
        let lowest = alive[0]!;
        for (const id of alive) if (id < lowest) lowest = id;
        chain.push(lowest);
      }
      const a = chain[chain.length - 1]!;
      const previous = chain.length > 1 ? chain[chain.length - 2]! : -1;
      let best = -1;
      let bestCost = Number.POSITIVE_INFINITY;
      for (const id of alive) {
        if (id === a) continue;
        const value = cost(a, id);
        if (value < bestCost || (value === bestCost && id < best)) {
          best = id;
          bestCost = value;
        }
      }
      if (previous >= 0 && cost(a, previous) <= bestCost) best = previous;
      if (best !== previous) {
        chain.push(best);
        continue;
      }
      chain.pop();
      chain.pop();
      const weight = cw[a]! + cw[best]!;
      cx[next] = (cx[a]! * cw[a]! + cx[best]! * cw[best]!) / weight;
      cy[next] = (cy[a]! * cw[a]! + cy[best]! * cw[best]!) / weight;
      cw[next] = weight;
      merges.push({ a: Math.min(a, best), b: Math.max(a, best), id: next, cost: bestCost });
      remove(a);
      remove(best);
      alive.push(next);
      position[next] = alive.length - 1;
      next += 1;
    }
    const height = new Float64Array(capacity);
    const order = merges.map((merge, sequence) => {
      height[merge.id] = Math.max(merge.cost, height[merge.a]!, height[merge.b]!);
      return { merge, sequence, height: height[merge.id]! };
    });
    order.sort((left, right) => left.height - right.height || left.sequence - right.sequence);
    const parent = new Int32Array(capacity).fill(-1);
    for (const { merge } of order.slice(0, n - clusters)) {
      parent[merge.a] = merge.id;
      parent[merge.b] = merge.id;
    }
    const roots = new Map<number, number>();
    for (let index = 0; index < n; index += 1) {
      let root = index;
      while (parent[root]! >= 0) root = parent[root]!;
      let label = roots.get(root);
      if (label === undefined) {
        label = roots.size;
        roots.set(root, label);
      }
      labels[index] = label;
    }
  }
  return labels;
}

export interface MapIconScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

export function hashUnit(row: number, column: number, salt: number): number {
  let hash = mix32(Math.imul(salt | 0, 0x9e3779b1));
  hash = mix32(hash ^ (row | 0));
  hash = mix32(hash ^ (column | 0));
  return (hash >>> 0) / 0x1_0000_0000;
}

function mix32(value: number): number {
  let hash = value | 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash;
}
