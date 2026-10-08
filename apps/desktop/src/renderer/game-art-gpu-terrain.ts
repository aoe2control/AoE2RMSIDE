import {
  Buffer,
  BufferImageSource,
  BufferUsage,
  CanvasSource,
  Container,
  Geometry,
  GlProgram,
  ImageSource,
  Mesh,
  Shader,
  Texture,
  type TextureSource,
} from 'pixi.js';
import { blendAtlasCell, noTerrainLayer, tileBlendQuads, type BlendGrid } from './game-art-blend';
import {
  chunkShading,
  type GameArtTerrainScene,
  type GameArtTerrainSource,
  type GameArtTerrainSources,
  type GameArtTerrainStatistics,
  type TerrainChunkPlan,
  type TerrainChunkShading,
  type TerrainTileOverlay,
} from './game-art-terrain';
import { gameArtTextureRepeatTiles } from '../shared/game-art';
import type { VisibleChunk } from './top-down-preview';

export type GpuTerrainDraw =
  | { kind: 'solid'; color: number; quads: Int16Array }
  | { kind: 'texture'; terrain: number; mask: number | null; quads: Int16Array }
  | {
      kind: 'blend';
      terrain: number;
      mask: number | null;
      mode: number;
      quads: Int16Array;
    };

export function planTerrainMap(
  scene: GameArtTerrainScene,
  terrains: PlannedTerrains,
  hasAtlas: (mode: number) => boolean,
): TerrainChunkPlan {
  const steps = planTerrainMapRows(scene, terrains, hasAtlas);
  for (let step = steps.next(); ; step = steps.next()) if (step.done) return step.value;
}

type PlannedTerrains = ReadonlyMap<
  number,
  Pick<GameArtTerrainSource, 'blendPriority' | 'blendType' | 'texture' | 'overlayMask' | 'color'>
>;

export function* planTerrainMapRows(
  scene: GameArtTerrainScene,
  terrains: PlannedTerrains,
  hasAtlas: (mode: number) => boolean,
): Generator<number, TerrainChunkPlan, void> {
  const { width, height } = scene;
  const count = width * height;
  const pairTerrain = new Uint32Array(count);
  const pairLayer = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    const terrain = scene.terrainIds[index] ?? 0;
    const layer = scene.layerIds[index] ?? noTerrainLayer;
    pairTerrain[index] = terrain;
    pairLayer[index] =
      layer !== noTerrainLayer && layer !== terrain && terrains.has(layer) ? layer : noTerrainLayer;
  }
  const plan: TerrainChunkPlan = {
    minimumX: 0,
    minimumY: 0,
    width,
    height,
    base: new Map(),
    fallback: new Map(),
    layers: new Map(),
    blends: [],
    shading: null,
  };
  const push = <K>(map: Map<K, number[]>, key: K, tile: number) => {
    const tiles = map.get(key);
    if (tiles) tiles.push(tile);
    else map.set(key, [tile]);
  };
  const grid: BlendGrid = {
    width,
    height,
    pairAt: (x, y) => {
      const index = y * width + x;
      return { terrain: pairTerrain[index]!, layer: pairLayer[index]! };
    },
  };
  const blendGroups = new Map<string, TerrainChunkPlan['blends'][number] & { key: number }>();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const terrainId = pairTerrain[index]!;
      const layerId = pairLayer[index]!;
      const terrain = terrains.get(terrainId);
      if (terrain?.texture) push(plan.base, terrainId, index);
      else push(plan.fallback, terrain?.color ?? 0x808080, index);
      if (layerId !== noTerrainLayer) {
        const layer = terrains.get(layerId);
        if (layer?.texture && layer.overlayMask) push(plan.layers, layerId, index);
      }
      let uniform = true;
      for (let dy = -1; dy <= 1 && uniform; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbour = ny * width + nx;
          if (pairTerrain[neighbour] !== terrainId || pairLayer[neighbour] !== layerId) {
            uniform = false;
            break;
          }
        }
      }
      if (uniform) continue;
      for (const quad of tileBlendQuads(grid, x, y, terrains)) {
        if (!hasAtlas(quad.mode) || !terrains.get(quad.upper.terrain)?.texture) continue;
        const groupKey = `${quad.upperKey}:${quad.upper.terrain}:${quad.upper.layer}:${quad.mode}`;
        let group = blendGroups.get(groupKey);
        if (!group) {
          group = { key: quad.upperKey, upper: quad.upper, mode: quad.mode, quads: [] };
          blendGroups.set(groupKey, group);
        }
        group.quads.push({ tile: index, cell: quad.tile });
      }
    }
    yield y;
  }
  plan.blends = [...blendGroups.values()]
    .sort(
      (left, right) =>
        left.key - right.key ||
        left.upper.terrain - right.upper.terrain ||
        left.upper.layer - right.upper.layer ||
        left.mode - right.mode,
    )
    .map(({ upper, mode, quads }) => ({ upper, mode, quads }));
  return plan;
}

