import type { PreviewGenerationResult } from '../shared/api';
import { terrainMaterial } from './preview-materials';
import {
  heightOverlayAlpha,
  shadeTerrainColor,
  terrainReliefShadeLevel,
  type TerrainChunkPresentation,
  type TerrainMeshScene,
} from './preview-terrain-mesh';
import type { VisibleChunk } from './top-down-preview';

export function buildTerrainTexels(
  scene: TerrainMeshScene,
  terrainIds: ArrayLike<number>,
  backend: PreviewGenerationResult['backend'],
  presentation: TerrainChunkPresentation,
  bounds: VisibleChunk = {
    minimumX: 0,
    maximumX: scene.width - 1,
    minimumY: 0,
    maximumY: scene.height - 1,
  },
): Uint8Array {
  const { width } = scene;
  const texelWidth = bounds.maximumX - bounds.minimumX + 1;
  const texelHeight = bounds.maximumY - bounds.minimumY + 1;
  const texels = new Uint8Array(Math.max(0, texelWidth * texelHeight * 4));
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
  const shadedColors = new Map<number, number>();
  const range = presentation.elevationRange;
  const background = presentation.backgroundColor;
  for (let y = bounds.minimumY; y <= bounds.maximumY; y += 1) {
    for (let x = bounds.minimumX; x <= bounds.maximumX; x += 1) {
      const index = y * width + x;
      const terrainId = terrainIds[index];
      if (terrainId === undefined) continue;
      let color = baseColor(terrainId);
      if (presentation.elevationMode === 'terrain') {
        const level = terrainReliefShadeLevel(scene, x, y);
        const key = color * 8 + level + 3;
        let shaded = shadedColors.get(key);
        if (shaded === undefined) {
          shaded = shadeTerrainColor(color, level);
          shadedColors.set(key, shaded);
        }
        color = shaded;
      } else if (presentation.elevationMode === 'height-map') {
        const alpha = heightOverlayAlpha(scene.elevations[index] ?? 0, range);
        if (alpha > 0) color = blendedOverlayColor(color, background, alpha);
      }
      const offset = ((y - bounds.minimumY) * texelWidth + x - bounds.minimumX) * 4;
      texels[offset] = (color >> 16) & 0xff;
      texels[offset + 1] = (color >> 8) & 0xff;
      texels[offset + 2] = color & 0xff;
      texels[offset + 3] = 0xff;
    }
  }
  return texels;
}

export function blendedOverlayColor(source: number, cover: number, alpha: number): number {
  const stored = ((alpha * 255) | 0) / 255;
  const channel = (shift: number) => {
    const premultiplied = Math.round(Math.fround((((cover >> shift) & 0xff) / 255) * stored) * 255);
    return Math.floor(premultiplied + ((source >> shift) & 0xff) * (1 - stored) + 0.5);
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}
