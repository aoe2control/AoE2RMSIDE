import { BufferImageSource, Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { Geometry, Shader, State } from 'pixi.js';
import type { SelectedMinimapPalette, TerrainMinimapColor } from '../shared/api';
import type { PreviewGenerationResult } from '../shared/api';
import { previewCandidateChunkBounds, previewCandidateStages } from '../shared/preview-candidate';
import {
  cliffMaterial,
  isDrawnPreviewObject,
  markerShapeOutline,
  objectMaterial,
  type PreviewMaterial,
  type PreviewObjectVisibility,
} from './preview-materials';
import {
  buildingInsetLighten,
  buildingInsetMinimumBase,
  clusterBlob,
  clusterDots,
  clusterMinimumRadius,
  crownScale,
  farmFill,
  mixColor,
} from './preview-object-markers';
import type {
  CandidateApplyResult,
  CandidateObject,
  PreviewCandidateStore,
} from './preview-candidate-store';
import { chunkSpriteMatrix } from './game-art-terrain';
import { ElevationSurface, raisedLightStrength } from './preview-elevation';
import { raisedRectMesh } from './preview-raised-mesh';
import {
  RaisedTerrainUniforms,
  raisedColorPixiMesh,
  raisedColorShader,
  raisedTerrainState,
  raisedViewRect,
  type RaisedLocalRect,
} from './preview-raised-terrain';
import {
  heightMapObjectLightAt,
  terrainElevationRange,
  type ElevationDisplayMode,
  type ElevationRange,
} from './preview-terrain-mesh';
import { litColor } from './preview-elevation';
import {
  minimapSquareTownCenterPolygon,
  minimapSquareColor,
  minimapSquareDrawLayer,
  minimapSquareSide,
  minimapSquareTownCenterBorderColor,
  type MinimapSquareClass,
  type MinimapSquareClassifier,
  type MinimapSquareSizes,
} from './minimap-squares';
import { requestPreviewRender } from './preview-render-scheduler';
import {
  gateObjectClass,
  isStraightWallRun,
  previewWallPostHalfWidth,
  previewWallStrokeWidth,
  wallJoinDirections,
  wallJoinRole,
  wallJoins,
  wallPostPolygon,
} from './preview-wall-joins';
import { buildTerrainTexels } from './preview-terrain-texture';
import {
  previewCliffStrokeWidth,
  previewMarkerScreenRadius,
  previewObjectFootprintSpan,
  previewObjectMarkerScreenRadius,
  previewObjectMarkerSpan,
  previewProjectionVerticalScale,
  previewScale,
  previewViewCenter,
  type PreviewCamera,
  type PreviewViewport,
} from './top-down-preview';
import { destroyPixiTree } from './pixi-destroy';

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
  raised?: boolean;
  minimapSquares?: { classifier: MinimapSquareClassifier; sizes: MinimapSquareSizes } | null;
  verticalScale?: number;
  objectClasses?: ReadonlyMap<number, number>;
}