export const plainVertexWords = 2;
export const blendVertexWords = 8;
export const blendCellSlots = 8;
export const noBlendCell = 255;

function layerPoint(x: number, y: number): [number, number] {
  return [x + y, y - x];
}

export function runQuads(tiles: readonly number[], width: number): Int16Array {
  const runs: number[] = [];
  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index]!;
    const x = tile % width;
    const y = (tile - x) / width;
    const last = runs.length - 3;
    if (last >= 0 && runs[last + 2] === y && runs[last + 1] === x) runs[last + 1] = x + 1;
    else runs.push(x, x + 1, y);
  }
  const quads = new Int16Array((runs.length / 3) * 4 * plainVertexWords);
  for (let run = 0, word = 0; run < runs.length; run += 3) {
    const start = runs[run]!;
    const end = runs[run + 1]!;
    const y = runs[run + 2]!;
    quads[word++] = start + y;
    quads[word++] = y - start;
    quads[word++] = end + y;
    quads[word++] = y - end;
    quads[word++] = end + y + 1;
    quads[word++] = y + 1 - end;
    quads[word++] = start + y + 1;
    quads[word++] = y + 1 - start;
  }
  return quads;
}

export function blendCellCode(cell: number): number {
  const { row, column } = blendAtlasCell(cell);
  return row * 8 + column;
}

export function blendQuads(
  quads: readonly { tile: number; cell: number }[],
  width: number,
): Int16Array {
  const order: number[] = [];
  const cellsByTile = new Map<number, number[]>();
  for (const quad of quads) {
    const cells = cellsByTile.get(quad.tile);
    if (cells) cells.push(blendCellCode(quad.cell));
    else {
      cellsByTile.set(quad.tile, [blendCellCode(quad.cell)]);
      order.push(quad.tile);
    }
  }
  const data = new Int16Array(order.length * 4 * blendVertexWords);
  const bytes = new Uint8Array(data.buffer);
  for (const [index, tile] of order.entries()) {
    const cells = cellsByTile.get(tile)!;
    if (cells.length > blendCellSlots) throw new Error('too many transition quads on one tile');
    const x = tile % width;
    const y = (tile - x) / width;
    for (let corner = 0; corner < 4; corner += 1) {
      const cornerX = corner === 1 || corner === 2 ? 1 : 0;
      const cornerY = corner >= 2 ? 1 : 0;
      const word = (index * 4 + corner) * blendVertexWords;
      data[word] = x + cornerX + y + cornerY;
      data[word + 1] = y + cornerY - x - cornerX;
      const byte = word * 2;
      bytes[byte + 4] = cornerX;
      bytes[byte + 5] = cornerY;
      for (let slot = 0; slot < blendCellSlots; slot += 1) {
        bytes[byte + 8 + slot] = cells[slot] ?? noBlendCell;
      }
    }
  }
  return data;
}

export function blendVertex(
  data: Int16Array,
  vertex: number,
): { position: [number, number]; corner: [number, number]; cells: number[] } {
  const word = vertex * blendVertexWords;
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const byte = word * 2;
  return {
    position: [data[word]!, data[word + 1]!],
    corner: [bytes[byte + 4]!, bytes[byte + 5]!],
    cells: [...bytes.slice(byte + 8, byte + 16)].filter((cell) => cell !== noBlendCell),
  };
}

export function gpuTerrainDraws(
  plan: TerrainChunkPlan,
  sources: Pick<GameArtTerrainSources, 'terrains' | 'atlases'>,
): GpuTerrainDraw[] {
  return [...gpuTerrainDrawSteps(plan, sources)];
}

