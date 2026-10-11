import {
  effectiveMapIconRelief,
  isMapIconSaveSize,
  mapIconArtDensity,
  mapIconArtSize,
  mapIconIdentityPrefix,
  mapIconRenderContract,
  mapIconSpawnMarkerSizePercent,
  validateMapIconRenderInput,
  type MapIconArtLayer,
  type MapIconArtObjectDescriptor,
  type MapIconRelief,
  type MapIconRenderInput,
  type MapIconSaveSize,
  type MapIconSpawnMarkerStyle,
  type PreviewGenerationResult,
  type SelectedMinimapPalette,
  type TexturePaletteDescriptor,
} from '../shared/api';
import { textureLookColors } from '../shared/texture-palette';
import {
  mapIconArtClassifier,
  mapIconArtFootprintFraction,
  mapIconArtLayerPlacements,
  mapIconArtMetrics,
  mapIconArtSizedCellPixels,
  mapIconSpriteAnchors,
  mapIconSpriteMaximumScale,
  scaleMapIconSprite,
  type MapIconArtObject,
  type MapIconArtPlacement,
  type MapIconArtSheets,
  type MapIconProcessedSheet,
  type MapIconScreenRect,
  type MapIconSprite,
} from './map-icon-art';
import {
  mapIconSpawnMarkerAnchor,
  mapIconSpawnMarkerCell,
  mapIconSpawnMarkerScale,
  mapIconSpawnMarkerWidthPixels,
} from './map-icon-player-markers';
import {
  minimapSquareCastlePolygon,
  minimapSquareClassifier,
  minimapSquareColor,
  minimapSquareDrawLayer,
  minimapSquarePolygon,
  minimapSquareSide,
  minimapSquareSizes,
  minimapSquareTownCenterBorderColor,
  type MinimapSquareClass,
  type MinimapSquareSizes,
} from './minimap-squares';
import {
  litColor,
  raisedLightStrength,
  raisedSurfaceFor,
  raisedWallLight,
  type ElevationSurface,
} from './preview-elevation';
import { cliffMaterial, previewHelperObjectIds, terrainMaterial } from './preview-materials';
import { terrainReliefLight } from './preview-terrain-mesh';
import {
  decodeTopDownScene,
  diamondBasisComponent,
  fitPreviewCamera,
  previewCliffStrokeWidth,
  previewProjectionVerticalScale,
  previewScale,
  type MapPoint,
  type PreviewViewport,
  type ScreenPoint,
  type TopDownScene,
} from './top-down-preview';

export const mapIconSize = mapIconRenderContract.size;
export const mapIconPaddingPixels = 16;
export const mapIconCornerRgba = 0x0000_0000;
export const mapIconMaximumMapDimension = 480;
export const mapIconMaximumObjects = 1_000_000;
export const mapIconMaximumCliffs = 4 * mapIconMaximumMapDimension * mapIconMaximumMapDimension;
export const mapIconMaximumShapeWork = 64 * 1024 * 1024;
export const mapIconPlayerOwners = Object.freeze({ minimum: 1, maximum: 8 });
export const mapIconTownCenterObjectId = 109;

export const mapIconTerrainSmoothingBandTiles = 0.5;
export const mapIconTerrainSmoothingMinimumPixels = 3;
export const mapIconTerrainSmoothingMaximumBandTiles = 8;

const cancellationRowStride = 32;
const cancellationItemStride = 1024;
const semanticHashPattern = /^[0-9a-f]{64}$/u;

export type MapIconRenderErrorCode =
  | 'invalid-dimensions'
  | 'invalid-map'
  | 'invalid-input'
  | 'too-many-objects'
  | 'too-many-cliffs'
  | 'work-limit'
  | 'art-unavailable'
  | 'cancelled';

export class MapIconRenderError extends Error {
  constructor(
    readonly code: MapIconRenderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MapIconRenderError';
  }
}

export interface MapIconStyle {
  backend: PreviewGenerationResult['backend'];
  minimapPalette: SelectedMinimapPalette | null;
  terrainNames: PreviewGenerationResult['terrainNames'];
  playerColorIds: readonly number[];
  relief: MapIconRelief;
  terrainSmoothing: boolean;
  spawnMarkers: MapIconSpawnMarkerStyle;
  spawnMarkerSizePercent: number;
  perspective: MapIconRenderInput['perspective'];
  look: MapIconRenderInput['look'];
  texturePalette?: TexturePaletteDescriptor | null;
  trees?: boolean;
  treeDensity?: number;
  treeSize?: number;
  treeSpawnOverlap?: boolean;
  resources?: boolean;
  resourceDensity?: number;
  resourceSize?: number;
  resourceSpawnOverlap?: boolean;
  artObjects?: readonly MapIconArtObjectDescriptor[];
  art?: MapIconArtSheets | null;
  minimapObjects?: boolean;
  helperObjectIds?: ReadonlySet<number>;
  raised?: ElevationSurface | null;
}

export function mapIconRaisedSurface(
  scene: Pick<TopDownScene, 'width' | 'height' | 'elevations'>,
  style: Pick<MapIconStyle, 'perspective' | 'relief'>,
): ElevationSurface | null {
  return effectiveMapIconRelief(style) === 'raised' ? raisedSurfaceFor(scene) : null;
}

export function mapIconRaisedLift(
  raised: ElevationSurface | null | undefined,
  point: MapPoint,
  projection: Pick<MapIconProjection, 'verticalComponent'>,
): number {
  return raised ? Math.round(raised.heightAt(point.x, point.y) * projection.verticalComponent) : 0;
}

export interface MapIconRenderOptions {
  signal?: AbortSignal;
  art?: MapIconArtSheets | null;
  size?: MapIconSaveSize;
}

export interface MapIconRender extends MapIconRenderInput {
  contractVersion: typeof mapIconRenderContract.version;
  size: MapIconSaveSize;
  mapWidth: number;
  mapHeight: number;
  sourceSemanticHash: string;
  gameTexturesSource?: string;
  pixels: Uint8ClampedArray;
}

export interface MapIconProjection {
  component: number;
  verticalComponent: number;
  centerX: number;
  centerY: number;
  halfMapWidth: number;
  halfMapHeight: number;
  scale: number;
  size?: number;
  pixelScale?: number;
}

export interface MapIconSpawn {
  owner: number;
  x: number;
  y: number;
  source: 'town-center' | 'centroid';
}