function drawCandidateMarker(
  vectors: Graphics,
  object: CandidateObject,
  material: PreviewMaterial,
  color: number,
  x: number,
  y: number,
  markerComponent: number,
  units: number,
): void {
  const helper = material.helper === true;
  const paint = (graphics: Graphics) =>
    helper
      ? graphics.stroke({ color, width: units, alpha: 0.75 })
      : graphics.fill({ color, alpha: 1 });
  const shape = material.shape;
  if (shape === 'building' || shape === 'farm') {
    const width = previewObjectFootprintSpan(object.footprintWidth);
    const height = previewObjectFootprintSpan(object.footprintHeight);
    const base = markerComponent * Math.min(width, height) * 0.5;
    const grow =
      base > 0 && base < previewMarkerScreenRadius.minimum
        ? previewMarkerScreenRadius.minimum / base
        : 1;
    const rectangle = (halfWidth: number, halfHeight: number) => {
      const points: number[] = [];
      for (const [signX, signY] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        const deltaX = signX * halfWidth * grow;
        const deltaY = signY * halfHeight * grow;
        points.push(x + deltaX + deltaY, y + deltaY - deltaX);
      }
      return points;
    };
    vectors.poly(rectangle(width / 2, height / 2));
    if (helper) {
      vectors.stroke({ color, width: units, alpha: 0.75 });
    } else if (shape === 'farm') {
      vectors.fill({ color: mixColor(color, 0xffffff, farmFill.lighten), alpha: farmFill.alpha });
    } else {
      vectors.fill({ color, alpha: 1 });
      if (grow === 1 && base >= buildingInsetMinimumBase) {
        const inset = Math.min(width, height) / 8;
        vectors.poly(rectangle(width / 2 - inset, height / 2 - inset)).stroke({
          color: mixColor(color, 0xffffff, buildingInsetLighten),
          width: units,
          alpha: 1,
        });
      }
    }
    return;
  }
  const crown = shape === 'crown' ? crownScale : 1;
  const radius =
    previewObjectMarkerScreenRadius(markerComponent * Math.SQRT2, previewObjectMarkerSpan(object)) *
    crown *
    units;
  if (shape === 'wall') {
    paint(vectors.rect(x - radius, y - radius, radius * 2, radius * 2));
  } else if (shape === 'diamond') {
    paint(vectors.poly([x, y - radius, x + radius, y, x, y + radius, x - radius, y]));
  } else if (shape === 'triangle') {
    paint(vectors.poly([x, y - radius, x + radius, y + radius, x - radius, y + radius]));
  } else if (shape === 'star') {
    const outline = markerShapeOutline('star')!;
    paint(vectors.poly(outline.map((value, index) => (index % 2 === 0 ? x : y) + value * radius)));
  } else if (shape === 'cluster' && radius / units < clusterMinimumRadius) {
    paint(
      vectors.ellipse(
        x,
        y + clusterBlob.offsetY * radius,
        clusterBlob.radiusX * radius,
        clusterBlob.radiusY * radius,
      ),
    );
  } else if (shape === 'cluster') {
    for (const [unitX, unitY] of clusterDots) {
      paint(vectors.circle(x + unitX * radius, y + unitY * radius, radius * 0.5));
    }
  } else {
    paint(vectors.circle(x, y, radius));
  }
}

function drawCandidateWall(
  vectors: Graphics,
  object: CandidateObject,
  bits: number,
  color: number,
  helper: boolean,
  markerComponent: number,
  units: number,
  lift: (x: number, y: number) => number,
  raised: boolean,
): void {
  const tileEdgePixels = markerComponent * Math.SQRT2;
  const centerX = object.x + object.y;
  const centerY = object.y - object.x - lift(object.x, object.y);
  const tileX = Math.floor(object.x) + 0.5;
  const tileY = Math.floor(object.y) + 0.5;
  const ends: [number, number][] = [];
  for (const { dx, dy, bit } of wallJoinDirections) {
    if ((bits & bit) === 0) continue;
    const endX = tileX + dx * 0.5;
    const endY = tileY + dy * 0.5;
    ends.push([endX + endY, endY - endX - lift(endX, endY)]);
  }
  const strokeWidth = previewWallStrokeWidth(tileEdgePixels);
  const cap = raised ? ('square' as const) : ('butt' as const);
  const stroke = helper
    ? { color, width: units, alpha: 0.75, cap }
    : { color, width: strokeWidth * units, alpha: 1, cap };
  if (isStraightWallRun(bits)) {
    vectors
      .moveTo(ends[0]![0], ends[0]![1])
      .lineTo(centerX, centerY)
      .lineTo(ends[1]![0], ends[1]![1])
      .stroke(stroke);
  } else {
    for (const [endX, endY] of ends) {
      vectors.moveTo(centerX, centerY).lineTo(endX, endY).stroke(stroke);
    }
  }
  const postHalfWidth = previewWallPostHalfWidth(bits, strokeWidth, tileEdgePixels);
  if (postHalfWidth <= 0) return;
  vectors.poly(wallPostPolygon(centerX, centerY, postHalfWidth * units, 1, 1));
  if (helper) vectors.stroke(stroke);
  else vectors.fill({ color, alpha: 1 });
}