export function* gpuTerrainDrawSteps(
  plan: TerrainChunkPlan,
  sources: Pick<GameArtTerrainSources, 'terrains' | 'atlases'>,
): Generator<GpuTerrainDraw, void, void> {
  for (const [color, tiles] of plan.fallback) {
    yield { kind: 'solid', color, quads: runQuads(tiles, plan.width) };
  }
  for (const [terrain, tiles] of plan.base) {
    if (!sources.terrains.get(terrain)?.texture) continue;
    yield { kind: 'texture', terrain, mask: null, quads: runQuads(tiles, plan.width) };
  }
  for (const [layer, tiles] of plan.layers) {
    const source = sources.terrains.get(layer);
    if (!source?.texture || !source.overlayMask) continue;
    yield {
      kind: 'texture',
      terrain: layer,
      mask: layer,
      quads: runQuads(tiles, plan.width),
    };
  }
  for (const group of plan.blends) {
    const upper = sources.terrains.get(group.upper.terrain);
    if (!sources.atlases[group.mode] || !upper?.texture) continue;
    const quads = blendQuads(group.quads, plan.width);
    yield {
      kind: 'blend',
      terrain: group.upper.terrain,
      mask: null,
      mode: group.mode,
      quads,
    };
    if (group.upper.layer !== noTerrainLayer) {
      const layered = sources.terrains.get(group.upper.layer);
      if (layered?.texture && layered.overlayMask) {
        yield {
          kind: 'blend',
          terrain: group.upper.layer,
          mask: group.upper.layer,
          mode: group.mode,
          quads,
        };
      }
    }
  }
}

export function mapShading(
  scene: Pick<GameArtTerrainScene, 'width' | 'height'>,
  overlay: TerrainTileOverlay,
): TerrainChunkShading | null {
  const ringed = chunkShading(
    scene,
    { minimumX: 0, minimumY: 0, maximumX: scene.width - 1, maximumY: scene.height - 1 },
    overlay,
  );
  if (!ringed) return null;
  const pixels = new Uint8ClampedArray(scene.width * scene.height * 4);
  for (let y = 0; y < scene.height; y += 1) {
    for (let x = 0; x < scene.width; x += 1) {
      const from = ((y + 1) * ringed.width + x + 1) * 4;
      const to = (y * scene.width + x) * 4;
      const alpha = ringed.pixels[from + 3]!;
      pixels[to] = Math.round((ringed.pixels[from]! * alpha) / 255);
      pixels[to + 1] = Math.round((ringed.pixels[from + 1]! * alpha) / 255);
      pixels[to + 2] = Math.round((ringed.pixels[from + 2]! * alpha) / 255);
      pixels[to + 3] = alpha;
    }
  }
  return { width: scene.width, height: scene.height, pixels };
}

export function gpuTerrainDrawBytes(draws: readonly GpuTerrainDraw[]): number {
  let bytes = 0;
  const counted = new Set<Int16Array>();
  for (const draw of draws) {
    if (counted.has(draw.quads)) continue;
    counted.add(draw.quads);
    const words = draw.kind === 'blend' ? blendVertexWords : plainVertexWords;
    const quadCount = draw.quads.length / (4 * words);
    bytes += draw.quads.byteLength + quadCount * 6 * 4;
  }
  return bytes;
}

const vertexHeader = `#version 300 es
precision highp float;
in vec2 aPosition;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vMap;
`;

const vertexPosition = `
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  // The layer's local point (x + y, y - x) back to map point (x, y).
  vMap = vec2(aPosition.x - aPosition.y, aPosition.x + aPosition.y) * 0.5;
`;

export const gpuTerrainPlainVertex = `${vertexHeader}
void main() {${vertexPosition}}
`;

export const gpuTerrainBlendVertex = `${vertexHeader}
in vec4 aLocal;
in vec4 aCells;
in vec4 aMoreCells;
out vec2 vLocal;
flat out vec4 vCells;
flat out vec4 vMoreCells;
void main() {${vertexPosition}
  vLocal = aLocal.xy;
  vCells = aCells;
  vMoreCells = aMoreCells;
}
`;

export const gpuTerrainKinds = { solid: 0, texture: 1, shading: 2 } as const;

