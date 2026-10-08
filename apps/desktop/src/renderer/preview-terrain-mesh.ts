import type {
  PreviewGenerationResult,
  SelectedMinimapPalette,
  TerrainMinimapColor,
} from '../shared/api';
import { terrainMaterial } from './preview-materials';
import type { VisibleChunk } from './top-down-preview';

export type ElevationDisplayMode = 'off' | 'terrain' | 'height-map';

export interface TerrainMeshScene {
  width: number;
  height: number;
  elevations: ArrayLike<number>;
}

export interface ElevationRange {
  maximum: number;
  minimum: number;
}

export interface TerrainChunkPresentation {
  backgroundColor: number;
  elevationMode: ElevationDisplayMode;
  elevationRange: ElevationRange;
  minimapPalette?: SelectedMinimapPalette | null;
  terrainNames?: PreviewGenerationResult['terrainNames'];
  localTerrainColors?: readonly TerrainMinimapColor[];
  lookTerrainColors?: ReadonlyMap<number, number>;
}

export interface TerrainChunkGeometry {
  alpha: number;
  color: number;
  indices: Uint32Array;
  layer: 'base' | 'height-overlay';
  positions: Float32Array;
  tileCount: number;
}

interface TerrainTilePresentation {
  alpha: number;
  color: number;
  layer: TerrainChunkGeometry['layer'];
}

export function buildTerrainChunkGeometry(
  scene: TerrainMeshScene,
  terrainIds: ArrayLike<number>,
  backend: PreviewGenerationResult['backend'],
  chunk: VisibleChunk,
  presentation: TerrainChunkPresentation = {
    backgroundColor: 0,
    elevationMode: 'off',
    elevationRange: terrainElevationRange(scene.elevations),
  },
): TerrainChunkGeometry[] {
  const baseColors = new Map<number, number>();
  const baseColor = (terrainId: number): number => {
    let color = baseColors.get(terrainId);
    if (color === undefined) {
      color = terrainMaterial(
        terrainId,
        backend,
        presentation.minimapPalette ?? null,
        presentation.terrainNames ?? [],
        undefined,
        presentation.localTerrainColors,
        presentation.lookTerrainColors,
      ).color;
      baseColors.set(terrainId, color);
    }
    return color;
  };
  const tileCounts = new Map<
    string,
    { presentation: TerrainTilePresentation; tileCount: number }
  >();
  for (let y = chunk.minimumY; y <= chunk.maximumY; y += 1) {
    for (let x = chunk.minimumX; x <= chunk.maximumX; x += 1) {
      const terrainId = terrainIds[y * scene.width + x];
      if (terrainId === undefined) continue;
      for (const tilePresentation of terrainTilePresentations(
        scene,
        baseColor(terrainId),
        x,
        y,
        presentation,
      )) {
        const key = presentationKey(tilePresentation);
        const current = tileCounts.get(key);
        tileCounts.set(key, {
          presentation: tilePresentation,
          tileCount: (current?.tileCount ?? 0) + 1,
        });
      }
    }
  }

  const geometryByPresentation = new Map<string, TerrainChunkGeometry>();
  const tileOffsets = new Map<string, number>();
  for (const [key, { presentation: tilePresentation, tileCount }] of tileCounts) {
    geometryByPresentation.set(key, {
      ...tilePresentation,
      indices: new Uint32Array(tileCount * 6),
      positions: new Float32Array(tileCount * 8),
      tileCount,
    });
    tileOffsets.set(key, 0);
  }

  for (let y = chunk.minimumY; y <= chunk.maximumY; y += 1) {
    for (let x = chunk.minimumX; x <= chunk.maximumX; x += 1) {
      const terrainId = terrainIds[y * scene.width + x];
      if (terrainId === undefined) continue;
      for (const tilePresentation of terrainTilePresentations(
        scene,
        baseColor(terrainId),
        x,
        y,
        presentation,
      )) {
        const key = presentationKey(tilePresentation);
        const geometry = geometryByPresentation.get(key)!;
        const tileOffset = tileOffsets.get(key)!;
        const positionOffset = tileOffset * 8;
        const indexOffset = tileOffset * 6;
        const vertexOffset = tileOffset * 4;
        const sum = x + y;
        const difference = y - x;
        geometry.positions.set(
          [sum, difference, sum + 1, difference + 1, sum + 2, difference, sum + 1, difference - 1],
          positionOffset,
        );
        geometry.indices.set(
          [
            vertexOffset,
            vertexOffset + 1,
            vertexOffset + 2,
            vertexOffset,
            vertexOffset + 2,
            vertexOffset + 3,
          ],
          indexOffset,
        );
        tileOffsets.set(key, tileOffset + 1);
      }
    }
  }

  return [...geometryByPresentation.values()].sort(
    (left, right) =>
      layerOrder(left.layer) - layerOrder(right.layer) ||
      left.color - right.color ||
      left.alpha - right.alpha,
  );
}