interface CandidateChunk {
  terrain: Container;
  vectors: Graphics | null;
  texture: Texture | null;
  raised: { geometry: Geometry; bounds: RaisedLocalRect } | null;
}

interface RaisedPicture {
  surface: ElevationSurface;
  uniforms: RaisedTerrainUniforms;
  shader: Shader;
  state: State;
}

interface RaisedBatch {
  picture: RaisedPicture;
  queue: number[];
  head: number;
  queued: Set<number>;
  built: Map<number, CandidateChunk>;
  whole: boolean;
  spent: number;
  slices: number;
  laterSpent: number;
  restarts: number;
}

export interface CandidatePictureChange {
  turningRaised: boolean;
  uniforms: RaisedTerrainUniforms | null;
}

export interface CandidateLayerTiming {
  sliceMilliseconds: number;
  now(): number;
  schedule(callback: () => void): unknown;
  cancel(handle: unknown): void;
}

export const candidateRaisedSliceMilliseconds = 8;

const maximumRaisedRestarts = 2;

const elevationStageRank = previewCandidateStages.indexOf('elevation');

const raisedCullOverscan = 32;

export class PreviewCandidateLayer {
  readonly container = new Container({ label: 'live-generation-candidate' });
  private readonly terrainRoot = new Container({ label: 'candidate-terrain' });
  private readonly vectorRoot = new Container({ label: 'candidate-cliffs-and-objects' });
  private readonly chunks = new Map<number, CandidateChunk>();
  private elevationRange: ElevationRange = { minimum: 0, maximum: 0 };
  private readonly timing: CandidateLayerTiming;
  private picture: RaisedPicture | null = null;
  private batch: RaisedBatch | null = null;
  private sliceTimer: unknown = null;
  private updating = false;
  private presentation: CandidatePresentation | null = null;
  private view: RaisedLocalRect | null = null;
  private destroyed = false;
  private held = false;
  private drawnDimensions = { width: 0, height: 0 };
  private wallJoinCache: { key: unknown[]; joins: Map<CandidateObject, number> } | null = null;
  private readonly wallChunks = new Set<number>();
  lastUpdateMilliseconds = 0;
  rebuiltChunks = 0;
  vectorComponent = 0;
  vectorVerticalScale = 1;
  raisedBuildMilliseconds = 0;
  raisedSlices = 0;
  raisedLaterMilliseconds = 0;
  drawnRaisedChunks = 0;
  onSwap: (() => void) | null = null;
  onPictureChange: ((phase: 'before' | 'after', change: CandidatePictureChange) => void) | null =
    null;