const fragmentHeader = `#version 300 es
precision highp float;
in vec2 vMap;
uniform sampler2D uTexture;
uniform sampler2D uMask;
uniform vec4 uColor;
uniform float uKind;
uniform float uUseMask;
uniform float uRepeat;
uniform vec3 uSolid;
uniform vec2 uMapSize;
out vec4 finalColor;
// A tiling texture as the CPU path's canvas pattern samples it: bilinear in
// the finest mip level at least as coarse as the pixel's footprint.
vec4 canvasSample(sampler2D image, vec2 uv) {
  vec2 texel = uv * vec2(textureSize(image, 0));
  float footprint = max(length(dFdx(texel)), length(dFdy(texel)));
  float lod = max(floor(log2(max(footprint, 1e-6))), 0.0);
  return textureLod(image, uv, lod);
}
// The Mitchell-Netravali cubic (B = C = 1/3).
float mitchell(float x) {
  x = abs(x);
  if (x < 1.0) return (7.0 * x * x * x - 12.0 * x * x + 16.0 / 3.0) / 6.0;
  if (x < 2.0) return (-7.0 / 3.0 * x * x * x + 12.0 * x * x - 20.0 * x + 32.0 / 3.0) / 6.0;
  return 0.0;
}
vec4 shadeCubic(vec2 map) {
  vec2 position = map - 0.5;
  vec2 base = floor(position);
  vec2 fraction = position - base;
  ivec2 last = ivec2(uMapSize) - 1;
  vec4 sum = vec4(0.0);
  for (int j = -1; j <= 2; j++) {
    float wy = mitchell(float(j) - fraction.y);
    for (int i = -1; i <= 2; i++) {
      ivec2 texel = clamp(ivec2(base) + ivec2(i, j), ivec2(0), last);
      sum += texelFetch(uTexture, texel, 0) * mitchell(float(i) - fraction.x) * wy;
    }
  }
  float alpha = clamp(sum.a, 0.0, 1.0);
  return vec4(clamp(sum.rgb, vec3(0.0), vec3(alpha)), alpha);
}
`;

const fragmentBody = `
  vec4 color;
  if (uKind < 0.5) {
    color = vec4(uSolid, 1.0);
  } else if (uKind < 1.5) {
    vec2 uv = vMap / uRepeat;
    color = vec4(canvasSample(uTexture, uv).rgb, 1.0);
    if (uUseMask > 0.5) color.a = texture(uMask, uv).a;
  } else {
    // Premultiplied shading texels, one per tile centre, filtered with the
    // cubic the CPU path's canvas uses when it enlarges them.
    finalColor = shadeCubic(vMap) * uColor.a;
    return;
  }
`;

export const gpuTerrainPlainFragment = `${fragmentHeader}
void main() {${fragmentBody}
  float alpha = color.a * uColor.a;
  finalColor = vec4(color.rgb * uColor.rgb * alpha, alpha);
}
`;

export const gpuTerrainBlendFragment = `${fragmentHeader}
in vec2 vLocal;
flat in vec4 vCells;
flat in vec4 vMoreCells;
uniform sampler2D uAtlas;
uniform float uAtlasSize;
float cellAlpha(float code, float lod, float inset, float cellTexels) {
  vec2 cell = vec2(mod(code, 8.0), floor(code / 8.0));
  vec2 local = clamp(vLocal * cellTexels, vec2(inset), vec2(cellTexels - inset));
  return textureLod(uAtlas, (cell * cellTexels + local) / uAtlasSize, lod).a;
}
// The union of the group's cells on this tile (each cell drawn over the
// others), as one alpha.
float atlasAlpha() {
  float cellTexels = uAtlasSize / 8.0;
  vec2 texel = vLocal * cellTexels;
  float footprint = max(length(dFdx(texel)), length(dFdy(texel)));
  float lod = clamp(log2(max(footprint, 1e-6)), 0.0, 3.0);
  float inset = 0.5 * exp2(lod);
  float clear = 1.0;
  for (int slot = 0; slot < 8; slot++) {
    float code = slot < 4 ? vCells[slot] : vMoreCells[slot - 4];
    if (code > 63.5) continue;
    clear *= 1.0 - cellAlpha(code, lod, inset, cellTexels);
  }
  return 1.0 - clear;
}
void main() {${fragmentBody}
  float alpha = color.a * atlasAlpha() * uColor.a;
  finalColor = vec4(color.rgb * uColor.rgb * alpha, alpha);
}
`;

let plainProgram: GlProgram | null = null;
let blendProgram: GlProgram | null = null;

function programs(): { plain: GlProgram; blend: GlProgram } {
  plainProgram ??= GlProgram.from({
    name: 'rmside-terrain',
    vertex: gpuTerrainPlainVertex,
    fragment: gpuTerrainPlainFragment,
    preferredFragmentPrecision: 'highp',
  });
  blendProgram ??= GlProgram.from({
    name: 'rmside-terrain-blend',
    vertex: gpuTerrainBlendVertex,
    fragment: gpuTerrainBlendFragment,
    preferredFragmentPrecision: 'highp',
  });
  return { plain: plainProgram, blend: blendProgram };
}

