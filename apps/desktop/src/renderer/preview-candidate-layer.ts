import { BufferImageSource, Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { SelectedMinimapPalette, TerrainMinimapColor } from '../shared/api';
import type { PreviewGenerationResult } from '../shared/api';
import { previewCandidateChunkBounds } from '../shared/preview-candidate';
import {
  cliffMaterial,
  isDrawnPreviewObject,
  objectMaterial,
  type PreviewObjectVisibility,
} from './preview-materials';
import type { CandidateApplyResult, PreviewCandidateStore } from './preview-candidate-store';
import { chunkSpriteMatrix } from './game-art-terrain';
import {
  terrainElevationRange,
  type ElevationDisplayMode,
  type ElevationRange,
} from './preview-terrain-mesh';
import { buildTerrainTexels } from './preview-terrain-texture';
import {
  previewCliffStrokeWidth,
  previewObjectMarkerScreenRadius,
  previewObjectMarkerSpan,
  previewProjectionVerticalScale,
  previewScale,
  type PreviewCamera,
  type PreviewViewport,
} from './top-down-preview';

export interface CandidatePresentation {
  elevationMode: ElevationDisplayMode;
  heightOverlayColor: number;
  minimapPalette: SelectedMinimapPalette | null;
  terrainNames: PreviewGenerationResult['terrainNames'];
  localTerrainColors: readonly TerrainMinimapColor[] | undefined;
  lookTerrainColors?: ReadonlyMap<number, number>;
  lookObjectColors?: ReadonlyMap<number, number>;
  lookCliffColors?: ReadonlyMap<number, number>;
  playerColorIds: readonly number[];
  visibility: PreviewObjectVisibility;
  cliffs: boolean;
  markerComponent: number;
}

interface CandidateChunk {
  terrain: Container;
  vectors: Graphics | null;
  texture: Texture;
}

export class PreviewCandidateLayer {
  readonly container = new Container({ label: 'live-generation-candidate' });
  private readonly terrainRoot = new Container({ label: 'candidate-terrain' });
  private readonly vectorRoot = new Container({ label: 'candidate-cliffs-and-objects' });
  private readonly chunks = new Map<number, CandidateChunk>();
  private elevationRange: ElevationRange = { minimum: 0, maximum: 0 };
  lastUpdateMilliseconds = 0;
  rebuiltChunks = 0;
  vectorComponent = 0;

  constructor(private readonly store: PreviewCandidateStore) {
    this.container.eventMode = 'none';
    this.terrainRoot.eventMode = 'none';
    this.vectorRoot.eventMode = 'none';
    this.container.addChild(this.terrainRoot, this.vectorRoot);
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  rebuildAll(presentation: CandidatePresentation): void {
    const grid = this.store.chunkGrid();
    if (!grid) {
      this.clear();
      return;
    }
    const keys = Array.from({ length: grid.columns * grid.rows }, (_, index) => index);
    this.update({ accepted: true, changedChunks: keys, reset: true }, presentation);
  }

  update(change: CandidateApplyResult, presentation: CandidatePresentation): void {
    const started = performance.now();
    const view = this.store.view;
    const grid = this.store.chunkGrid();
    const terrain = this.store.terrainIds();
    const elevations = this.store.elevations();
    if (!view || !grid || !terrain || !elevations) {
      this.clear();
      return;
    }
    if (change.reset) this.clear();
    const keys = new Set(change.changedChunks);
    if (presentation.elevationMode === 'terrain') {
      for (const key of change.changedChunks) {
        const chunkX = key % grid.columns;
        const chunkY = Math.floor(key / grid.columns);
        for (const [dx, dy] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const x = chunkX + dx;
          const y = chunkY + dy;
          if (x >= 0 && y >= 0 && x < grid.columns && y < grid.rows) keys.add(y * grid.columns + x);
        }
      }
    }
    if (presentation.elevationMode === 'height-map') {
      const range = terrainElevationRange(elevations);
      if (
        range.minimum !== this.elevationRange.minimum ||
        range.maximum !== this.elevationRange.maximum
      ) {
        for (let key = 0; key < grid.columns * grid.rows; key += 1) keys.add(key);
      }
      this.elevationRange = range;
    }
    const scene = { width: view.width, height: view.height, elevations };
    for (const key of keys) {
      this.destroyChunk(key);
      const chunkX = key % grid.columns;
      const chunkY = Math.floor(key / grid.columns);
      const bounds = previewCandidateChunkBounds(view.width, view.height, chunkX, chunkY);
      const debugName = `candidate-chunk-${chunkX}-${chunkY}`;
      const container = new Container({ label: debugName });
      container.eventMode = 'none';
      const texels = buildTerrainTexels(
        scene,
        terrain,
        'exact',
        {
          backgroundColor: presentation.heightOverlayColor,
          elevationMode: presentation.elevationMode,
          elevationRange: this.elevationRange,
          localTerrainColors: presentation.localTerrainColors,
          lookTerrainColors: presentation.lookTerrainColors,
          minimapPalette: presentation.minimapPalette,
          terrainNames: presentation.terrainNames,
        },
        bounds,
      );
      const texture = new Texture({
        source: new BufferImageSource({
          resource: texels,
          width: bounds.maximumX - bounds.minimumX + 1,
          height: bounds.maximumY - bounds.minimumY + 1,
          format: 'rgba8unorm',
          alphaMode: 'premultiplied-alpha',
          scaleMode: 'nearest',
          addressMode: 'clamp-to-edge',
          autoGenerateMipmaps: false,
        }),
      });
      const sprite = new Sprite({ texture });
      sprite.eventMode = 'none';
      sprite.setFromMatrix(chunkSpriteMatrix(bounds.minimumX, bounds.minimumY, 1));
      container.addChild(sprite);
      this.chunks.set(key, { terrain: container, vectors: null, texture });
      this.terrainRoot.addChild(container);
    }
    for (const key of keys) this.drawVectors(key, presentation);
    this.vectorComponent = presentation.markerComponent;
    this.rebuiltChunks = keys.size;
    this.lastUpdateMilliseconds = performance.now() - started;
  }

  refreshVectors(presentation: CandidatePresentation): void {
    for (const key of this.chunks.keys()) this.drawVectors(key, presentation);
    this.vectorComponent = presentation.markerComponent;
  }

  private drawVectors(key: number, presentation: CandidatePresentation): void {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    chunk.vectors?.destroy();
    const vectors = new Graphics();
    const units = 1 / Math.max(presentation.markerComponent, 0.000_001);
    if (presentation.cliffs) {
      const cliffWidth = previewCliffStrokeWidth(presentation.markerComponent * Math.SQRT2) * units;
      for (const cliff of this.store.chunkCliffs(key)) {
        vectors
          .moveTo(cliff.fromX + cliff.fromY, cliff.fromY - cliff.fromX)
          .lineTo(cliff.toX + cliff.toY, cliff.toY - cliff.toX)
          .stroke({
            color: cliffMaterial(
              cliff.cliffType,
              presentation.lookCliffColors ? 'texture-colors' : 'minimap',
              null,
              presentation.lookCliffColors,
            ).color,
            width: cliffWidth,
            cap: 'round',
            join: 'round',
          });
      }
    }
    for (const object of this.store.chunkObjects(key)) {
      if (!isDrawnPreviewObject(object, presentation.visibility)) continue;
      const material = objectMaterial(
        object,
        presentation.playerColorIds,
        [],
        presentation.minimapPalette,
        undefined,
        presentation.visibility.helperObjectIds,
        presentation.lookObjectColors,
      );
      const radius =
        previewObjectMarkerScreenRadius(
          presentation.markerComponent * Math.SQRT2,
          previewObjectMarkerSpan(object),
        ) * units;
      const x = object.x + object.y;
      const y = object.y - object.x;
      if (material.helper) {
        vectors.circle(x, y, radius).stroke({ color: material.color, width: units, alpha: 0.75 });
      } else if (material.shape === 'double-line') {
        vectors.rect(x - radius, y - radius * 0.35, radius * 2, radius * 0.7).fill(material.color);
      } else if (material.shape === 'diamond') {
        vectors
          .poly([x, y - radius, x + radius, y, x, y + radius, x - radius, y])
          .fill(material.color);
      } else if (material.shape === 'triangle') {
        vectors
          .poly([x, y - radius, x + radius, y + radius, x - radius, y + radius])
          .fill(material.color);
      } else {
        vectors.circle(x, y, radius).fill(material.color);
      }
    }
    chunk.vectors = vectors;
    this.vectorRoot.addChild(vectors);
  }

  transform(
    camera: PreviewCamera,
    viewport: PreviewViewport,
    dimensions: { width: number; height: number },
  ): void {
    const component =
      previewScale(dimensions.width, dimensions.height, camera, viewport) * Math.SQRT1_2;
    const verticalComponent = component * previewProjectionVerticalScale(viewport);
    this.container.scale.set(component, verticalComponent);
    this.container.position.set(
      viewport.width / 2 - (camera.centerX + camera.centerY) * component,
      viewport.height / 2 - (camera.centerY - camera.centerX) * verticalComponent,
    );
  }

  destroy(): void {
    this.clear();
    this.container.destroy({ children: true });
  }

  private clear(): void {
    for (const key of [...this.chunks.keys()]) this.destroyChunk(key);
  }

  private destroyChunk(key: number): void {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.chunks.delete(key);
    chunk.terrain.destroy({ children: true });
    chunk.vectors?.destroy();
    chunk.texture.destroy(true);
  }
}
