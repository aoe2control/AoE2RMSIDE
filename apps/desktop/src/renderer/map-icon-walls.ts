import type { MapPoint } from './top-down-preview';
import { isVisiblePreviewObject } from './preview-materials';
import {
  coveredTiles,
  wallJoinDirections,
  wallJoinRole,
  wallJoins,
  type WallJoinObject,
} from './preview-wall-joins';

export const mapIconWallMetrics = Object.freeze({
  widthPixels: 8,
  outlinePixels: 1.5,
  towerWidths: 1.75,
  detailMinimumPixels: 7,
  towerSpacing: 1.5,
  gateTurretSpacing: 1.3,
  poleHeight: 1.35,
  flagWidth: 0.767125,
  flagHeight: 0.496375,
  stripWidth: 0.36,
  poleWidth: 1,
});

export type MapIconWallMaterial = 'stone' | 'wood';

export const mapIconWallColors = Object.freeze({
  stone: Object.freeze({
    outline: 0x2b2a27,
    wall: 0x8f8d86,
    strip: 0xa6a49c,
    door: 0x6b4a2a,
    merlons: 0xb3b0a6,
    floor: 0x67655f,
  }),
  wood: Object.freeze({
    outline: 0x2e1f12,
    wall: 0x8b6239,
    strip: 0xa57a4a,
    door: 0x4a311c,
    merlons: 0xa57c4f,
    floor: 0x5a3d22,
  }),
});

export const mapIconWoodWallObjectIds: ReadonlySet<number> = new Set([72, 119]);

export const mapIconWoodGateObjectIds: ReadonlySet<number> = new Set(
  Array.from({ length: 16 }, (_, index) => 789 + index),
);

export type MapIconWallTowerKind = 'end' | 'branch' | 'lone' | 'corner';

export interface MapIconWallLine {
  points: MapPoint[];
  owner: number;
  material: MapIconWallMaterial;
}

export interface MapIconWallTower {
  at: MapPoint;
  kind: MapIconWallTowerKind;
  material: MapIconWallMaterial;
}

export interface MapIconWallGate {
  ends: [MapPoint, MapPoint];
  owner: number;
  material: MapIconWallMaterial;
}

export interface MapIconWallPlan {
  lines: MapIconWallLine[];
  towers: MapIconWallTower[];
  gates: MapIconWallGate[];
}

export type MapIconWallObject = WallJoinObject & { objectId?: number };

export const mapIconWallCornerRunTiles = 3;
export const mapIconWallSmoothingTiles = 2;

function ownerKey(owner: number): number {
  return owner > 0 ? owner & 0xff : 0;
}

interface Node {
  key: number;
  x: number;
  y: number;
  owner: number;
  material: MapIconWallMaterial | null;
  piece: boolean;
  fixed: boolean;
  neighbours: number[];
}