export function gpuTextureSource(image: CanvasImageSource, repeat: boolean): TextureSource {
  const options = {
    autoGenerateMipmaps: true,
    addressMode: repeat ? ('repeat' as const) : ('clamp-to-edge' as const),
    scaleMode: 'linear' as const,
    mipmapFilter: 'linear' as const,
  };
  return typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap
    ? new ImageSource({ resource: image, ...options })
    : new CanvasSource({ resource: image as HTMLCanvasElement, ...options });
}

function quadIndices(quadCount: number): Uint32Array {
  const indices = new Uint32Array(quadCount * 6);
  for (let quad = 0; quad < quadCount; quad += 1) {
    const vertex = quad * 4;
    indices.set([vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3], quad * 6);
  }
  return indices;
}

function drawGeometry(quads: Int16Array, words: number): Geometry {
  const buffer = new Buffer({ data: quads, usage: BufferUsage.VERTEX });
  const stride = words * 2;
  return new Geometry({
    attributes:
      words === blendVertexWords
        ? {
            aPosition: { buffer, format: 'sint16x2', stride, offset: 0 },
            aLocal: { buffer, format: 'uint8x4', stride, offset: 4 },
            aCells: { buffer, format: 'uint8x4', stride, offset: 8 },
            aMoreCells: { buffer, format: 'uint8x4', stride, offset: 12 },
          }
        : { aPosition: { buffer, format: 'sint16x2', stride, offset: 0 } },
    indexBuffer: quadIndices(quads.length / (4 * words)),
  });
}

export const gpuTerrainPlanBudgetMilliseconds = 12;

export class GameArtGpuTerrainLayer {
  readonly container = new Container({ label: 'game-textures-terrain-gpu' });
  readonly renderer = 'gpu' as const;
  private readonly sources = new Map<CanvasImageSource, TextureSource>();
  private readonly geometries: Geometry[] = [];
  private readonly shaders: Shader[] = [];
  private shadingSource: TextureSource | null = null;
  private shown = false;
  private destroyed = false;
  readonly statistics: GameArtTerrainStatistics = {
    rasterizedChunks: 0,
    pendingChunks: 1,
    failedChunks: 0,
    textureBytes: 0,
    lastRasterMilliseconds: 0,
    totalRasterMilliseconds: 0,
  };
  drawCount = 0;
  private readonly planner: Generator<number, TerrainChunkPlan, void>;
  private draws: Generator<GpuTerrainDraw, void, void> | null = null;
  private readonly geometryByQuads = new Map<Int16Array, Geometry>();
  private frame: number | null = null;
  private readonly glPrograms: { plain: GlProgram; blend: GlProgram };

  constructor(
    private readonly scene: GameArtTerrainScene,
    private readonly terrainSources: GameArtTerrainSources,
    private readonly overlay: TerrainTileOverlay | null,
    private readonly onChange: () => void,
    private readonly onPresented: () => void = () => undefined,
  ) {
    this.container.eventMode = 'none';
    this.container.visible = false;
    this.glPrograms = programs();
    this.planner = planTerrainMapRows(scene, terrainSources.terrains, (mode) =>
      Boolean(terrainSources.atlases[mode]),
    );
  }

  private terrainUniforms(kind: number, useMask: boolean, color: number) {
    return {
      uKind: { value: kind, type: 'f32' },
      uUseMask: { value: useMask ? 1 : 0, type: 'f32' },
      uRepeat: { value: gameArtTextureRepeatTiles, type: 'f32' },
      uSolid: {
        value: [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255],
        type: 'vec3<f32>',
      },
      uMapSize: { value: [this.scene.width, this.scene.height], type: 'vec2<f32>' },
      uAtlasSize: { value: this.terrainSources.atlasSize, type: 'f32' },
    };
  }

  private addMesh(geometry: Geometry, shader: Shader): void {
    this.shaders.push(shader);
    const mesh = new Mesh({ geometry, shader });
    mesh.eventMode = 'none';
    this.container.addChild(mesh);
  }

