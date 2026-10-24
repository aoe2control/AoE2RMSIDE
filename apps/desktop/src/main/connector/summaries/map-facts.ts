import type { CompactMap } from '../app-map-store';
import { round1, whole } from './budget';

export const startRadius = 25;
const clusterDistance = 2;
const clusterObjectLimit = 4_000;

export const objectKinds = [
  'villager',
  'scout',
  'sheep',
  'gold',
  'stone',
  'berries',
  'boar',
  'deer',
  'wolves',
  'relics',
  'fish',
  'trees',
] as const;
export type ObjectKind = (typeof objectKinds)[number];

export const startKinds: readonly ObjectKind[] = [
  'villager',
  'scout',
  'sheep',
  'gold',
  'stone',
  'berries',
  'boar',
  'deer',
  'wolves',
  'relics',
  'fish',
];

const unitKinds = new Set<ObjectKind>(['villager', 'scout']);
const pileKinds = new Set<ObjectKind>(['gold', 'stone', 'berries']);

const neutralKinds: readonly { label: string; kinds: readonly ObjectKind[]; piles: boolean }[] = [
  { label: 'relics', kinds: ['relics'], piles: false },
  { label: 'gold piles', kinds: ['gold'], piles: true },
  { label: 'stone piles', kinds: ['stone'], piles: true },
  { label: 'hunt', kinds: ['deer', 'boar'], piles: false },
  { label: 'fish', kinds: ['fish'], piles: false },
];

const resourceFood = 0;
const resourceStone = 2;
const resourceGold = 3;

export function objectKind(
  classId: number | undefined,
  resourceType: number,
  amount: number,
): ObjectKind | null {
  switch (classId) {
    case 4:
      return 'villager';
    case 47:
      return 'scout';
    case 58:
      return 'sheep';
    case 32:
      return 'gold';
    case 8:
      return 'stone';
    case 7:
      return 'berries';
    case 9:
      return 'deer';
    case 10:
      return resourceType === resourceFood && amount > 0 ? 'boar' : 'wolves';
    case 42:
      return 'relics';
    case 5:
    case 31:
    case 33:
    case 63:
      return 'fish';
    case 15:
      return 'trees';
    case undefined:
      if (resourceType === resourceGold) return 'gold';
      if (resourceType === resourceStone) return 'stone';
      return null;
    default:
      return null;
  }
}

export function mapObjectKinds(map: CompactMap): (ObjectKind | null)[] {
  const kinds: (ObjectKind | null)[] = [];
  for (let index = 0; index < map.objects.count; index += 1) {
    kinds.push(
      objectKind(
        map.classes.get(map.objects.ids[index]!),
        map.objects.resourceTypes[index]!,
        map.objects.amounts[index]!,
      ),
    );
  }
  return kinds;
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

export function pileSizes(points: readonly [number, number][]): number[] {
  if (points.length > clusterObjectLimit) return [points.length];
  const parent = points.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }
    return index;
  };
  for (let a = 0; a < points.length; a += 1) {
    for (let b = a + 1; b < points.length; b += 1) {
      if (distance(points[a]![0], points[a]![1], points[b]![0], points[b]![1]) <= clusterDistance) {
        parent[find(a)] = find(b);
      }
    }
  }
  const sizes = new Map<number, number>();
  for (let index = 0; index < points.length; index += 1) {
    const root = find(index);
    sizes.set(root, (sizes.get(root) ?? 0) + 1);
  }
  return [...sizes.values()].sort((a, b) => b - a);
}

export interface StartKindFacts {
  n: number;
  nearest?: number;
  farthest?: number;
  piles?: number[];
}

export interface PlayerStartFacts {
  p: number;
  team: number;
  start: [number, number] | null;
  kinds: Partial<Record<ObjectKind, StartKindFacts>>;
}

export function startFacts(map: CompactMap, kinds = mapObjectKinds(map)): PlayerStartFacts[] {
  return map.players.map((player) => {
    const facts: PlayerStartFacts = {
      p: player.p,
      team: player.team,
      start: player.start,
      kinds: {},
    };
    if (!player.start) return facts;
    const [sx, sy] = player.start;
    const points = new Map<ObjectKind, [number, number][]>();
    for (let index = 0; index < map.objects.count; index += 1) {
      const kind = kinds[index];
      if (!kind || kind === 'trees') continue;
      const owner = map.objects.owners[index]!;
      if (owner !== 0 && owner !== player.p) continue;
      const x = map.objects.x[index]!;
      const y = map.objects.y[index]!;
      const d = distance(sx, sy, x, y);
      if (d > startRadius) continue;
      const entry = (facts.kinds[kind] ??= { n: 0 });
      entry.n += 1;
      entry.nearest = entry.nearest === undefined ? d : Math.min(entry.nearest, d);
      entry.farthest = entry.farthest === undefined ? d : Math.max(entry.farthest, d);
      if (pileKinds.has(kind)) {
        const list = points.get(kind) ?? [];
        list.push([x, y]);
        points.set(kind, list);
      }
    }
    for (const [kind, list] of points) facts.kinds[kind]!.piles = pileSizes(list);
    return facts;
  });
}