export function mapIconWallPlan(
  allObjects: readonly MapIconWallObject[],
  width: number,
  height: number,
): MapIconWallPlan {
  const plan: MapIconWallPlan = { lines: [], towers: [], gates: [] };
  if (!(width > 0) || !(height > 0)) return plan;
  const objects = allObjects.filter(
    (object) =>
      object.objectId === undefined || isVisiblePreviewObject({ objectId: object.objectId }),
  );
  const tileCount = width * height;
  const occupied = new Set<number>();
  const gateTiles = new Set<number>();
  const gates: MapIconWallObject[] = [];
  for (const object of objects) {
    const role = wallJoinRole(object);
    if (!role) continue;
    if (role === 'gate') gates.push(object);
    const tiles = coveredTiles(object);
    const owner = ownerKey(object.owner) * tileCount;
    for (let y = Math.max(0, tiles.minimumY); y <= Math.min(height - 1, tiles.maximumY); y += 1) {
      for (let x = Math.max(0, tiles.minimumX); x <= Math.min(width - 1, tiles.maximumX); x += 1) {
        occupied.add(owner + y * width + x);
        if (role === 'gate') gateTiles.add(owner + y * width + x);
      }
    }
  }
  const has = (owner: number, x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && occupied.has(owner * tileCount + y * width + x);

  const nodes = new Map<number, Node>();
  const node = (owner: number, x: number, y: number): Node => {
    const key = owner * tileCount + y * width + x;
    let found = nodes.get(key);
    if (!found) {
      const fixed = gateTiles.has(key);
      found = { key, x, y, owner, material: null, piece: false, fixed, neighbours: [] };
      nodes.set(key, found);
    }
    return found;
  };
  const connect = (a: Node, b: Node) => {
    if (a.neighbours.includes(b.key)) return;
    a.neighbours.push(b.key);
    b.neighbours.push(a.key);
  };

  const joins = wallJoins(objects, width, height);
  for (const [position, bits] of [...joins].sort((a, b) => a[0] - b[0])) {
    const object = objects[position]!;
    const x = Math.floor(object.x);
    const y = Math.floor(object.y);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const owner = ownerKey(object.owner);
    const material = wallMaterial(object);
    const piece = node(owner, x, y);
    piece.piece = true;
    piece.material = material;
    for (const { dx, dy, bit } of wallJoinDirections) {
      if ((bits & bit) === 0) continue;
      const other = node(owner, x + dx, y + dy);
      const corner = dx !== 0 && dy !== 0 ? closedCorner(has, owner, x, y, dx, dy) : null;
      if (corner) {
        const closed = node(owner, corner.x, corner.y);
        closed.piece = true;
        closed.fixed = true;
        closed.material ??= material;
        connect(piece, closed);
        connect(closed, other);
      } else {
        connect(piece, other);
      }
    }
  }

  const sorted = [...nodes.values()].sort((a, b) => a.key - b.key);
  const step = (from: Node, to: Node) => [to.x - from.x, to.y - from.y] as const;
  const runLength = (start: Node, next: Node): number => {
    const [dx, dy] = step(start, next);
    let length = 1;
    let current = next;
    while (length < mapIconWallCornerRunTiles) {
      if (current.neighbours.length !== 2 || current.fixed) return Number.POSITIVE_INFINITY;
      const ahead = current.neighbours
        .map((key) => nodes.get(key)!)
        .find((candidate) => candidate.x - current.x === dx && candidate.y - current.y === dy);
      if (!ahead) return length;
      current = ahead;
      length += 1;
    }
    return length;
  };
  const corners = new Set<number>();
  for (const entry of sorted) {
    if (entry.neighbours.length !== 2 || entry.fixed) continue;
    const [first, second] = entry.neighbours.map((key) => nodes.get(key)!) as [Node, Node];
    const [ax, ay] = step(entry, first);
    const [bx, by] = step(entry, second);
    if (ax === -bx && ay === -by) continue;
    if (
      runLength(entry, first) >= mapIconWallCornerRunTiles &&
      runLength(entry, second) >= mapIconWallCornerRunTiles
    ) {
      corners.add(entry.key);
    }
  }
  const mixed = (entry: Node) =>
    entry.neighbours.some((key) => {
      const other = nodes.get(key)!;
      return other.material !== null && other.material !== entry.material;
    });
  const stops = (entry: Node) =>
    entry.neighbours.length !== 2 || entry.fixed || corners.has(entry.key) || mixed(entry);

  for (const entry of sorted) {
    if (!entry.piece) continue;
    const count = entry.neighbours.length;
    const turn = count === 2 && isTurn(entry, nodes);
    const kind: MapIconWallTowerKind | null =
      count === 0
        ? 'lone'
        : count === 1
          ? 'end'
          : count > 2
            ? 'branch'
            : turn && (corners.has(entry.key) || entry.fixed)
              ? 'corner'
              : null;
    if (kind) {
      plan.towers.push({
        at: { x: entry.x + 0.5, y: entry.y + 0.5 },
        kind,
        material: entry.material ?? 'stone',
      });
    }
  }

  const used = new Set<string>();
  const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const walk = (start: Node, next: Node): Node[] => {
    const chain = [start, next];
    used.add(edgeKey(start.key, next.key));
    let previous = start;
    let current = next;
    while (!stops(current) && current !== start) {
      const ahead = nodes.get(current.neighbours.find((key) => key !== previous.key)!)!;
      used.add(edgeKey(current.key, ahead.key));
      chain.push(ahead);
      previous = current;
      current = ahead;
    }
    return chain;
  };
  const byKey = (entry: Node) => [...entry.neighbours].sort((a, b) => a - b);
  for (const entry of sorted) {
    if (!stops(entry)) continue;
    for (const key of byKey(entry)) {
      if (used.has(edgeKey(entry.key, key))) continue;
      plan.lines.push(line(walk(entry, nodes.get(key)!), false));
    }
  }
  for (const entry of sorted) {
    const key = byKey(entry).find((candidate) => !used.has(edgeKey(entry.key, candidate)));
    if (key === undefined) continue;
    plan.lines.push(line(walk(entry, nodes.get(key)!), true));
  }

  const gateOrder = (gate: MapIconWallObject) =>
    [ownerKey(gate.owner), gate.y, gate.x, gate.footprintWidth, gate.footprintHeight] as const;
  const joinedGates = joinGatePieces(gates);
  joinedGates.sort((a, b) => {
    const left = gateOrder(a);
    const right = gateOrder(b);
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return left[index]! - right[index]!;
    }
    return 0;
  });
  for (const gate of joinedGates) {
    const owner = ownerKey(gate.owner);
    plan.gates.push({
      ends: gateTurrets(gate, owner, has),
      owner,
      material: gateMaterial(gate, owner, nodes, tileCount, width, height),
    });
  }
  return plan;
}