  private addDraw(draw: GpuTerrainDraw): void {
    const sources = this.terrainSources;
    const terrain = draw.kind === 'solid' ? undefined : sources.terrains.get(draw.terrain);
    const texture = terrain?.texture ? this.source(terrain.texture, true) : Texture.WHITE.source;
    const mask =
      draw.kind !== 'solid' && draw.mask !== null
        ? sources.terrains.get(draw.mask)?.overlayMask
        : null;
    const atlas = draw.kind === 'blend' ? sources.atlases[draw.mode] : null;
    const shader = new Shader({
      glProgram: draw.kind === 'blend' ? this.glPrograms.blend : this.glPrograms.plain,
      resources: {
        uTexture: texture,
        uMask: mask ? this.source(mask, true) : Texture.WHITE.source,
        ...(draw.kind === 'blend'
          ? { uAtlas: atlas ? this.source(atlas, false) : Texture.WHITE.source }
          : {}),
        terrainUniforms: this.terrainUniforms(
          draw.kind === 'solid' ? gpuTerrainKinds.solid : gpuTerrainKinds.texture,
          Boolean(mask),
          draw.kind === 'solid' ? draw.color : 0xffffff,
        ),
      },
    });
    let geometry = this.geometryByQuads.get(draw.quads);
    if (!geometry) {
      geometry = drawGeometry(
        draw.quads,
        draw.kind === 'blend' ? blendVertexWords : plainVertexWords,
      );
      this.geometryByQuads.set(draw.quads, geometry);
      this.geometries.push(geometry);
      this.statistics.textureBytes += gpuTerrainDrawBytes([draw]);
    }
    this.addMesh(geometry, shader);
  }

  private addShading(): void {
    const shading = this.overlay ? mapShading(this.scene, this.overlay) : null;
    if (!shading) return;
    this.shadingSource = new BufferImageSource({
      resource: new Uint8Array(shading.pixels.buffer),
      width: shading.width,
      height: shading.height,
      format: 'rgba8unorm',
      alphaMode: 'premultiplied-alpha',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
    });
    this.statistics.textureBytes += shading.pixels.byteLength;
    const { width, height } = this.scene;
    const corners = new Int16Array([
      ...layerPoint(0, 0),
      ...layerPoint(width, 0),
      ...layerPoint(width, height),
      ...layerPoint(0, height),
    ]);
    const geometry = drawGeometry(corners, plainVertexWords);
    this.geometries.push(geometry);
    this.addMesh(
      geometry,
      new Shader({
        glProgram: this.glPrograms.plain,
        resources: {
          uTexture: this.shadingSource,
          uMask: Texture.WHITE.source,
          terrainUniforms: this.terrainUniforms(gpuTerrainKinds.shading, false, 0xffffff),
        },
      }),
    );
  }

  private source(image: CanvasImageSource, repeat: boolean): TextureSource {
    let source = this.sources.get(image);
    if (!source) {
      source = gpuTextureSource(image, repeat);
      this.sources.set(image, source);
    }
    return source;
  }

  get presented(): boolean {
    return this.shown;
  }

  get textureBytes(): number {
    return this.statistics.textureBytes;
  }

  update(_visibleChunks?: readonly VisibleChunk[], _wantedPixelsPerTile?: number): void {
    if (this.destroyed || this.shown) return;
    this.work();
  }

  private schedule(): void {
    if (this.frame !== null || this.shown || this.destroyed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.work();
    });
  }

  work(budgetMilliseconds = gpuTerrainPlanBudgetMilliseconds): void {
    if (this.destroyed || this.shown) return;
    const started = performance.now();
    const spent = () => performance.now() - started >= budgetMilliseconds;
    let finished = false;
    while (!spent()) {
      if (!this.draws) {
        const step = this.planner.next();
        if (step.done) this.draws = gpuTerrainDrawSteps(step.value, this.terrainSources);
        continue;
      }
      const draw = this.draws.next();
      if (draw.done) {
        finished = true;
        break;
      }
      this.addDraw(draw.value);
    }
    if (finished) this.addShading();
    const elapsed = performance.now() - started;
    this.statistics.lastRasterMilliseconds = elapsed;
    this.statistics.totalRasterMilliseconds += elapsed;
    if (!finished) {
      this.schedule();
      return;
    }
    this.drawCount = this.container.children.length;
    this.statistics.pendingChunks = 0;
    this.shown = true;
    this.container.visible = true;
    this.onPresented();
    this.onChange();
  }

  flush(): void {
    this.work(Number.POSITIVE_INFINITY);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.container.destroy({ children: true });
    for (const geometry of this.geometries) geometry.destroy(true);
    for (const shader of this.shaders) shader.destroy(false);
    for (const source of this.sources.values()) source.destroy();
    this.sources.clear();
    this.shadingSource?.destroy();
    this.shadingSource = null;
  }
}