function countText(facts: StartKindFacts): string {
  return facts.piles && facts.piles.length > 1 ? facts.piles.join('+') : String(facts.n);
}

export interface StartObjectsSummary {
  same: string;
  differs: { what: string; per_player: number[]; note?: string }[];
  more: number;
}

export function startObjectsSummary(facts: readonly PlayerStartFacts[]): StartObjectsSummary {
  const players = facts.filter((player) => player.start);
  const same: string[] = [];
  const differs: StartObjectsSummary['differs'] = [];
  let more = 0;
  if (players.length === 0) return { same: '', differs, more };
  for (const kind of startKinds) {
    const counts = players.map((player) => player.kinds[kind]?.n ?? 0);
    if (counts.every((count) => count === 0)) continue;
    if (counts.every((count) => count === counts[0])) {
      const entries = players.map((player) => player.kinds[kind]!);
      const piles = entries.map((entry) => countText(entry));
      const count = piles.every((text) => text === piles[0]) ? piles[0]! : String(counts[0]);
      if (unitKinds.has(kind)) {
        same.push(`${kind} ${count}`);
      } else {
        const nearest = Math.min(...entries.map((entry) => entry.nearest ?? 0));
        const farthest = Math.max(...entries.map((entry) => entry.farthest ?? 0));
        const band =
          whole(nearest) === whole(farthest)
            ? `${whole(nearest)}`
            : `${whole(nearest)}-${whole(farthest)}`;
        same.push(`${kind} ${count} (${band})`);
      }
      continue;
    }
    if (differs.length >= 6) {
      more += 1;
      continue;
    }
    const missing = players.filter((player) => (player.kinds[kind]?.n ?? 0) === 0);
    const perPlayer = facts.map((player) => (player.start ? (player.kinds[kind]?.n ?? 0) : 0));
    differs.push({
      what: kind,
      per_player: perPlayer,
      ...(missing.length > 0
        ? {
            note: `${missing.length === 1 ? 'player' : 'players'} ${missing
              .map((player) => player.p)
              .join(
                ', ',
              )} ${missing.length === 1 ? 'has' : 'have'} no ${kind} within ${startRadius}`,
          }
        : {}),
    });
  }
  return { same: same.join(', '), differs, more };
}

export function neutralShares(
  map: CompactMap,
  kinds = mapObjectKinds(map),
): Record<string, number[]> {
  const starts = map.players.map((player) => player.start);
  if (!starts.some((start) => start)) return {};
  const shares: Record<string, number[]> = {};
  for (const group of neutralKinds) {
    const perPlayer: [number, number][][] = map.players.map(() => []);
    let present = false;
    for (let index = 0; index < map.objects.count; index += 1) {
      const kind = kinds[index];
      if (!kind || !group.kinds.includes(kind) || map.objects.owners[index] !== 0) continue;
      const x = map.objects.x[index]!;
      const y = map.objects.y[index]!;
      let best = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      let nearStart = false;
      starts.forEach((start, player) => {
        if (!start) return;
        const d = distance(start[0], start[1], x, y);
        if (d <= startRadius) nearStart = true;
        if (d < bestDistance) {
          bestDistance = d;
          best = player;
        }
      });
      if (nearStart || best < 0) continue;
      perPlayer[best]!.push([x, y]);
      present = true;
    }
    if (!present) continue;
    shares[group.label] = perPlayer.map((points) =>
      group.piles ? pileSizes(points).length : points.length,
    );
  }
  return shares;
}

export interface TerrainShare {
  name: string;
  tiles: number;
  pct: number;
}

export function terrainShares(
  map: CompactMap,
  include?: (index: number) => boolean,
): TerrainShare[] {
  const counts = new Map<number, number>();
  let total = 0;
  for (let index = 0; index < map.terrain.length; index += 1) {
    if (include && !include(index)) continue;
    const terrain = map.terrain[index]!;
    counts.set(terrain, (counts.get(terrain) ?? 0) + 1);
    total += 1;
  }
  return [...counts.entries()]
    .map(([terrain, tiles]) => ({
      name: map.terrainNames.get(terrain) ?? `terrain ${terrain}`,
      tiles,
      pct: total === 0 ? 0 : round1((tiles * 100) / total),
    }))
    .sort((a, b) => b.tiles - a.tiles || a.name.localeCompare(b.name));
}

export function terrainText(shares: readonly TerrainShare[], maximum = 6): string {
  const shown = shares.filter((share) => whole(share.pct) >= 1).slice(0, maximum);
  const parts = shown.map((share) => `${share.name} ${whole(share.pct)}%`);
  const rest = 100 - shown.reduce((sum, share) => sum + share.pct, 0);
  if (shares.length > shown.length && whole(rest) >= 1) parts.push(`other ${whole(rest)}%`);
  return parts.join(', ');
}

export function objectName(map: CompactMap, objectId: number): string {
  return map.objectNames.get(objectId) ?? `object ${objectId}`;
}