function joinGatePieces(pieces: readonly MapIconWallObject[]): MapIconWallObject[] {
  const tiles = pieces.map((piece) => coveredTiles(piece));
  const parent = pieces.map((_, index) => index);
  const root = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }
    return index;
  };
  for (let a = 0; a < pieces.length; a += 1) {
    for (let b = a + 1; b < pieces.length; b += 1) {
      if (ownerKey(pieces[a]!.owner) !== ownerKey(pieces[b]!.owner)) continue;
      const first = tiles[a]!;
      const second = tiles[b]!;
      const touch =
        first.minimumX <= second.maximumX + 1 &&
        second.minimumX <= first.maximumX + 1 &&
        first.minimumY <= second.maximumY + 1 &&
        second.minimumY <= first.maximumY + 1;
      if (touch) parent[root(b)] = root(a);
    }
  }
  const groups = new Map<number, number[]>();
  pieces.forEach((_, index) => {
    const key = root(index);
    const group = groups.get(key);
    if (group) group.push(index);
    else groups.set(key, [index]);
  });
  const joined: MapIconWallObject[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      joined.push(pieces[group[0]!]!);
      continue;
    }
    const minimumX = Math.min(...group.map((index) => tiles[index]!.minimumX));
    const maximumX = Math.max(...group.map((index) => tiles[index]!.maximumX));
    const minimumY = Math.min(...group.map((index) => tiles[index]!.minimumY));
    const maximumY = Math.max(...group.map((index) => tiles[index]!.maximumY));
    const area = (index: number) =>
      (tiles[index]!.maximumX - tiles[index]!.minimumX + 1) *
      (tiles[index]!.maximumY - tiles[index]!.minimumY + 1);
    const largest = group.reduce((best, index) => (area(index) > area(best) ? index : best));
    const footprintWidth = maximumX - minimumX + 1;
    const footprintHeight = maximumY - minimumY + 1;
    joined.push({
      ...pieces[largest]!,
      x: minimumX + footprintWidth / 2,
      y: minimumY + footprintHeight / 2,
      footprintWidth,
      footprintHeight,
    });
  }
  return joined;
}

function wallMaterial(object: MapIconWallObject): MapIconWallMaterial {
  return object.objectId !== undefined && mapIconWoodWallObjectIds.has(object.objectId)
    ? 'wood'
    : 'stone';
}

function line(chain: readonly Node[], closed: boolean): MapIconWallLine {
  const inner = chain.length > 2 ? chain.slice(1, -1) : chain;
  const pieces = inner.filter((entry) => entry.material !== null);
  const counted = pieces.length > 0 ? pieces : chain.filter((entry) => entry.material !== null);
  const wood = counted.filter((entry) => entry.material === 'wood').length;
  const stone = counted.length - wood;
  const material: MapIconWallMaterial =
    wood > stone ? 'wood' : stone > wood ? 'stone' : (counted[0]?.material ?? 'stone');
  return { points: smoothChain(chain, closed), owner: chain[0]!.owner, material };
}