export function renderMapIcon(
  map: PreviewGenerationResult,
  input: MapIconRenderInput,
  options: MapIconRenderOptions = {},
): MapIconRender {
  let renderInput: Readonly<MapIconRenderInput>;
  try {
    renderInput = validateMapIconRenderInput(input);
  } catch (error) {
    throw new MapIconRenderError(
      'invalid-input',
      error instanceof Error ? error.message : 'map icon render input is invalid',
    );
  }
  if (renderInput.look === 'game-textures') {
    throw new MapIconRenderError(
      'invalid-input',
      'Game textures icons are drawn from the linked game textures',
    );
  }
  assertMapDimensions(map.width, map.height);
  if (typeof map.semanticHash !== 'string' || !semanticHashPattern.test(map.semanticHash)) {
    throw new MapIconRenderError('invalid-map', 'map semantic hash is invalid');
  }
  if (map.objects.owners.byteLength > mapIconMaximumObjects) {
    throw new MapIconRenderError('too-many-objects', 'map icon object count exceeds the limit');
  }
  if (map.cliffEdges.byteLength / 12 > mapIconMaximumCliffs) {
    throw new MapIconRenderError('too-many-cliffs', 'map icon cliff count exceeds the limit');
  }
  const size = options.size ?? mapIconRenderContract.size;
  if (!isMapIconSaveSize(size)) {
    throw new MapIconRenderError('invalid-input', 'map icon size is invalid');
  }
  if (mapIconNeedsArt(mapIconDrawnLayers(renderInput)) && !options.art) {
    throw new MapIconRenderError('art-unavailable', 'map icon sprite sheets are unavailable');
  }
  let scene: TopDownScene;
  try {
    scene = decodeTopDownScene(map, {
      appearances: renderInput.trees || renderInput.minimapObjects,
    });
  } catch (error) {
    throw new MapIconRenderError(
      'invalid-map',
      `map icon source is invalid: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  const pixels = renderMapIconScene(
    scene,
    {
      backend: map.backend,
      minimapPalette: map.minimapPalette,
      terrainNames: map.terrainNames,
      playerColorIds: map.playerColorIds,
      texturePalette: map.texturePalette ?? null,
      artObjects: map.mapIconArtObjects ?? [],
      art: options.art ?? null,
      helperObjectIds: previewHelperObjectIds(map, null),
      ...mapIconDrawnLayers(renderInput),
    },
    { ...options, size },
  );
  return {
    contractVersion: mapIconRenderContract.version,
    size,
    ...renderInput,
    mapWidth: map.width,
    mapHeight: map.height,
    sourceSemanticHash: map.semanticHash,
    pixels,
  };
}

export function renderMapIconScene(
  scene: TopDownScene,
  style: MapIconStyle,
  options: MapIconRenderOptions = {},
): Uint8ClampedArray {
  assertMapDimensions(scene.width, scene.height);
  if (scene.objects.length > mapIconMaximumObjects) {
    throw new MapIconRenderError('too-many-objects', 'map icon object count exceeds the limit');
  }
  if (scene.cliffs.length > mapIconMaximumCliffs) {
    throw new MapIconRenderError('too-many-cliffs', 'map icon cliff count exceeds the limit');
  }
  checkCancelled(options.signal);
  const size = options.size ?? mapIconSize;
  const projection = mapIconProjection(scene.width, scene.height, style.perspective, size);
  const canvas = new IconCanvas(size, options.signal, mapIconPixelScale(projection));
  canvas.clear(mapIconCornerRgba);
  const drawn = { ...style, ...mapIconDrawnLayers(style) };
  const raised = { ...drawn, raised: mapIconRaisedSurface(scene, style) };
  drawTerrain(canvas, scene, raised, projection);
  drawCliffs(canvas, scene, raised, projection);
  if (drawn.minimapObjects) drawMinimapObjects(canvas, scene, raised, projection);
  drawSprites(canvas, scene, raised, projection);
  return canvas.pixels;
}

export function mapIconDrawnLayers<
  T extends { minimapObjects?: boolean; trees?: boolean; resources?: boolean },
>(input: T): T {
  return input.minimapObjects ? { ...input, trees: false, resources: false } : input;
}

export function mapIconPixelScale(projection: Pick<MapIconProjection, 'pixelScale'>): number {
  return projection.pixelScale ?? 1;
}

export interface MapIconMinimapObjectDraw {
  kind: MinimapSquareClass;
  color: number;
  x: number;
  y: number;
}

export function mapIconMinimapObjectDraws(
  scene: Pick<TopDownScene, 'objects'>,
  style: Pick<MapIconStyle, 'playerColorIds' | 'spawnMarkers'> &
    Partial<Pick<MapIconStyle, 'artObjects' | 'minimapPalette' | 'helperObjectIds' | 'raised'>>,
  projection: MapIconProjection,
): MapIconMinimapObjectDraw[] {
  const classifier = minimapSquareClassifier({
    artObjects: style.artObjects,
    minimapPalette: style.minimapPalette,
    helperObjectIds: style.helperObjectIds,
  });
  const townCenterMarks = style.spawnMarkers === 'hidden';
  const layers: MapIconMinimapObjectDraw[][] = [[], [], [], []];
  for (const object of scene.objects) {
    const kind = classifier.classify(object);
    if (!kind || (kind === 'town-center' && !townCenterMarks)) continue;
    const screen = mapIconScreenPoint(object, projection);
    if (style.raised) {
      screen.y -= style.raised.heightAt(object.x, object.y) * projection.verticalComponent;
    }
    layers[minimapSquareDrawLayer(kind)]!.push({
      kind,
      color: minimapSquareColor(kind, object.owner, style.playerColorIds),
      x: screen.x,
      y: screen.y,
    });
  }
  return layers.flat();
}

export function mapIconTownCenterMarkScale(spawnMarkerSizePercent: number): number {
  return spawnMarkerSizePercent / mapIconSpawnMarkerSizePercent.default;
}

export function mapIconMinimapSquareSizes(
  projection: Pick<MapIconProjection, 'component' | 'verticalComponent' | 'pixelScale'>,
  spawnMarkerSizePercent: number = mapIconSpawnMarkerSizePercent.default,
): MinimapSquareSizes {
  const sizes = minimapSquareSizes({
    component: projection.component,
    baseComponent: projection.component,
    verticalScale: projection.verticalComponent / projection.component,
    unit: mapIconPixelScale(projection),
  });
  return {
    ...sizes,
    townCenter: sizes.townCenter * mapIconTownCenterMarkScale(spawnMarkerSizePercent),
  };
}

function drawMinimapObjects(
  canvas: IconCanvas,
  scene: Pick<TopDownScene, 'objects'>,
  style: Parameters<typeof mapIconMinimapObjectDraws>[1] &
    Pick<MapIconStyle, 'spawnMarkerSizePercent'>,
  projection: MapIconProjection,
): void {
  const pixelScale = mapIconPixelScale(projection);
  const sizes = mapIconMinimapSquareSizes(projection, style.spawnMarkerSizePercent);
  mapIconMinimapObjectDraws(scene, style, projection).forEach((draw, index) => {
    if (index % cancellationItemStride === 0) canvas.checkCancelled();
    if (draw.kind === 'town-center') {
      const polygon = minimapSquareCastlePolygon(draw.x, draw.y, sizes.townCenter);
      canvas.fillPolygon(polygon, draw.color);
      canvas.strokePolygon(
        polygon,
        mapIconMinimapBorderPixels * pixelScale,
        minimapSquareTownCenterBorderColor,
      );
      return;
    }
    canvas.fillPolygon(
      minimapSquarePolygon(draw.x, draw.y, minimapSquareSide(draw.kind, sizes)),
      draw.color,
    );
  });
}

export const mapIconMinimapBorderPixels = 1.5;

export function mapIconNeedsArt(
  input: Pick<MapIconRenderInput, 'trees' | 'resources' | 'spawnMarkers'>,
): boolean {
  return input.trees || input.resources || input.spawnMarkers !== 'hidden';
}

export function mapIconProjection(
  mapWidth: number,
  mapHeight: number,
  perspective: MapIconRenderInput['perspective'] = 'top-down',
  size: number = mapIconSize,
): MapIconProjection {
  assertMapDimensions(mapWidth, mapHeight);
  const camera = fitPreviewCamera(mapWidth, mapHeight);
  const viewport = mapIconViewport(perspective, size);
  const scale = previewScale(mapWidth, mapHeight, camera, viewport);
  const component = scale * diamondBasisComponent;
  return {
    component,
    verticalComponent: component * previewProjectionVerticalScale(viewport),
    centerX: size / 2,
    centerY: size / 2,
    halfMapWidth: camera.centerX,
    halfMapHeight: camera.centerY,
    scale,
    size,
    pixelScale: size / mapIconSize,
  };
}

export function mapIconViewport(
  perspective: MapIconRenderInput['perspective'] = 'top-down',
  size: number = mapIconSize,
): PreviewViewport {
  return {
    width: size,
    height: size,
    padding: (mapIconPaddingPixels * size) / mapIconSize,
    projection: perspective === 'diamond' ? 'minimap' : 'orthographic',
  };
}

export function mapIconEdgePixelsPerTile(
  projection: Pick<MapIconProjection, 'component' | 'verticalComponent'>,
): number {
  return projection.verticalComponent === projection.component
    ? projection.component * Math.SQRT2
    : Math.hypot(projection.component, projection.verticalComponent);
}

export function mapIconPerpendicularPixelsPerTile(
  projection: Pick<MapIconProjection, 'component' | 'verticalComponent'>,
): number {
  return projection.verticalComponent === projection.component
    ? projection.component * Math.SQRT2
    : (2 * projection.component * projection.verticalComponent) /
        Math.hypot(projection.component, projection.verticalComponent);
}

export function mapIconScreenPoint(point: MapPoint, projection: MapIconProjection): ScreenPoint {
  const relativeX = point.x - projection.halfMapWidth;
  const relativeY = point.y - projection.halfMapHeight;
  return {
    x: projection.centerX + (relativeX + relativeY) * projection.component,
    y: projection.centerY + (relativeY - relativeX) * projection.verticalComponent,
  };
}

export function mapIconSpawnPoints(
  scene: Pick<TopDownScene, 'objects'>,
  playerColorIds: readonly number[],
): MapIconSpawn[] {
  const { minimum, maximum } = mapIconPlayerOwners;
  const townCenters = new Map<number, MapPoint>();
  const sums = new Map<number, { x: number; y: number; count: number }>();
  for (const object of scene.objects) {
    if (object.owner < minimum || object.owner > maximum) continue;
    if (object.objectId === mapIconTownCenterObjectId && !townCenters.has(object.owner)) {
      townCenters.set(object.owner, { x: object.x, y: object.y });
    }
    const sum = sums.get(object.owner) ?? { x: 0, y: 0, count: 0 };
    sum.x += object.x;
    sum.y += object.y;
    sum.count += 1;
    sums.set(object.owner, sum);
  }
  const spawns: MapIconSpawn[] = [];
  for (let owner = minimum; owner <= maximum; owner += 1) {
    const colorId = playerColorIds[owner];
    if (colorId === undefined || !Number.isInteger(colorId) || colorId < 0) continue;
    const townCenter = townCenters.get(owner);
    if (townCenter) {
      spawns.push({ owner, ...townCenter, source: 'town-center' });
      continue;
    }
    const sum = sums.get(owner);
    if (sum) {
      spawns.push({ owner, x: sum.x / sum.count, y: sum.y / sum.count, source: 'centroid' });
    }
  }
  return spawns;
}

export async function mapIconRenderIdentity(
  render: Pick<
    MapIconRender,
    | 'pixels'
    | 'perspective'
    | 'look'
    | 'relief'
    | 'terrainSmoothing'
    | 'spawnMarkers'
    | 'spawnMarkerSizePercent'
    | 'trees'
    | 'treeDensity'
    | 'treeSize'
    | 'treeSpawnOverlap'
    | 'resources'
    | 'resourceDensity'
    | 'resourceSize'
    | 'resourceSpawnOverlap'
    | 'minimapObjects'
    | 'sourceSemanticHash'
    | 'gameTexturesSource'
  > & { size?: MapIconSaveSize },
): Promise<string> {
  const prefix = new TextEncoder().encode(
    mapIconIdentityPrefix(
      render.sourceSemanticHash,
      {
        perspective: render.perspective,
        look: render.look,
        relief: render.relief,
        terrainSmoothing: render.terrainSmoothing,
        spawnMarkers: render.spawnMarkers,
        spawnMarkerSizePercent: render.spawnMarkerSizePercent,
        trees: render.trees,
        treeDensity: render.treeDensity,
        treeSize: render.treeSize,
        treeSpawnOverlap: render.treeSpawnOverlap,
        resources: render.resources,
        resourceDensity: render.resourceDensity,
        resourceSize: render.resourceSize,
        resourceSpawnOverlap: render.resourceSpawnOverlap,
        minimapObjects: render.minimapObjects,
      },
      render.gameTexturesSource,
      render.size,
    ),
  );
  const input = new Uint8Array(prefix.byteLength + render.pixels.byteLength);
  input.set(prefix, 0);
  input.set(render.pixels, prefix.byteLength);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function assertMapDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > mapIconMaximumMapDimension ||
    height > mapIconMaximumMapDimension
  ) {
    throw new MapIconRenderError(
      'invalid-dimensions',
      `map icon dimensions must be 1-${mapIconMaximumMapDimension} tiles per edge`,
    );
  }
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MapIconRenderError('cancelled', 'map icon render was cancelled');
}

function drawTerrain(
  canvas: IconCanvas,
  scene: TopDownScene,
  style: MapIconStyle,
  projection: MapIconProjection,
): void {
  const { width, height } = scene;
  const tiles = width * height;
  const field: TerrainColorField = {
    width,
    height,
    baseColors: new Int32Array(tiles),
    tileLights: new Float32Array(tiles).fill(1),
    tileColors: new Int32Array(tiles),
    cornerColors: new Int32Array(0),
    beveled: new Uint8Array(tiles),
    relief: !style.raised && effectiveMapIconRelief(style) !== 'off',
    band: mapIconTerrainSmoothingBand(projection),
  };
  const materialColors = new Map<number, number>();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const terrainId = scene.terrainIds[index]!;
      let base = materialColors.get(terrainId);
      if (base === undefined) {
        base = terrainMaterial(
          terrainId,
          style.backend,
          style.minimapPalette,
          style.terrainNames,
          undefined,
          undefined,
          lookTerrainColors(style),
        ).color;
        materialColors.set(terrainId, base);
      }
      const light = field.relief ? terrainReliefLight(scene, x, y) : 1;
      field.baseColors[index] = base;
      field.tileLights[index] = light;
      field.tileColors[index] = litColor(base, light);
    }
  }
  if (style.terrainSmoothing) {
    const bevel = mapIconTerrainBevelCorners(scene.terrainIds, width, height);
    field.beveled = bevel.beveled;
    field.cornerColors = new Int32Array(tiles * 4).fill(noCornerCut);
    for (let slot = 0; slot < bevel.replacements.length; slot += 1) {
      const source = bevel.replacements[slot]!;
      if (source !== noCornerCut) field.cornerColors[slot] = field.baseColors[source]!;
    }
  }
  if (style.raised) {
    drawRaisedTerrain(canvas, style.raised, projection, (mapX, mapY, index) =>
      style.terrainSmoothing
        ? smoothTerrainColor(field, mapX, mapY, index)
        : field.tileColors[index]!,
    );
    return;
  }
  const inverse = 1 / projection.component;
  const verticalInverse = 1 / projection.verticalComponent;
  const size = canvas.size;
  for (let py = 0; py < size; py += 1) {
    if (py % cancellationRowStride === 0) canvas.checkCancelled();
    const v = (py + 0.5 - projection.centerY) * verticalInverse;
    for (let px = 0; px < size; px += 1) {
      const u = (px + 0.5 - projection.centerX) * inverse;
      const mapX = projection.halfMapWidth + (u - v) / 2;
      const mapY = projection.halfMapHeight + (u + v) / 2;
      if (mapX < 0 || mapY < 0 || mapX >= width || mapY >= height) continue;
      const index = Math.floor(mapY) * width + Math.floor(mapX);
      canvas.setPixel(
        px,
        py,
        style.terrainSmoothing
          ? smoothTerrainColor(field, mapX, mapY, index)
          : field.tileColors[index]!,
      );
    }
  }
}

function drawRaisedTerrain(
  canvas: IconCanvas,
  surface: ElevationSurface,
  projection: MapIconProjection,
  color: (mapX: number, mapY: number, index: number) => number,
): void {
  forEachRaisedIconPixel(
    canvas.size,
    surface,
    projection,
    (px, py, hit) => {
      const index = hit.tileY * surface.width + hit.tileX;
      const strength = raisedLightStrength.colorLooks;
      const light = hit.wall
        ? raisedWallLight(hit.wall, strength)
        : surface.tileLight(index, strength);
      canvas.setPixel(px, py, litColor(color(hit.x, hit.y, index), light));
    },
    () => canvas.checkCancelled(),
  );
}

export function forEachRaisedIconPixel(
  size: number,
  surface: ElevationSurface,
  projection: MapIconProjection,
  visit: (px: number, py: number, hit: RaisedIconHit) => void,
  checkCancelled: () => void = () => undefined,
): void {
  const inverse = 1 / projection.component;
  const verticalInverse = 1 / projection.verticalComponent;
  const s0 = projection.halfMapWidth + projection.halfMapHeight;
  const t0 = projection.halfMapHeight - projection.halfMapWidth;
  for (let px = 0; px < size; px += 1) {
    if (px % cancellationRowStride === 0) checkCancelled();
    const s = s0 + (px + 0.5 - projection.centerX) * inverse;
    let from = Number.NEGATIVE_INFINITY;
    for (let py = size - 1; py >= 0; py -= 1) {
      const t = t0 + (py + 0.5 - projection.centerY) * verticalInverse;
      const hit = surface.pickInto(s, t, from);
      if (!hit) {
        from = Number.NEGATIVE_INFINITY;
        continue;
      }
      from = hit.resumable ? hit.x - 1e-9 : Number.NEGATIVE_INFINITY;
      visit(px, py, hit);
    }
  }
}

export type RaisedIconHit = NonNullable<ReturnType<ElevationSurface['pickInto']>>;

export { litColor };

const noCornerCut = -1;
export const mapIconTerrainBevelLegTiles = 0.5;

const bevelCorners = [
  { sideX: -1, sideY: -1 },
  { sideX: 1, sideY: -1 },
  { sideX: -1, sideY: 1 },
  { sideX: 1, sideY: 1 },
] as const;

export interface MapIconTerrainBevel {
  replacements: Int32Array;
  beveled: Uint8Array;
}

export function mapIconTerrainBevelCorners(
  terrainIds: ArrayLike<number>,
  width: number,
  height: number,
): MapIconTerrainBevel {
  const replacements = new Int32Array(width * height * 4).fill(noCornerCut);
  const beveled = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const own = terrainIds[index]!;
      for (let slot = 0; slot < 4; slot += 1) {
        const { sideX, sideY } = bevelCorners[slot]!;
        const neighborX = x + sideX;
        const neighborY = y + sideY;
        if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) continue;
        const horizontal = y * width + neighborX;
        const other = terrainIds[horizontal]!;
        if (other === own || terrainIds[neighborY * width + x]! !== other) continue;
        if (terrainIds[neighborY * width + neighborX]! === own && own < other) continue;
        replacements[index * 4 + slot] = horizontal;
        beveled[index] = 1;
      }
    }
  }
  return { replacements, beveled };
}

interface TerrainColorField {
  width: number;
  height: number;
  baseColors: Int32Array;
  tileLights: Float32Array;
  tileColors: Int32Array;
  cornerColors: Int32Array;
  beveled: Uint8Array;
  relief: boolean;
  band: number;
}

export function mapIconTerrainSmoothingBand(
  projection: Pick<MapIconProjection, 'component' | 'verticalComponent' | 'pixelScale'>,
) {
  const pixelsPerTile = mapIconPerpendicularPixelsPerTile(projection);
  return Math.min(
    mapIconTerrainSmoothingMaximumBandTiles,
    Math.max(
      mapIconTerrainSmoothingBandTiles,
      (mapIconTerrainSmoothingMinimumPixels * mapIconPixelScale(projection)) / pixelsPerTile,
    ),
  );
}

function beveledBaseColor(
  field: TerrainColorField,
  mapX: number,
  mapY: number,
  index: number,
): number {
  const own = field.baseColors[index]!;
  if (field.beveled[index] === 0) return own;
  const fractionX = mapX - Math.floor(mapX);
  const fractionY = mapY - Math.floor(mapY);
  const right = fractionX >= 0.5;
  const bottom = fractionY >= 0.5;
  const cornerDistance = (right ? 1 - fractionX : fractionX) + (bottom ? 1 - fractionY : fractionY);
  if (cornerDistance >= mapIconTerrainBevelLegTiles) return own;
  const cut = field.cornerColors[index * 4 + (right ? 1 : 0) + (bottom ? 2 : 0)]!;
  return cut === noCornerCut ? own : cut;
}

function chamferArea(a: number, b: number): number {
  const leg = mapIconTerrainBevelLegTiles;
  const clampedA = a <= 0 ? 0 : a >= leg ? leg : a;
  const clampedB = b <= 0 ? 0 : b >= leg ? leg : b;
  const excess = clampedA + clampedB - leg;
  return clampedA * clampedB - (excess > 0 ? (excess * excess) / 2 : 0);
}

function smoothTerrainColor(
  field: TerrainColorField,
  mapX: number,
  mapY: number,
  index: number,
): number {
  const half = field.band / 2;
  const left = mapX - half;
  const right = mapX + half;
  const top = mapY - half;
  const bottom = mapY + half;
  const firstX = Math.floor(left);
  const lastX = Math.ceil(right) - 1;
  const firstY = Math.floor(top);
  const lastY = Math.ceil(bottom) - 1;
  const own = beveledBaseColor(field, mapX, mapY, index);
  if (own === field.baseColors[index]!) {
    let uniform = true;
    for (let tileY = firstY; tileY <= lastY && uniform; tileY += 1) {
      const clampedY = clampTile(tileY, field.height);
      const row = clampedY * field.width;
      for (let tileX = firstX; tileX <= lastX; tileX += 1) {
        const clampedX = clampTile(tileX, field.width);
        const tile = row + clampedX;
        const chamfered = field.beveled[tile] !== 0 && clampedX === tileX && clampedY === tileY;
        if (field.baseColors[tile] !== own || chamfered) {
          uniform = false;
          break;
        }
      }
    }
    if (uniform) return field.tileColors[index]!;
  }
  const area = field.band * field.band;
  let uniform = true;
  let red = 0;
  let green = 0;
  let blue = 0;
  const add = (color: number, overlap: number) => {
    if (!(overlap > 0)) return;
    if (color !== own) uniform = false;
    const weight = overlap / area;
    red += ((color >> 16) & 0xff) * weight;
    green += ((color >> 8) & 0xff) * weight;
    blue += (color & 0xff) * weight;
  };
  for (let tileY = firstY; tileY <= lastY; tileY += 1) {
    const y0 = Math.max(top, tileY) - tileY;
    const y1 = Math.min(bottom, tileY + 1) - tileY;
    const clampedY = clampTile(tileY, field.height);
    const row = clampedY * field.width;
    for (let tileX = firstX; tileX <= lastX; tileX += 1) {
      const x0 = Math.max(left, tileX) - tileX;
      const x1 = Math.min(right, tileX + 1) - tileX;
      const clampedX = clampTile(tileX, field.width);
      const tile = row + clampedX;
      let ownArea = (x1 - x0) * (y1 - y0);
      if (field.beveled[tile] !== 0 && clampedX === tileX && clampedY === tileY) {
        for (let slot = 0; slot < 4; slot += 1) {
          const cut = field.cornerColors[tile * 4 + slot]!;
          if (cut === noCornerCut) continue;
          const flipX = (slot & 1) !== 0;
          const flipY = (slot & 2) !== 0;
          const a0 = flipX ? 1 - x1 : x0;
          const a1 = flipX ? 1 - x0 : x1;
          const b0 = flipY ? 1 - y1 : y0;
          const b1 = flipY ? 1 - y0 : y1;
          const triangle =
            chamferArea(a1, b1) - chamferArea(a0, b1) - chamferArea(a1, b0) + chamferArea(a0, b0);
          ownArea -= triangle;
          add(cut, triangle);
        }
      }
      add(field.baseColors[tile]!, ownArea);
    }
  }
  const color = uniform ? own : (channel(red) << 16) | (channel(green) << 8) | channel(blue);
  return field.relief ? litColor(color, field.tileLights[index]!) : color;
}

function clampTile(tile: number, limit: number): number {
  return tile < 0 ? 0 : tile >= limit ? limit - 1 : tile;
}

function channel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

export function mapIconCliffStrokeWidth(
  projection: Pick<MapIconProjection, 'component' | 'pixelScale'>,
): number {
  const pixelScale = mapIconPixelScale(projection);
  return previewCliffStrokeWidth((projection.component * Math.SQRT2) / pixelScale) * pixelScale;
}

function lookTerrainColors(style: MapIconStyle): ReadonlyMap<number, number> | undefined {
  return style.look === 'texture-colors' && style.texturePalette
    ? textureLookColors(style.texturePalette).terrains
    : undefined;
}

function drawCliffs(
  canvas: IconCanvas,
  scene: TopDownScene,
  style: MapIconStyle,
  projection: MapIconProjection,
): void {
  const colors = new Map<number, number>();
  const textureCliffColors =
    style.look === 'texture-colors' && style.texturePalette
      ? textureLookColors(style.texturePalette).cliffs
      : undefined;
  const width = mapIconCliffStrokeWidth(projection);
  scene.cliffs.forEach((cliff, index) => {
    if (index % cancellationItemStride === 0) canvas.checkCancelled();
    let color = colors.get(cliff.cliffType);
    if (color === undefined) {
      color = cliffMaterial(cliff.cliffType, style.look, null, textureCliffColors).color;
      colors.set(cliff.cliffType, color);
    }
    const start = mapIconScreenPoint(cliff.from, projection);
    const end = mapIconScreenPoint(cliff.to, projection);
    if (style.raised) {
      start.y -= style.raised.heightAt(cliff.from.x, cliff.from.y) * projection.verticalComponent;
      end.y -= style.raised.heightAt(cliff.to.x, cliff.to.y) * projection.verticalComponent;
    }
    canvas.strokeSegment(start.x, start.y, end.x, end.y, width, color);
  });
}

export interface MapIconArtDraw {
  placement: MapIconArtPlacement;
  sprite: MapIconSprite;
  left: number;
  top: number;
  screenX: number;
  screenY: number;
  pushed: boolean;
}

export interface MapIconSpriteReach {
  minimumX: number;
  maximumX: number;
  minimumY: number;
  maximumY: number;
}

const spriteReaches = new WeakMap<MapIconSprite, Map<string, MapIconSpriteReach | null>>();

export function mapIconSpriteReach(
  sprite: MapIconSprite,
  projection: Pick<MapIconProjection, 'component' | 'verticalComponent'>,
): MapIconSpriteReach | null {
  let cache = spriteReaches.get(sprite);
  if (!cache) {
    cache = new Map();
    spriteReaches.set(sprite, cache);
  }
  const key = `${projection.component}:${projection.verticalComponent}`;
  if (cache.has(key)) return cache.get(key)!;
  let reach: MapIconSpriteReach | null = null;
  if (sprite.opaque) {
    const horizontal = 1 / (2 * projection.component);
    const vertical = 1 / (2 * projection.verticalComponent);
    reach = {
      minimumX: Number.POSITIVE_INFINITY,
      maximumX: Number.NEGATIVE_INFINITY,
      minimumY: Number.POSITIVE_INFINITY,
      maximumY: Number.NEGATIVE_INFINITY,
    };
    for (let y = sprite.opaque.top; y <= sprite.opaque.bottom; y += 1) {
      let first = -1;
      let last = -1;
      for (let x = sprite.opaque.left; x <= sprite.opaque.right; x += 1) {
        if (sprite.premultiplied[(y * sprite.width + x) * 4 + 3]! === 0) continue;
        if (first < 0) first = x;
        last = x;
      }
      if (first < 0) continue;
      for (const dx of [first - sprite.anchorX, last + 1 - sprite.anchorX]) {
        for (const dy of [y - sprite.anchorY, y + 1 - sprite.anchorY]) {
          const mapX = dx * horizontal - dy * vertical;
          const mapY = dx * horizontal + dy * vertical;
          if (mapX < reach.minimumX) reach.minimumX = mapX;
          if (mapX > reach.maximumX) reach.maximumX = mapX;
          if (mapY < reach.minimumY) reach.minimumY = mapY;
          if (mapY > reach.maximumY) reach.maximumY = mapY;
        }
      }
    }
  }
  cache.set(key, reach);
  return reach;
}

export function mapIconMapPoint(point: ScreenPoint, projection: MapIconProjection): MapPoint {
  const u = (point.x - projection.centerX) / projection.component;
  const v = (point.y - projection.centerY) / projection.verticalComponent;
  return {
    x: projection.halfMapWidth + (u - v) / 2,
    y: projection.halfMapHeight + (u + v) / 2,
  };
}

const containmentTolerance = 1e-9;

export function mapIconContainedArtPosition(
  placement: MapPoint,
  sprite: MapIconSprite,
  projection: MapIconProjection,
  mapWidth: number,
  mapHeight: number,
  { limitPush = true }: { limitPush?: boolean } = {},
): { screenX: number; screenY: number; pushed: boolean } | null {
  const reach = mapIconSpriteReach(sprite, projection);
  if (!reach || !sprite.opaque) return null;
  const fits = (screenX: number, screenY: number) => {
    const point = mapIconMapPoint({ x: screenX, y: screenY }, projection);
    return (
      point.x + reach.minimumX >= -containmentTolerance &&
      point.x + reach.maximumX <= mapWidth + containmentTolerance &&
      point.y + reach.minimumY >= -containmentTolerance &&
      point.y + reach.maximumY <= mapHeight + containmentTolerance
    );
  };
  const screen = mapIconScreenPoint(placement, projection);
  const screenX = Math.round(screen.x);
  const screenY = Math.round(screen.y);
  if (fits(screenX, screenY)) return { screenX, screenY, pushed: false };
  const margin = (0.5 / projection.component + 0.5 / projection.verticalComponent) / 2;
  const range = (low: number, high: number, value: number) =>
    low + margin <= high - margin
      ? clampNumber(value, low + margin, high - margin)
      : (low + high) / 2;
  const lowX = -reach.minimumX;
  const highX = mapWidth - reach.maximumX;
  const lowY = -reach.minimumY;
  const highY = mapHeight - reach.maximumY;
  if (lowX > highX || lowY > highY) return null;
  const pushed = mapIconScreenPoint(
    { x: range(lowX, highX, placement.x), y: range(lowY, highY, placement.y) },
    projection,
  );
  const pushedX = Math.round(pushed.x);
  const pushedY = Math.round(pushed.y);
  if (!fits(pushedX, pushedY)) return null;
  const limit = Math.max(
    sprite.opaque.right - sprite.opaque.left + 1,
    sprite.opaque.bottom - sprite.opaque.top + 1,
  );
  if (limitPush && Math.hypot(pushedX - screenX, pushedY - screenY) > limit) return null;
  return { screenX: pushedX, screenY: pushedY, pushed: true };
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

const scaledSprites = new WeakMap<MapIconProcessedSheet, Map<string, MapIconSprite>>();

function scaledSprite(
  sheet: MapIconProcessedSheet,
  cell: number,
  cellPixels: number,
  layer: MapIconArtLayer,
  pixelScale: number,
): MapIconSprite {
  let cache = scaledSprites.get(sheet);
  if (!cache) {
    cache = new Map();
    scaledSprites.set(sheet, cache);
  }
  const key = `${cell}:${cellPixels}:${pixelScale}`;
  let sprite = cache.get(key);
  if (!sprite) {
    const source = sheet.cells[cell];
    if (!source) throw new MapIconRenderError('art-unavailable', 'map icon sprite cell is missing');
    sprite = scaleMapIconSprite(
      source,
      Math.min(pixelScale, cellPixels / sheet.cellPixels),
      mapIconSpriteAnchors[layer],
      mapIconSpriteMaximumScale * pixelScale,
    );
    cache.set(key, sprite);
  }
  return sprite;
}

const scaledMarkerSprites = new WeakMap<MapIconProcessedSheet, Map<string, MapIconSprite>>();

function scaledMarkerSprite(
  sheet: MapIconProcessedSheet,
  cell: number,
  widthPixels: number,
  pixelScale: number,
): MapIconSprite {
  let cache = scaledMarkerSprites.get(sheet);
  if (!cache) {
    cache = new Map();
    scaledMarkerSprites.set(sheet, cache);
  }
  const key = `${cell}:${widthPixels}`;
  let sprite = cache.get(key);
  if (!sprite) {
    const source = sheet.cells[cell];
    if (!source) {
      throw new MapIconRenderError('art-unavailable', 'map icon spawn marker cell is missing');
    }
    const maximumScale = mapIconSpriteMaximumScale * pixelScale;
    sprite = scaleMapIconSprite(
      source,
      mapIconSpawnMarkerScale(source, widthPixels, maximumScale),
      mapIconSpawnMarkerAnchor(source),
      maximumScale,
    );
    cache.set(key, sprite);
  }
  return sprite;
}

export interface MapIconSpawnMarkerDraw {
  spawn: MapIconSpawn;
  cell: number;
  sprite: MapIconSprite;
  left: number;
  top: number;
  screenX: number;
  screenY: number;
  pushed: boolean;
  visible: MapIconScreenRect;
}

export function mapIconSpawnMarkerDraws(
  scene: Pick<TopDownScene, 'width' | 'height' | 'objects'>,
  style: Pick<
    MapIconStyle,
    'playerColorIds' | 'spawnMarkers' | 'spawnMarkerSizePercent' | 'art' | 'raised'
  >,
  projection: MapIconProjection,
): MapIconSpawnMarkerDraw[] {
  const kind = style.spawnMarkers;
  if (kind === 'hidden') return [];
  const art = style.art;
  if (!art) {
    throw new MapIconRenderError('art-unavailable', 'map icon sprite sheets are unavailable');
  }
  const sheet = kind === 'player-squares' ? art.players.squares : art.players.feet;
  const widthPixels = mapIconSpawnMarkerWidthPixels(
    projection,
    scene.width,
    style.spawnMarkerSizePercent,
  );
  const draws: MapIconSpawnMarkerDraw[] = [];
  for (const spawn of mapIconSpawnPoints(scene, style.playerColorIds)) {
    const cell = mapIconSpawnMarkerCell(spawn.owner, style.playerColorIds);
    const sprite = scaledMarkerSprite(sheet, cell, widthPixels, mapIconPixelScale(projection));
    if (!sprite.opaque) continue;
    let position = mapIconContainedArtPosition(
      spawn,
      sprite,
      projection,
      scene.width,
      scene.height,
      { limitPush: false },
    );
    if (!position) {
      const screen = mapIconScreenPoint(spawn, projection);
      position = { screenX: Math.round(screen.x), screenY: Math.round(screen.y), pushed: false };
    }
    const { screenX, pushed } = position;
    const screenY = position.screenY - mapIconRaisedLift(style.raised, spawn, projection);
    const left = screenX - sprite.anchorX;
    const top = screenY - sprite.anchorY;
    draws.push({
      spawn,
      cell,
      sprite,
      left,
      top,
      screenX,
      screenY,
      pushed,
      visible: {
        left: left + sprite.opaque.left,
        top: top + sprite.opaque.top,
        right: left + sprite.opaque.right,
        bottom: top + sprite.opaque.bottom,
      },
    });
  }
  draws.sort(
    (a, b) => a.screenY - b.screenY || a.screenX - b.screenX || a.spawn.owner - b.spawn.owner,
  );
  return draws;
}

export function mapIconRectsTouch(a: MapIconScreenRect, b: MapIconScreenRect): boolean {
  return a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
}

export function mapIconArtDraws(
  scene: Pick<TopDownScene, 'width' | 'height' | 'objects'>,
  style: MapIconArtStyle,
  projection: MapIconProjection,
): MapIconArtDraw[] {
  const layers: MapIconArtLayer[] = [];
  if (style.resources) layers.push('resources');
  if (style.trees) layers.push('trees');
  if (layers.length === 0) return [];
  const art = style.art;
  if (!art)
    throw new MapIconRenderError('art-unavailable', 'map icon sprite sheets are unavailable');
  const classifier = mapIconArtClassifier(style.artObjects);
  const objects: Record<MapIconArtLayer, MapIconArtObject[]> = { trees: [], resources: [] };
  for (const object of scene.objects) {
    const artClass = classifier.classify(object);
    if (!artClass) continue;
    objects[artClass.kind === 'tree' ? 'trees' : 'resources'].push({
      kind: artClass.kind,
      cell: artClass.cell,
      x: object.x,
      y: object.y,
    });
  }
  const markers = mapIconSpawnMarkerDraws(scene, style, projection).map((draw) => draw.visible);
  const metrics = mapIconArtMetrics(projection);
  const draws: (MapIconArtDraw & { order: number })[] = [];
  for (const layer of layers) {
    const sheet = layer === 'trees' ? art.trees : art.resources;
    const cellPixels = layer === 'trees' ? metrics.treeCellPixels : metrics.resourceCellPixels;
    const density =
      (layer === 'trees' ? style.treeDensity : style.resourceDensity) ?? mapIconArtDensity.default;
    const size =
      (layer === 'trees' ? style.treeSize : style.resourceSize) ?? mapIconArtSize.default;
    const overlap =
      (layer === 'trees' ? style.treeSpawnOverlap : style.resourceSpawnOverlap) ?? false;
    const placements = mapIconArtLayerPlacements(
      layer,
      objects[layer],
      density,
      (cellPixels * mapIconArtFootprintFraction) / metrics.pixelsPerTile,
      scene.width,
      scene.height,
    );
    const sizedCellPixels = mapIconArtSizedCellPixels(cellPixels, size);
    for (const placement of placements) {
      const sprite = scaledSprite(
        sheet,
        placement.cell,
        sizedCellPixels,
        layer,
        mapIconPixelScale(projection),
      );
      if (!sprite.opaque) continue;
      const position = mapIconContainedArtPosition(
        placement,
        sprite,
        projection,
        scene.width,
        scene.height,
      );
      if (!position) continue;
      const { screenX, pushed } = position;
      const screenY = position.screenY - mapIconRaisedLift(style.raised, placement, projection);
      const left = screenX - sprite.anchorX;
      const top = screenY - sprite.anchorY;
      if (!overlap && markers.length > 0) {
        const rect = {
          left: left + sprite.opaque.left,
          top: top + sprite.opaque.top,
          right: left + sprite.opaque.right,
          bottom: top + sprite.opaque.bottom,
        };
        if (markers.some((marker) => mapIconRectsTouch(rect, marker))) continue;
      }
      draws.push({ placement, sprite, left, top, screenX, screenY, pushed, order: draws.length });
    }
  }
  const layerOrder = (layer: MapIconArtLayer) => (layer === 'resources' ? 0 : 1);
  draws.sort(
    (a, b) =>
      a.screenY - b.screenY ||
      a.screenX - b.screenX ||
      layerOrder(a.placement.layer) - layerOrder(b.placement.layer) ||
      a.placement.cell - b.placement.cell ||
      a.order - b.order,
  );
  return draws.map(({ order: _order, ...draw }) => draw);
}

export type MapIconArtStyle = Partial<
  Pick<MapIconStyle, 'minimapObjects' | 'minimapPalette' | 'helperObjectIds'>
> &
  Pick<
    MapIconStyle,
    | 'playerColorIds'
    | 'spawnMarkers'
    | 'spawnMarkerSizePercent'
    | 'trees'
    | 'treeDensity'
    | 'treeSize'
    | 'treeSpawnOverlap'
    | 'resources'
    | 'resourceDensity'
    | 'resourceSize'
    | 'resourceSpawnOverlap'
    | 'artObjects'
    | 'art'
    | 'raised'
  >;

export function renderMapIconArtLayer(
  scene: Pick<TopDownScene, 'width' | 'height' | 'objects'>,
  style: MapIconArtStyle,
  projection: MapIconProjection,
): Uint8ClampedArray {
  const canvas = new IconCanvas(
    projection.size ?? mapIconSize,
    undefined,
    mapIconPixelScale(projection),
  );
  canvas.clear(0);
  const drawn = { ...style, ...mapIconDrawnLayers(style) };
  if (drawn.minimapObjects) drawMinimapObjects(canvas, scene, drawn, projection);
  if (drawn.art) drawSprites(canvas, scene, drawn, projection);
  return canvas.pixels;
}

function drawSprites(
  canvas: IconCanvas,
  scene: Pick<TopDownScene, 'width' | 'height' | 'objects'>,
  style: MapIconArtStyle,
  projection: MapIconProjection,
): void {
  canvas.checkCancelled();
  mapIconArtDraws(scene, style, projection).forEach((draw, index) => {
    if (index % cancellationItemStride === 0) canvas.checkCancelled();
    canvas.drawSprite(draw.sprite, draw.left, draw.top);
  });
  canvas.checkCancelled();
  for (const marker of mapIconSpawnMarkerDraws(scene, style, projection)) {
    canvas.drawSprite(marker.sprite, marker.left, marker.top);
  }
}

class IconCanvas {
  readonly pixels: Uint8ClampedArray;
  private work = 0;
  private readonly workLimit: number;

  constructor(
    readonly size: number,
    private readonly signal: AbortSignal | undefined,
    pixelScale = 1,
  ) {
    this.pixels = new Uint8ClampedArray(size * size * 4);
    this.workLimit = mapIconMaximumShapeWork * Math.max(1, pixelScale * pixelScale);
  }

  checkCancelled(): void {
    checkCancelled(this.signal);
  }

  clear(rgba: number): void {
    const red = (rgba >>> 24) & 0xff;
    const green = (rgba >>> 16) & 0xff;
    const blue = (rgba >>> 8) & 0xff;
    const alpha = rgba & 0xff;
    for (let offset = 0; offset < this.pixels.length; offset += 4) {
      this.pixels[offset] = red;
      this.pixels[offset + 1] = green;
      this.pixels[offset + 2] = blue;
      this.pixels[offset + 3] = alpha;
    }
  }

  setPixel(x: number, y: number, rgb: number): void {
    const offset = (y * this.size + x) * 4;
    this.pixels[offset] = (rgb >> 16) & 0xff;
    this.pixels[offset + 1] = (rgb >> 8) & 0xff;
    this.pixels[offset + 2] = rgb & 0xff;
    this.pixels[offset + 3] = 0xff;
  }

  strokeSegment(x0: number, y0: number, x1: number, y1: number, width: number, rgb: number): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lengthSquared = dx * dx + dy * dy;
    if (!(lengthSquared > 0) || !Number.isFinite(lengthSquared)) return;
    const half = width / 2;
    const limit = half * half;
    const bounds = this.clippedBounds(
      Math.min(x0, x1) - half,
      Math.min(y0, y1) - half,
      Math.max(x0, x1) + half,
      Math.max(y0, y1) + half,
    );
    if (!bounds) return;
    for (let py = bounds.minimumY; py <= bounds.maximumY; py += 1) {
      const sampleY = py + 0.5 - y0;
      for (let px = bounds.minimumX; px <= bounds.maximumX; px += 1) {
        const sampleX = px + 0.5 - x0;
        const along = Math.min(lengthSquared, Math.max(0, sampleX * dx + sampleY * dy));
        const t = along / lengthSquared;
        const offsetX = sampleX - t * dx;
        const offsetY = sampleY - t * dy;
        if (offsetX * offsetX + offsetY * offsetY <= limit) this.setPixel(px, py, rgb);
      }
    }
  }

  fillPolygon(points: readonly number[], rgb: number): void {
    const count = points.length / 2;
    if (count < 3) return;
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < count; index += 1) {
      const x = points[index * 2]!;
      const y = points[index * 2 + 1]!;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
    const bounds = this.clippedBounds(left, top, right, bottom);
    if (!bounds) return;
    for (let py = bounds.minimumY; py <= bounds.maximumY; py += 1) {
      const sampleY = py + 0.5;
      for (let px = bounds.minimumX; px <= bounds.maximumX; px += 1) {
        const sampleX = px + 0.5;
        let inside = false;
        for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
          const x0 = points[index * 2]!;
          const y0 = points[index * 2 + 1]!;
          const x1 = points[previous * 2]!;
          const y1 = points[previous * 2 + 1]!;
          if (
            y0 > sampleY !== y1 > sampleY &&
            sampleX < ((x1 - x0) * (sampleY - y0)) / (y1 - y0) + x0
          ) {
            inside = !inside;
          }
        }
        if (inside) this.setPixel(px, py, rgb);
      }
    }
  }

  strokePolygon(points: readonly number[], width: number, rgb: number): void {
    const count = points.length / 2;
    for (let index = 0; index < count; index += 1) {
      const next = (index + 1) % count;
      this.strokeSegment(
        points[index * 2]!,
        points[index * 2 + 1]!,
        points[next * 2]!,
        points[next * 2 + 1]!,
        width,
        rgb,
      );
    }
  }

  drawSprite(sprite: MapIconSprite, left: number, top: number): void {
    const bounds = this.clippedBounds(left, top, left + sprite.width - 1, top + sprite.height - 1);
    if (!bounds) return;
    for (let py = bounds.minimumY; py <= bounds.maximumY; py += 1) {
      for (let px = bounds.minimumX; px <= bounds.maximumX; px += 1) {
        const source = ((py - top) * sprite.width + (px - left)) * 4;
        const alpha = sprite.premultiplied[source + 3]!;
        if (alpha === 0) continue;
        const target = (py * this.size + px) * 4;
        const remaining = (255 - alpha) / 255;
        const destinationAlpha = this.pixels[target + 3]!;
        const outAlpha = alpha + destinationAlpha * remaining;
        const destinationWeight = (destinationAlpha * remaining) / 255;
        for (let channel = 0; channel < 3; channel += 1) {
          const premultiplied =
            sprite.premultiplied[source + channel]! +
            this.pixels[target + channel]! * destinationWeight;
          this.pixels[target + channel] = Math.round((premultiplied * 255) / outAlpha);
        }
        this.pixels[target + 3] = Math.round(outAlpha);
      }
    }
  }

  private clippedBounds(
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): { minimumX: number; minimumY: number; maximumX: number; maximumY: number } | null {
    if (![left, top, right, bottom].every(Number.isFinite)) return null;
    const minimumX = Math.max(0, Math.floor(left));
    const minimumY = Math.max(0, Math.floor(top));
    const maximumX = Math.min(this.size - 1, Math.ceil(right));
    const maximumY = Math.min(this.size - 1, Math.ceil(bottom));
    if (minimumX > maximumX || minimumY > maximumY) return null;
    this.work += (maximumX - minimumX + 1) * (maximumY - minimumY + 1);
    if (this.work > this.workLimit) {
      throw new MapIconRenderError('work-limit', 'map icon shape work exceeds the limit');
    }
    return { minimumX, minimumY, maximumX, maximumY };
  }
}
