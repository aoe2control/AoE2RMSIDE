export const blendModeTable: readonly (readonly number[])[] = [
  [2, 3, 2, 1, 1, 6, 5, 4],
  [3, 3, 3, 1, 1, 6, 5, 4],
  [2, 3, 2, 1, 1, 6, 1, 4],
  [1, 1, 1, 0, 7, 6, 5, 4],
  [1, 1, 1, 7, 7, 6, 5, 4],
  [6, 6, 6, 6, 6, 6, 5, 4],
  [5, 5, 1, 5, 5, 5, 5, 4],
  [4, 3, 4, 4, 4, 4, 4, 4],
];

export const blendAtlasGrid: readonly (readonly number[])[] = [
  [16, 0, 1, 2, -1, -1, 3, 17],
  [4, -1, -1, -1, 20, -1, -1, -1],
  [5, -1, 30, -1, 26, -1, 27, -1],
  [6, -1, -1, -1, -1, -1, -1, 8],
  [-1, 21, 29, -1, 22, 23, -1, 9],
  [-1, -1, -1, -1, 24, 25, -1, 10],
  [7, -1, 28, -1, -1, -1, -1, 11],
  [18, -1, -1, 12, 13, 14, 15, 19],
];

export const blendAtlasCellsPerSide = 8;

export const blendNeighbours: readonly {
  dx: number;
  dy: number;
  tile: number;
  varies: boolean;
}[] = [
  { dx: 0, dy: 1, tile: 0, varies: true },
  { dx: 1, dy: 0, tile: 4, varies: true },
  { dx: -1, dy: 0, tile: 8, varies: true },
  { dx: 0, dy: -1, tile: 12, varies: true },
  { dx: 1, dy: 1, tile: 16, varies: false },
  { dx: -1, dy: 1, tile: 17, varies: false },
  { dx: 1, dy: -1, tile: 18, varies: false },
  { dx: -1, dy: -1, tile: 19, varies: false },
];

const cellByTile = new Map<number, { row: number; column: number }>();
for (const [row, cells] of blendAtlasGrid.entries()) {
  for (const [column, tile] of cells.entries()) {
    if (tile >= 0) cellByTile.set(tile, { row, column });
  }
}

export function blendAtlasCell(tile: number): { row: number; column: number } {
  const cell = cellByTile.get(tile);
  if (!cell) throw new Error(`blend tile ${tile} has no atlas cell`);
  return cell;
}

export function blendTile(
  neighbour: (typeof blendNeighbours)[number],
  x: number,
  y: number,
): number {
  return neighbour.varies ? neighbour.tile + ((x + y) & 3) : neighbour.tile;
}

export interface BlendTerrain {
  blendPriority: number;
  blendType: number;
}

export const noTerrainLayer = 0xffff;

export interface TerrainPair {
  terrain: number;
  layer: number;
}

export function terrainPairKey(
  pair: TerrainPair,
  terrains: ReadonlyMap<number, BlendTerrain>,
): number | undefined {
  const base = terrains.get(pair.terrain);
  if (!base) return undefined;
  if (pair.layer === noTerrainLayer) return base.blendPriority * 1000;
  const layer = terrains.get(pair.layer);
  return layer ? layer.blendPriority * 1000 + base.blendPriority : base.blendPriority * 1000;
}

export function terrainPairBlendType(
  pair: TerrainPair,
  terrains: ReadonlyMap<number, BlendTerrain>,
): number | undefined {
  if (pair.layer !== noTerrainLayer) {
    const layer = terrains.get(pair.layer);
    if (layer) return layer.blendType;
  }
  return terrains.get(pair.terrain)?.blendType;
}

export interface BlendQuad {
  upper: TerrainPair;
  upperKey: number;
  mode: number;
  tile: number;
}

export interface BlendGrid {
  width: number;
  height: number;
  pairAt(x: number, y: number): TerrainPair;
}

export function tileBlendQuads(
  grid: BlendGrid,
  x: number,
  y: number,
  terrains: ReadonlyMap<number, BlendTerrain>,
): BlendQuad[] {
  const pair = grid.pairAt(x, y);
  const key = terrainPairKey(pair, terrains);
  const lowerType = terrainPairBlendType(pair, terrains);
  if (key === undefined || lowerType === undefined) return [];
  const quads: BlendQuad[] = [];
  for (const neighbour of blendNeighbours) {
    const nx = x + neighbour.dx;
    const ny = y + neighbour.dy;
    if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
    const upper = grid.pairAt(nx, ny);
    if (upper.terrain === pair.terrain && upper.layer === pair.layer) continue;
    const upperKey = terrainPairKey(upper, terrains);
    const upperType = terrainPairBlendType(upper, terrains);
    if (upperKey === undefined || upperType === undefined || upperKey < key) continue;
    const mode = blendModeTable[lowerType]?.[upperType];
    if (mode === undefined) continue;
    quads.push({ upper, upperKey, mode, tile: blendTile(neighbour, x, y) });
  }
  quads.sort(
    (left, right) =>
      left.upperKey - right.upperKey ||
      left.upper.terrain - right.upper.terrain ||
      left.upper.layer - right.upper.layer,
  );
  return quads;
}

function mix32(value: number): number {
  let hash = value >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85eb_ca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2_ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

export function spriteFacing(
  seed: number,
  objectIndex: number,
  objectId: number,
  facings: number,
): number {
  if (!Number.isInteger(facings) || facings <= 1) return 0;
  const low = seed >>> 0;
  const high = Math.floor(seed / 2 ** 32) >>> 0;
  const hash = mix32(
    mix32(low ^ 0x9e37_79b9) ^
      mix32(high + 0x7f4a_7c15) ^
      mix32(objectIndex * 0x2545_f491 + 1) ^
      mix32(objectId + 0x6a09_e667),
  );
  return hash % facings;
}

export function spriteDrawOrder(layer: number, x: number, y: number): number {
  const depth = Math.round((y - x + 1024) * 256);
  const across = Math.round((x + y) * 4);
  return layer * 1e10 + depth * 8192 + across;
}