function gateMaterial(
  gate: MapIconWallObject,
  owner: number,
  nodes: ReadonlyMap<number, Node>,
  tileCount: number,
  width: number,
  height: number,
): MapIconWallMaterial {
  const tiles = coveredTiles(gate);
  let wood = 0;
  let stone = 0;
  for (let y = Math.max(0, tiles.minimumY); y <= Math.min(height - 1, tiles.maximumY); y += 1) {
    for (let x = Math.max(0, tiles.minimumX); x <= Math.min(width - 1, tiles.maximumX); x += 1) {
      const entry = nodes.get(owner * tileCount + y * width + x);
      for (const key of entry?.neighbours ?? []) {
        const material = nodes.get(key)!.material;
        if (material === 'wood') wood += 1;
        else if (material === 'stone') stone += 1;
      }
    }
  }
  if (wood !== stone) return wood > stone ? 'wood' : 'stone';
  return gate.objectId !== undefined && mapIconWoodGateObjectIds.has(gate.objectId)
    ? 'wood'
    : 'stone';
}

function isTurn(entry: Node, nodes: ReadonlyMap<number, Node>): boolean {
  const [first, second] = entry.neighbours.map((key) => nodes.get(key)!) as [Node, Node];
  return !(first.x - entry.x === entry.x - second.x && first.y - entry.y === entry.y - second.y);
}

function smoothChain(chain: readonly Node[], closed: boolean): MapPoint[] {
  const points = chain.map((entry) => ({ x: entry.x + 0.5, y: entry.y + 0.5 }));
  const count = closed ? points.length - 1 : points.length;
  if (count < 3) return points;
  const smoothed: MapPoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const reach = closed
      ? Math.min(mapIconWallSmoothingTiles, Math.floor((count - 1) / 2))
      : Math.min(mapIconWallSmoothingTiles, index, points.length - 1 - index);
    if (reach === 0) {
      smoothed.push(points[index]!);
      continue;
    }
    let x = 0;
    let y = 0;
    for (let offset = -reach; offset <= reach; offset += 1) {
      const at = closed
        ? points[(((index + offset) % count) + count) % count]!
        : points[index + offset]!;
      x += at.x;
      y += at.y;
    }
    smoothed.push({ x: x / (2 * reach + 1), y: y / (2 * reach + 1) });
  }
  return smoothed;
}

function closedCorner(
  has: (owner: number, x: number, y: number) => boolean,
  owner: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
): MapPoint | null {
  const nextX = x + dx;
  const nextY = y + dy;
  if (has(owner, x - dx, y) && has(owner, nextX, nextY + dy)) return { x: nextX, y };
  if (has(owner, x, y - dy) && has(owner, nextX + dx, nextY)) return { x, y: nextY };
  return null;
}

function gateTurrets(
  gate: MapIconWallObject,
  owner: number,
  has: (owner: number, x: number, y: number) => boolean,
): [MapPoint, MapPoint] {
  const tiles = coveredTiles(gate);
  const left = tiles.minimumX + 0.5;
  const right = tiles.maximumX + 0.5;
  const top = tiles.minimumY + 0.5;
  const bottom = tiles.maximumY + 0.5;
  const columns = tiles.maximumX - tiles.minimumX + 1;
  const rows = tiles.maximumY - tiles.minimumY + 1;
  const middleX = (left + right) / 2;
  const middleY = (top + bottom) / 2;
  const { minimumX, maximumX, minimumY, maximumY } = tiles;
  const score = (points: readonly (readonly [number, number])[]) =>
    points.filter(([x, y]) => has(owner, x, y)).length;
  if (columns === rows) {
    if (columns === 1) {
      const alongX = score([
        [minimumX - 1, minimumY],
        [minimumX + 1, minimumY],
      ]);
      const alongY = score([
        [minimumX, minimumY - 1],
        [minimumX, minimumY + 1],
      ]);
      const half = 0.45;
      return alongY > alongX
        ? [
            { x: middleX, y: middleY - half },
            { x: middleX, y: middleY + half },
          ]
        : [
            { x: middleX - half, y: middleY },
            { x: middleX + half, y: middleY },
          ];
    }
    const falling = score([
      [minimumX - 1, minimumY - 1],
      [maximumX + 1, maximumY + 1],
    ]);
    const rising = score([
      [maximumX + 1, minimumY - 1],
      [minimumX - 1, maximumY + 1],
    ]);
    return rising > falling
      ? [
          { x: right, y: top },
          { x: left, y: bottom },
        ]
      : [
          { x: left, y: top },
          { x: right, y: bottom },
        ];
  }
  return columns > rows
    ? [
        { x: left, y: middleY },
        { x: right, y: middleY },
      ]
    : [
        { x: middleX, y: top },
        { x: middleX, y: bottom },
      ];
}