export function terrainElevationRange(elevations: ArrayLike<number>): ElevationRange {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < elevations.length; index += 1) {
    const elevation = elevations[index]!;
    if (!Number.isFinite(elevation)) continue;
    minimum = Math.min(minimum, elevation);
    maximum = Math.max(maximum, elevation);
  }
  return Number.isFinite(minimum) && Number.isFinite(maximum)
    ? { maximum, minimum }
    : { maximum: 0, minimum: 0 };
}

function terrainTilePresentations(
  scene: TerrainMeshScene,
  baseColor: number,
  x: number,
  y: number,
  presentation: TerrainChunkPresentation,
): TerrainTilePresentation[] {
  const base = { alpha: 1, color: baseColor, layer: 'base' } as const;
  if (presentation.elevationMode === 'off') return [base];
  const elevation = elevationAt(scene, x, y, 0);
  if (presentation.elevationMode === 'height-map') {
    const alpha = heightOverlayAlpha(elevation, presentation.elevationRange);
    return alpha === 0
      ? [base]
      : [
          base,
          {
            alpha,
            color: presentation.backgroundColor,
            layer: 'height-overlay',
          },
        ];
  }

  return [{ ...base, color: shadeTerrainColor(baseColor, terrainReliefShadeLevel(scene, x, y)) }];
}

export function terrainElevationOverlay(
  scene: TerrainMeshScene,
  x: number,
  y: number,
  presentation: Pick<
    TerrainChunkPresentation,
    'backgroundColor' | 'elevationMode' | 'elevationRange'
  >,
): { color: number; alpha: number } | null {
  if (presentation.elevationMode === 'off') return null;
  if (presentation.elevationMode === 'height-map') {
    const alpha = heightOverlayAlpha(elevationAt(scene, x, y, 0), presentation.elevationRange);
    return alpha === 0 ? null : { color: presentation.backgroundColor, alpha };
  }
  const level = terrainReliefShadeLevel(scene, x, y);
  if (level === 0) return null;
  return { color: level > 0 ? 0xffffff : 0x000000, alpha: Math.min(0.2, Math.abs(level) * 0.065) };
}

export function terrainReliefShadeLevel(scene: TerrainMeshScene, x: number, y: number): number {
  const elevation = elevationAt(scene, x, y, 0);
  const west = elevationAt(scene, x - 1, y, elevation);
  const north = elevationAt(scene, x, y - 1, elevation);
  const east = elevationAt(scene, x + 1, y, elevation);
  const south = elevationAt(scene, x, y + 1, elevation);
  const lightFacingSlope = west + south - east - north;
  return Math.round(clamp(lightFacingSlope, -3, 3));
}

export function heightOverlayAlpha(elevation: number, range: ElevationRange): number {
  const span = range.maximum - range.minimum;
  if (span <= 0) return 0.8;
  const rawAlpha = (1 - clamp((elevation - range.minimum) / span, 0, 1)) * 0.8;
  if (span <= 16) return rawAlpha;
  return Math.round(rawAlpha * 20) / 20;
}

function presentationKey(presentation: TerrainTilePresentation): string {
  return `${presentation.layer}:${presentation.color}:${presentation.alpha.toFixed(6)}`;
}

function layerOrder(layer: TerrainChunkGeometry['layer']): number {
  return layer === 'base' ? 0 : 1;
}

function elevationAt(scene: TerrainMeshScene, x: number, y: number, fallback: number): number {
  if (x < 0 || y < 0 || x >= scene.width || y >= scene.height) return fallback;
  return scene.elevations[y * scene.width + x] ?? fallback;
}

export function shadeTerrainColor(color: number, shadeLevel: number): number {
  if (shadeLevel === 0) return color;
  const target = shadeLevel > 0 ? 0xffffff : 0x000000;
  const amount = Math.min(0.2, Math.abs(shadeLevel) * 0.065);
  const red = mixChannel((color >> 16) & 0xff, (target >> 16) & 0xff, amount);
  const green = mixChannel((color >> 8) & 0xff, (target >> 8) & 0xff, amount);
  const blue = mixChannel(color & 0xff, target & 0xff, amount);
  return (red << 16) | (green << 8) | blue;
}

function mixChannel(source: number, target: number, amount: number): number {
  return Math.round(source + (target - source) * amount);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