  constructor(
    private readonly store: PreviewCandidateStore,
    timing: Partial<CandidateLayerTiming> = {},
  ) {
    this.timing = {
      sliceMilliseconds: candidateRaisedSliceMilliseconds,
      now: () => performance.now(),
      schedule: (callback) => setTimeout(callback, 0),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      ...timing,
    };
    this.container.eventMode = 'none';
    this.terrainRoot.eventMode = 'none';
    this.vectorRoot.eventMode = 'none';
    this.container.addChild(this.terrainRoot, this.vectorRoot);
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  get raisedSurface(): ElevationSurface | null {
    return this.picture?.surface ?? null;
  }

  get raisedPicture(): { surface: ElevationSurface; uniforms: RaisedTerrainUniforms } | null {
    const picture = this.picture;
    return picture ? { surface: picture.surface, uniforms: picture.uniforms } : null;
  }

  get dimensions(): { width: number; height: number } {
    return this.drawnDimensions;
  }

  get terrainNode(): Container {
    return this.terrainRoot;
  }

  get objectNode(): Container {
    return this.vectorRoot;
  }

  stagePicture(): {
    texels: Uint8Array;
    width: number;
    height: number;
    surface: ElevationSurface | null;
  } | null {
    const view = this.store.view;
    const terrain = this.store.terrainIds();
    const elevations = this.store.elevations();
    const presentation = this.presentation;
    if (!view || !terrain || !elevations || !presentation || this.batch || this.held) return null;
    const surface = this.picture?.surface ?? null;
    const texels = buildTerrainTexels(
      { width: view.width, height: view.height, elevations },
      terrain,
      'exact',
      {
        backgroundColor: presentation.heightOverlayColor,
        elevationMode: surface ? 'off' : presentation.elevationMode,
        elevationRange: surface ? { minimum: 0, maximum: 0 } : this.elevationRange,
        localTerrainColors: presentation.localTerrainColors,
        lookTerrainColors: presentation.lookTerrainColors,
        minimapPalette: presentation.minimapPalette,
        terrainNames: presentation.terrainNames,
      },
    );
    return { texels, width: view.width, height: view.height, surface };
  }

  get frozen(): boolean {
    return this.held;
  }

  freeze(): void {
    this.cancelBatch();
    this.held = true;
  }

  get raisedPending(): boolean {
    return this.batch !== null;
  }

  rebuildAll(presentation: CandidatePresentation): void {
    if (this.held) return;
    const grid = this.store.chunkGrid();
    if (!grid) {
      this.cancelBatch();
      this.clear();
      requestPreviewRender(this.container);
      return;
    }
    const keys = Array.from({ length: grid.columns * grid.rows }, (_, index) => index);
    this.update({ accepted: true, changedChunks: keys, reset: true }, presentation);
  }

  update(change: CandidateApplyResult, presentation: CandidatePresentation): void {
    if (this.held) return;
    const started = this.timing.now();
    this.presentation = presentation;
    this.wallJoinCache = null;
    const view = this.store.view;
    const grid = this.store.chunkGrid();
    const terrain = this.store.terrainIds();
    const elevations = this.store.elevations();
    requestPreviewRender(this.container);
    if (!view || !grid || !terrain || !elevations) {
      this.cancelBatch();
      this.clear();
      return;
    }
    this.drawnDimensions = { width: view.width, height: view.height };
    this.updating = true;
    try {
      const raised =
        presentation.raised === true &&
        presentation.elevationMode === 'terrain' &&
        previewCandidateStages.indexOf(view.stage) >= elevationStageRank;
      if (raised) this.updateRaised(change, presentation, view, grid, elevations);
      else this.updateFlat(change, presentation, view, grid, terrain, elevations);
    } finally {
      this.updating = false;
    }
    this.lastUpdateMilliseconds = this.timing.now() - started;
  }

  private updateFlat(
    change: CandidateApplyResult,
    presentation: CandidatePresentation,
    view: { width: number; height: number },
    grid: { columns: number; rows: number },
    terrain: Uint16Array,
    elevations: Int8Array,
  ): void {
    const flatChange: CandidatePictureChange = { turningRaised: false, uniforms: null };
    this.onPictureChange?.('before', flatChange);
    this.cancelBatch();
    const all = grid.columns * grid.rows;
    const reset = change.reset || this.picture !== null;
    if (reset) this.clear();
    const keys = new Set(
      reset ? Array.from({ length: all }, (_, key) => key) : change.changedChunks,
    );
    if (presentation.elevationMode === 'terrain') {
      for (const key of reset ? [] : change.changedChunks) {
        const chunkX = key % grid.columns;
        const chunkY = Math.floor(key / grid.columns);
        for (const [dx, dy] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
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
        for (let key = 0; key < all; key += 1) keys.add(key);
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
      this.chunks.set(key, { terrain: container, vectors: null, texture, raised: null });
      this.terrainRoot.addChild(container);
    }
    const wallNeighbours = reset
      ? []
      : [...this.wallNeighbourChunks(change.changedChunks, grid, presentation)].filter(
          (key) => !keys.has(key),
        );
    if (this.picture) this.destroyPicture(this.picture);
    this.picture = null;
    for (const key of keys) this.drawVectors(key, presentation);
    for (const key of wallNeighbours) this.drawVectors(key, presentation);
    this.vectorComponent = presentation.markerComponent;
    this.rebuiltChunks = keys.size;
    this.onPictureChange?.('after', flatChange);
  }

  private updateRaised(
    change: CandidateApplyResult,
    presentation: CandidatePresentation,
    view: { width: number; height: number },
    grid: { columns: number; rows: number },
    elevations: Int8Array,
  ): void {
    const all = grid.columns * grid.rows;
    const target = this.batch?.picture ?? this.picture;
    const newSurface =
      !target ||
      change.reset ||
      (change.elevationChanged ?? true) ||
      target.surface.width !== view.width ||
      target.surface.height !== view.height;
    if (newSurface) {
      const restarts = this.batch?.whole ? this.batch.restarts + 1 : 0;
      this.cancelBatch();
      const surface = new ElevationSurface(view.width, view.height, elevations);
      this.batch = this.newBatch(this.createPicture(surface), true, restarts);
      for (let key = 0; key < all; key += 1) this.enqueue(this.batch, key);
    } else {
      const terrainKeys = change.terrainChunks ?? change.changedChunks;
      const batch = this.batch ?? this.newBatch(this.picture!, false, 0);
      for (const key of terrainKeys) this.enqueue(batch, key);
      if (!batch.whole) {
        const wallNeighbours = this.wallNeighbourChunks(change.changedChunks, grid, presentation);
        for (const key of new Set([...change.changedChunks, ...wallNeighbours])) {
          if (!batch.queued.has(key) && !batch.built.has(key)) {
            this.drawVectors(key, presentation);
          }
        }
        this.vectorComponent = presentation.markerComponent;
      }
      this.batch = batch.queued.size > 0 || batch.built.size > 0 ? batch : null;
    }
    this.pump();
  }

  private newBatch(picture: RaisedPicture, whole: boolean, restarts: number): RaisedBatch {
    return {
      picture,
      queue: [],
      head: 0,
      queued: new Set(),
      built: new Map(),
      whole,
      spent: 0,
      slices: 0,
      laterSpent: 0,
      restarts,
    };
  }

  private enqueue(batch: RaisedBatch, key: number): void {
    const built = batch.built.get(key);
    if (built) {
      batch.built.delete(key);
      destroyChunkParts(built);
    }
    if (batch.queued.has(key)) return;
    batch.queued.add(key);
    batch.queue.push(key);
  }

  private pump(): void {
    const batch = this.batch;
    if (this.sliceTimer !== null) this.timing.cancel(this.sliceTimer);
    this.sliceTimer = null;
    if (!batch || this.destroyed) return;
    const started = this.timing.now();
    const budget =
      batch.restarts >= maximumRaisedRestarts
        ? Number.POSITIVE_INFINITY
        : this.timing.sliceMilliseconds;
    while (batch.head < batch.queue.length) {
      const key = batch.queue[batch.head]!;
      batch.head += 1;
      if (!batch.queued.delete(key)) continue;
      const chunk = this.buildRaisedChunk(key, batch.picture);
      if (chunk) batch.built.set(key, chunk);
      if (this.timing.now() - started >= budget) break;
    }
    const spent = this.timing.now() - started;
    batch.spent += spent;
    if (!this.updating) batch.laterSpent += spent;
    batch.slices += 1;
    if (batch.queued.size > 0) {
      this.sliceTimer = this.timing.schedule(() => this.pump());
      return;
    }
    this.swap(batch);
  }

  private buildRaisedChunk(key: number, picture: RaisedPicture): CandidateChunk | null {
    const view = this.store.view;
    const grid = this.store.chunkGrid();
    const terrain = this.store.terrainIds();
    const presentation = this.presentation;
    if (!view || !grid || !terrain || !presentation) return null;
    const chunkX = key % grid.columns;
    const chunkY = Math.floor(key / grid.columns);
    const bounds = previewCandidateChunkBounds(view.width, view.height, chunkX, chunkY);
    const texels = buildTerrainTexels(
      { width: view.width, height: view.height, elevations: this.store.elevations() ?? [] },
      terrain,
      'exact',
      {
        backgroundColor: presentation.heightOverlayColor,
        elevationMode: 'off',
        elevationRange: { minimum: 0, maximum: 0 },
        localTerrainColors: presentation.localTerrainColors,
        lookTerrainColors: presentation.lookTerrainColors,
        minimapPalette: presentation.minimapPalette,
        terrainNames: presentation.terrainNames,
      },
      bounds,
    );
    const columns = bounds.maximumX - bounds.minimumX + 1;
    const width = view.width;
    const colorOf = (tile: number) => {
      const x = tile % width;
      const at = (((tile - x) / width - bounds.minimumY) * columns + x - bounds.minimumX) * 4;
      return (texels[at]! << 16) | (texels[at + 1]! << 8) | texels[at + 2]!;
    };
    const mesh = raisedRectMesh(picture.surface, bounds, raisedLightStrength.colorLooks, colorOf);
    const debugName = `candidate-raised-chunk-${chunkX}-${chunkY}`;
    const container = new Container({ label: debugName });
    container.eventMode = 'none';
    const drawn = raisedColorPixiMesh(mesh, picture.shader, picture.state);
    container.addChild(drawn.mesh);
    return {
      terrain: container,
      vectors: null,
      texture: null,
      raised: { geometry: drawn.geometry, bounds: mesh.bounds },
    };
  }

  private swap(batch: RaisedBatch): void {
    const pictureChange: CandidatePictureChange = {
      turningRaised: this.picture === null,
      uniforms: batch.picture.uniforms,
    };
    this.onPictureChange?.('before', pictureChange);
    this.batch = null;
    const presentation = this.presentation;
    if (batch.whole) this.clear();
    for (const [key, chunk] of batch.built) {
      this.destroyChunk(key);
      this.chunks.set(key, chunk);
      this.terrainRoot.addChild(chunk.terrain);
    }
    if (this.picture && this.picture !== batch.picture) this.destroyPicture(this.picture);
    this.picture = batch.picture;
    if (presentation) {
      for (const key of batch.built.keys()) this.drawVectors(key, presentation);
      this.vectorComponent = presentation.markerComponent;
    }
    this.applyCulling();
    this.rebuiltChunks = batch.built.size;
    this.raisedBuildMilliseconds = batch.spent;
    this.raisedLaterMilliseconds = batch.laterSpent;
    this.raisedSlices = batch.slices;
    requestPreviewRender(this.container);
    this.onPictureChange?.('after', pictureChange);
    if (!this.updating) this.onSwap?.();
  }

  private createPicture(surface: ElevationSurface): RaisedPicture {
    const uniforms = new RaisedTerrainUniforms(surface);
    return {
      surface,
      uniforms,
      shader: raisedColorShader(uniforms),
      state: raisedTerrainState(surface.hasSteps, surface.hasSteps, false),
    };
  }

  private destroyPicture(picture: RaisedPicture): void {
    picture.shader.destroy(false);
  }

  private cancelBatch(): void {
    if (this.sliceTimer !== null) this.timing.cancel(this.sliceTimer);
    this.sliceTimer = null;
    const batch = this.batch;
    this.batch = null;
    if (!batch) return;
    for (const chunk of batch.built.values()) destroyChunkParts(chunk);
    if (batch.picture !== this.picture) this.destroyPicture(batch.picture);
  }

  refreshVectors(presentation: CandidatePresentation): void {
    if (this.held) return;
    this.presentation = presentation;
    for (const key of this.chunks.keys()) this.drawVectors(key, presentation);
    this.vectorComponent = presentation.markerComponent;
    requestPreviewRender(this.container);
  }

  private drawVectors(key: number, presentation: CandidatePresentation): void {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    chunk.vectors?.destroy();
    this.vectorVerticalScale = presentation.verticalScale ?? 1;
    const vectors = new Graphics();
    const surface = this.picture?.surface ?? null;
    const lift = (x: number, y: number) => (surface ? surface.heightAt(x, y) : 0);
    const units = 1 / Math.max(presentation.markerComponent, 0.000_001);
    if (presentation.cliffs) {
      const cliffWidth = previewCliffStrokeWidth(presentation.markerComponent * Math.SQRT2) * units;
      for (const cliff of this.store.chunkCliffs(key)) {
        vectors
          .moveTo(
            cliff.fromX + cliff.fromY,
            cliff.fromY - cliff.fromX - lift(cliff.fromX, cliff.fromY),
          )
          .lineTo(cliff.toX + cliff.toY, cliff.toY - cliff.toX - lift(cliff.toX, cliff.toY))
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
    const elevations = presentation.elevationMode === 'height-map' ? this.store.elevations() : null;
    const width = this.drawnDimensions.width;
    const height = this.drawnDimensions.height;
    const shade = (color: number, object: { x: number; y: number }) =>
      elevations
        ? litColor(
            color,
            heightMapObjectLightAt(
              { width, height, elevations },
              object.x,
              object.y,
              this.elevationRange,
            ),
          )
        : color;
    if (presentation.minimapSquares) {
      this.drawMinimapSquareVectors(
        vectors,
        key,
        presentation,
        presentation.minimapSquares,
        units,
        lift,
        shade,
      );
      chunk.vectors = vectors;
      this.vectorRoot.addChild(vectors);
      return;
    }
    const materials = new Map<number, PreviewMaterial>();
    const classes = presentation.objectClasses;
    let holdsWalls = false;
    for (const object of this.store.chunkObjects(key)) {
      if (!isDrawnPreviewObject(object, presentation.visibility)) continue;
      const materialKey =
        (object.objectId * 256 + (object.owner & 0xff)) * 2 +
        (object.presentationKind === 'wall' ? 1 : 0);
      let base = materials.get(materialKey);
      const objectClass = classes?.get(object.objectId);
      if (objectClass === gateObjectClass) holdsWalls = true;
      if (!base) {
        base = objectMaterial(
          objectClass === undefined ? object : { ...object, objectClass },
          presentation.playerColorIds,
          [],
          presentation.minimapPalette,
          undefined,
          presentation.visibility.helperObjectIds,
          presentation.lookObjectColors,
        );
        materials.set(materialKey, base);
      }
      const color = shade(base.color, object);
      if (base.shape === 'wall') {
        holdsWalls = true;
        drawCandidateWall(
          vectors,
          object,
          this.wallJoins(presentation).get(object) ?? 0,
          color,
          base.helper === true,
          presentation.markerComponent,
          units,
          lift,
          surface !== null,
        );
        continue;
      }
      const x = object.x + object.y;
      const y = object.y - object.x - lift(object.x, object.y);
      drawCandidateMarker(vectors, object, base, color, x, y, presentation.markerComponent, units);
    }
    if (holdsWalls) this.wallChunks.add(key);
    else this.wallChunks.delete(key);
    chunk.vectors = vectors;
    this.vectorRoot.addChild(vectors);
  }

  private wallJoins(presentation: CandidatePresentation): Map<CandidateObject, number> {
    const { visibility, objectClasses } = presentation;
    const key = [visibility.objects, visibility.helpers, visibility.helperObjectIds, objectClasses];
    const cached = this.wallJoinCache;
    if (cached && cached.key.every((value, index) => value === key[index])) return cached.joins;
    const objects = this.allObjects();
    const positions = wallJoins(
      objects,
      this.drawnDimensions.width,
      this.drawnDimensions.height,
      (object) => isDrawnPreviewObject(object, visibility),
      objectClasses ? (object) => objectClasses.get(object.objectId) : undefined,
    );
    const joins = new Map<CandidateObject, number>();
    for (const [position, bits] of positions) joins.set(objects[position]!, bits);
    this.wallJoinCache = { key, joins };
    return joins;
  }

  private allObjects(): CandidateObject[] {
    const grid = this.store.chunkGrid();
    const objects: CandidateObject[] = [];
    if (!grid) return objects;
    for (let key = 0; key < grid.columns * grid.rows; key += 1) {
      for (const object of this.store.chunkObjects(key)) objects.push(object);
    }
    return objects;
  }

  private wallNeighbourChunks(
    changed: Iterable<number>,
    grid: { columns: number; rows: number },
    presentation: CandidatePresentation,
  ): Set<number> {
    const neighbours = new Set<number>();
    const classes = presentation.objectClasses;
    for (const key of changed) {
      const holds = this.store.chunkObjects(key).some((object) => {
        if (!isDrawnPreviewObject(object, presentation.visibility)) return false;
        const objectClass = classes?.get(object.objectId);
        return (
          wallJoinRole(objectClass === undefined ? object : { ...object, objectClass }) !== null
        );
      });
      if (!holds && !this.wallChunks.has(key)) continue;
      const chunkX = key % grid.columns;
      const chunkY = Math.floor(key / grid.columns);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const x = chunkX + dx;
          const y = chunkY + dy;
          if ((dx !== 0 || dy !== 0) && x >= 0 && y >= 0 && x < grid.columns && y < grid.rows) {
            neighbours.add(y * grid.columns + x);
          }
        }
      }
    }
    return neighbours;
  }

  private drawMinimapSquareVectors(
    vectors: Graphics,
    key: number,
    presentation: CandidatePresentation,
    { classifier, sizes }: { classifier: MinimapSquareClassifier; sizes: MinimapSquareSizes },
    units: number,
    lift: (x: number, y: number) => number,
    shade: (color: number, object: { x: number; y: number }) => number,
  ): void {
    const layers: { kind: MinimapSquareClass; x: number; y: number; color: number }[][] = [
      [],
      [],
      [],
      [],
    ];
    for (const object of this.store.chunkObjects(key)) {
      if (!isDrawnPreviewObject(object, presentation.visibility)) continue;
      const kind = classifier.classify(object);
      if (!kind) continue;
      const color = shade(
        minimapSquareColor(kind, object.owner, presentation.playerColorIds),
        object,
      );
      layers[minimapSquareDrawLayer(kind)]!.push({
        kind,
        x: object.x + object.y,
        y: object.y - object.x - lift(object.x, object.y),
        color,
      });
    }
    const upright = 1 / Math.max(presentation.verticalScale ?? 1, 0.000_001);
    for (const entries of layers) {
      for (const entry of entries) {
        if (entry.kind === 'town-center') {
          const outline = minimapSquareTownCenterPolygon(0, 0, sizes.townCenter);
          const points = outline.map((value, index) =>
            index % 2 === 0 ? entry.x + value * units : entry.y + value * units * upright,
          );
          vectors.poly(points).fill(entry.color);
          vectors.poly(points).stroke({
            color: minimapSquareTownCenterBorderColor,
            width: 1.5 * units,
            alpha: 1,
            join: 'miter',
          });
          continue;
        }
        const half = (minimapSquareSide(entry.kind, sizes) / 2) * units;
        const halfHeight = half * upright;
        vectors
          .rect(entry.x - half, entry.y - halfHeight, half * 2, halfHeight * 2)
          .fill(entry.color);
      }
    }
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
    const center = previewViewCenter(viewport);
    this.container.position.set(
      center.x - (camera.centerX + camera.centerY) * component,
      center.y - (camera.centerY - camera.centerX) * verticalComponent,
    );
    this.view = raisedViewRect(dimensions, [camera], viewport, raisedCullOverscan);
    this.applyCulling();
    requestPreviewRender(this.container);
  }

  private applyCulling(): void {
    let drawn = 0;
    for (const chunk of this.chunks.values()) {
      if (!chunk.raised) continue;
      const bounds = chunk.raised.bounds;
      const view = this.view;
      const visible =
        !view ||
        (bounds.maximumS >= view.minimumS &&
          bounds.minimumS <= view.maximumS &&
          bounds.maximumV >= view.minimumV &&
          bounds.minimumV <= view.maximumV);
      chunk.terrain.renderable = visible;
      if (visible) drawn += 1;
    }
    this.drawnRaisedChunks = drawn;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelBatch();
    this.clear();
    if (this.picture) this.destroyPicture(this.picture);
    this.picture = null;
    destroyPixiTree(this.container);
  }

  private clear(): void {
    for (const key of [...this.chunks.keys()]) this.destroyChunk(key);
    this.wallChunks.clear();
  }

  private destroyChunk(key: number): void {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.chunks.delete(key);
    destroyChunkParts(chunk);
  }
}

function destroyChunkParts(chunk: CandidateChunk): void {
  destroyPixiTree(chunk.terrain);
  chunk.vectors?.destroy();
  chunk.texture?.destroy(true);
  chunk.raised?.geometry.destroy(true);
}