export interface MapIconWallSizes {
  width: number;
  outline: number;
  tower: number;
}

export function mapIconWallSizes(pixelScale: number, sizePercent: number): MapIconWallSizes {
  const scale = pixelScale * (sizePercent / 100);
  const width = mapIconWallMetrics.widthPixels * scale;
  return {
    width,
    outline: Math.max(pixelScale, mapIconWallMetrics.outlinePixels * scale),
    tower: width * mapIconWallMetrics.towerWidths,
  };
}

export function mapIconWallSquare(
  centerX: number,
  centerY: number,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  component: number,
  verticalComponent: number,
): number[] {
  const edge = (2 * component * verticalComponent) / Math.hypot(component, verticalComponent) || 1;
  const points: number[] = [];
  for (const [u, v] of [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ] as const) {
    const deltaX = u / edge;
    const deltaY = v / edge;
    points.push(
      centerX + (deltaX + deltaY) * component,
      centerY + (deltaY - deltaX) * verticalComponent,
    );
  }
  return points;
}

export interface MapIconWallFill {
  points: number[];
  color: number;
}

export function mapIconWallTowerFills(
  centerX: number,
  centerY: number,
  sizes: MapIconWallSizes,
  component: number,
  verticalComponent: number,
  material: MapIconWallMaterial = 'stone',
): MapIconWallFill[] {
  const colors = mapIconWallColors[material];
  const half = sizes.tower / 2;
  const inner = Math.max(half - sizes.outline, half / 2);
  const square = (u0: number, v0: number, u1: number, v1: number) =>
    mapIconWallSquare(centerX, centerY, u0, v0, u1, v1, component, verticalComponent);
  const fills: MapIconWallFill[] = [
    { points: square(-half, -half, half, half), color: colors.outline },
    { points: square(-inner, -inner, inner, inner), color: colors.merlons },
  ];
  if (sizes.tower < mapIconWallMetrics.detailMinimumPixels) return fills;
  const floor = inner * 0.5;
  const gap = inner * 0.22;
  const color = colors.floor;
  fills.push(
    { points: square(-floor, -floor, floor, floor), color },
    { points: square(-gap, floor, gap, inner), color },
    { points: square(-gap, -inner, gap, -floor), color },
    { points: square(floor, -gap, inner, gap), color },
    { points: square(-inner, -gap, -floor, gap), color },
  );
  return fills;
}

export function mapIconWallFlagFills(
  centerX: number,
  centerY: number,
  sizes: MapIconWallSizes,
  color: number,
): MapIconWallFill[] {
  const pole = Math.max(sizes.outline * mapIconWallMetrics.poleWidth, 1);
  const height = sizes.tower * mapIconWallMetrics.poleHeight;
  const flagWidth = sizes.tower * mapIconWallMetrics.flagWidth;
  const flagHeight = sizes.tower * mapIconWallMetrics.flagHeight;
  const top = centerY - height;
  const rect = (left: number, upper: number, right: number, lower: number) => [
    left,
    upper,
    right,
    upper,
    right,
    lower,
    left,
    lower,
  ];
  const poleLeft = centerX - pole / 2;
  const poleRight = centerX + pole / 2;
  const border = Math.max(sizes.outline * 0.75, 1);
  const outline = mapIconWallColors.stone.outline;
  return [
    { points: rect(poleLeft, top, poleRight, centerY), color: outline },
    {
      points: rect(poleRight, top, poleRight + flagWidth, top + flagHeight),
      color: outline,
    },
    {
      points: rect(
        poleRight,
        top + border,
        poleRight + flagWidth - border,
        top + flagHeight - border,
      ),
      color,
    },
  ];
}
