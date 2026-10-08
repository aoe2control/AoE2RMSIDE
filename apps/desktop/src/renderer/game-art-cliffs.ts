import { Container, Graphics } from 'pixi.js';
import type { CliffPieceRecord, GameArtSpriteSet } from '../shared/game-art';
import type { MapPoint } from './top-down-preview';

export const cliffLegDirections: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

export const cliffNodeSpacing = 3;
const nodeCentre = 1.5;

export interface CliffLeg {
  side: number;
  dx: number;
  dy: number;
  lowX: number;
  lowY: number;
  from: MapPoint;
  to: MapPoint;
}

export function cliffLegs(piece: CliffPieceRecord): CliffLeg[] {
  const nodeX = Math.floor(piece.x / cliffNodeSpacing) * cliffNodeSpacing + nodeCentre;
  const nodeY = Math.floor(piece.y / cliffNodeSpacing) * cliffNodeSpacing + nodeCentre;
  const legs: CliffLeg[] = [];
  for (const [side, [dx, dy]] of cliffLegDirections.entries()) {
    const sign = piece.edges[side] ?? 0;
    if (sign === 0) continue;
    const horizontal = dy === 0;
    const lowX = horizontal ? 0 : -sign;
    const lowY = horizontal ? sign : 0;
    legs.push({
      side,
      dx,
      dy,
      lowX,
      lowY,
      from: { x: piece.x, y: piece.y },
      to: {
        x: nodeX + (dx * cliffNodeSpacing) / 2,
        y: nodeY + (dy * cliffNodeSpacing) / 2,
      },
    });
  }
  return legs;
}

export type CliffBandPart = 'shadow' | 'crest' | 'face' | 'foot';

export interface CliffBandPolygon {
  part: CliffBandPart;
  points: MapPoint[];
}

export const cliffBandHalfWidth = 0.6;
export const cliffShadowWidth = 0.55;

function offsetQuad(
  from: MapPoint,
  to: MapPoint,
  nx: number,
  ny: number,
  near: number,
  far: number,
) {
  return [
    { x: from.x + nx * near, y: from.y + ny * near },
    { x: to.x + nx * near, y: to.y + ny * near },
    { x: to.x + nx * far, y: to.y + ny * far },
    { x: from.x + nx * far, y: from.y + ny * far },
  ];
}

export function cliffBandPolygons(piece: CliffPieceRecord): CliffBandPolygon[] {
  const polygons: CliffBandPolygon[] = [];
  const half = cliffBandHalfWidth;
  const legs = cliffLegs(piece);
  for (const leg of legs) {
    const { to, lowX, lowY } = leg;
    const back = legs.length === 1 ? half : 0;
    const from = { x: leg.from.x - leg.dx * back, y: leg.from.y - leg.dy * back };
    polygons.push(
      { part: 'shadow', points: offsetQuad(from, to, lowX, lowY, half, half + cliffShadowWidth) },
      { part: 'crest', points: offsetQuad(from, to, -lowX, -lowY, 0, half) },
      { part: 'face', points: offsetQuad(from, to, lowX, lowY, 0, half / 2) },
      { part: 'foot', points: offsetQuad(from, to, lowX, lowY, half / 2, half) },
    );
  }
  const [a, b] = legs;
  if (legs.length === 2 && a && b && a.dx * b.dx + a.dy * b.dy === 0) {
    const ox = -(a.dx + b.dx);
    const oy = -(a.dy + b.dy);
    const outsideLow = a.lowX * ox + a.lowY * oy > 0;
    const p = { x: piece.x, y: piece.y };
    const at = (u: number, v: number) => ({ x: p.x + ox * u, y: p.y + oy * v });
    const square = (size: number) => [at(0, 0), at(size, 0), at(size, size), at(0, size)];
    const ring = (inner: number, outer: number) => [
      at(inner, 0),
      at(outer, 0),
      at(outer, outer),
      at(0, outer),
      at(0, inner),
      at(inner, inner),
    ];
    if (outsideLow) {
      polygons.push(
        { part: 'shadow', points: ring(half, half + cliffShadowWidth) },
        { part: 'face', points: square(half / 2) },
        { part: 'foot', points: ring(half / 2, half) },
      );
    } else {
      polygons.push({ part: 'crest', points: square(half) });
    }
  }
  return polygons;
}
export const cliffBandPaintOrder: readonly CliffBandPart[] = ['shadow', 'crest', 'face', 'foot'];

export function shadeColor(color: number, amount: number): number {
  const channel = (shift: number) => {
    const value = (color >> shift) & 0xff;
    const target = amount >= 0 ? 255 : 0;
    return Math.round(value + (target - value) * Math.min(1, Math.abs(amount)));
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

export function cliffBandFill(part: CliffBandPart, rock: number): { color: number; alpha: number } {
  switch (part) {
    case 'shadow':
      return { color: 0x000000, alpha: 0.2 };
    case 'crest':
      return { color: shadeColor(rock, 0.16), alpha: 1 };
    case 'face':
      return { color: shadeColor(rock, -0.22), alpha: 1 };
    default:
      return { color: shadeColor(rock, -0.45), alpha: 1 };
  }
}
export const fallbackCliffColor = 0x8b8173;

export function cliffColors(
  set: GameArtSpriteSet | null,
  pieces: readonly CliffPieceRecord[],
): Map<number, number> {
  const colors = new Map<number, number>();
  if (!set) return colors;
  const objects = new Map(
    set.objects
      .filter((entry) => entry.civilizationId === 0)
      .map((entry) => [entry.objectId, entry]),
  );
  const graphics = new Map(set.graphics.map((graphic) => [graphic.id, graphic]));
  for (const piece of pieces) {
    if (colors.has(piece.objectId)) continue;
    const graphic = graphics.get(objects.get(piece.objectId)?.parts[0]?.graphic ?? -1);
    const color =
      graphic?.facings[piece.facet]?.averageColor ??
      graphic?.facings.find((facing) => facing.averageColor !== null)?.averageColor;
    if (color !== undefined && color !== null) colors.set(piece.objectId, color);
  }
  return colors;
}

function local(point: MapPoint): [number, number] {
  return [point.x + point.y, point.y - point.x];
}

export class GameArtCliffBandLayer {
  readonly container = new Container({ label: 'game-textures-cliff-bands' });
  readonly pieceCount: number;

  constructor(pieces: readonly CliffPieceRecord[], colors: ReadonlyMap<number, number>) {
    this.container.eventMode = 'none';
    const graphics = new Graphics();
    graphics.eventMode = 'none';
    const polygons = pieces.map((piece) => ({
      rock: colors.get(piece.objectId) ?? fallbackCliffColor,
      polygons: cliffBandPolygons(piece),
    }));
    for (const part of cliffBandPaintOrder) {
      for (const { rock, polygons: shapes } of polygons) {
        for (const polygon of shapes) {
          if (polygon.part !== part) continue;
          this.paint(graphics, polygon, rock);
        }
      }
    }
    this.pieceCount = pieces.length;
    this.container.addChild(graphics);
  }

  private paint(graphics: Graphics, polygon: CliffBandPolygon, rock: number): void {
    const flat = polygon.points.flatMap(local);
    const fill = cliffBandFill(polygon.part, rock);
    graphics.poly(flat).fill(fill);
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
