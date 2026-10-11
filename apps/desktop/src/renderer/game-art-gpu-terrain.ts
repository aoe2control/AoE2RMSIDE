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
import { raisedLightStrength, type ElevationSurface } from './preview-elevation';
import {
  EdgeMarks,
  flatRunMesh,
  markRaisedPieces,
  markRuns,
  markWalls,
  quadIndices,
  raisedLightCode,
  raisedMesh,
  raisedPieces,
  raisedVertexWords,
  tileRuns,
  type RaisedPieces,
  type TerrainMesh,
} from './preview-raised-mesh';
import {
  raisedDepthBiasStep,
  raisedFragmentCommon,
  raisedLightSource,
  raisedTerrainState,
  raisedVertexCommon,
  type RaisedTerrainUniforms,
} from './preview-raised-terrain';
import { requestPreviewRender } from './preview-render-scheduler';
import type { VisibleChunk } from './top-down-preview';

export type GpuTerrainDraw =
  | { kind: 'solid'; color: number; mesh: TerrainMesh }
  | { kind: 'texture'; terrain: number; mask: number | null; mesh: TerrainMesh }
  | {
      kind: 'blend';
      terrain: number;
      mask: number | null;
      mode: number;
      mesh: TerrainMesh;
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
export const raisedBlendVertexWords = 10;
export const blendCellSlots = 8;
export const noBlendCell = 255;

export function blendCellCode(cell: number): number {
  const { row, column } = blendAtlasCell(cell);
  return row * 8 + column;
}

export function blendQuads(
  quads: readonly { tile: number; cell: number }[],
  width: number,
): Int16Array {
  const cellsByTile = groupCells(quads);
  const data = new Int16Array(cellsByTile.size * 4 * blendVertexWords);
  const bytes = new Uint8Array(data.buffer);
  for (const [index, [tile, cells]] of [...cellsByTile].entries()) {
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

function groupCells(quads: readonly { tile: number; cell: number }[]): Map<number, number[]> {
  const cellsByTile = new Map<number, number[]>();
  for (const quad of quads) {
    const cells = cellsByTile.get(quad.tile);
    if (cells) cells.push(blendCellCode(quad.cell));
    else cellsByTile.set(quad.tile, [blendCellCode(quad.cell)]);
  }
  for (const cells of cellsByTile.values()) {
    if (cells.length > blendCellSlots) throw new Error('too many transition quads on one tile');
  }
  return cellsByTile;
}

export function raisedBlendQuads(
  quads: readonly { tile: number; cell: number }[],
  surface: ElevationSurface,
): Int16Array {
  const width = surface.width;
  const cellsByTile = groupCells(quads);
  const data = new Int16Array(cellsByTile.size * 4 * raisedBlendVertexWords);
  const bytes = new Uint8Array(data.buffer);
  const flatCode = raisedLightCode(1);
  let index = 0;
  for (const [tile, cells] of cellsByTile) {
    const x = tile % width;
    const y = (tile - x) / width;
    const order = surface.foldsTopBottom(tile) ? raisedTopBottomOrder : raisedLeftRightOrder;
    for (let slot = 0; slot < 4; slot += 1) {
      const corner = order[slot]!;
      const cornerX = corner === 1 || corner === 2 ? 1 : 0;
      const cornerY = corner >= 2 ? 1 : 0;
      const word = (index * 4 + slot) * raisedBlendVertexWords;
      data[word] = x + cornerX + y + cornerY;
      data[word + 1] = y + cornerY - x - cornerX;
      data[word + 2] = surface.corners[tile * 4 + corner]!;
      data[word + 3] = flatCode;
      const byte = word * 2;
      bytes[byte + 8] = cornerX;
      bytes[byte + 9] = cornerY;
      for (let cell = 0; cell < blendCellSlots; cell += 1) {
        bytes[byte + 12 + cell] = cells[cell] ?? noBlendCell;
      }
    }
    index += 1;
  }
  return data;
}

const raisedLeftRightOrder = [0, 1, 2, 3] as const;
const raisedTopBottomOrder = [1, 2, 3, 0] as const;

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
  surface: ElevationSurface | null = null,
): GpuTerrainDraw[] {
  return [...gpuTerrainDrawSteps(plan, sources, surface)];
}

function plainMeshes(
  plan: TerrainChunkPlan,
  lists: readonly { tiles: readonly number[]; walls: boolean }[],
  surface: ElevationSurface | null,
): (index: number) => TerrainMesh {
  const marks = new EdgeMarks(plan.width, plan.height);
  if (!surface) {
    const runs = lists.map(({ tiles }) => tileRuns(tiles, plan.width));
    for (const list of runs) markRuns(marks, list);
    return (index) => flatRunMesh(runs[index]!, marks);
  }
  const pieces: RaisedPieces[] = lists.map(({ tiles, walls }) =>
    raisedPieces(tiles, surface, walls),
  );
  for (const [index, list] of pieces.entries()) {
    markRaisedPieces(marks, list, plan.width);
    if (list.walls) markWalls(marks, lists[index]!.tiles, surface);
  }
  return (index) => raisedMesh(pieces[index]!, surface, marks, raisedLightStrength.gameTextures);
}

export function* gpuTerrainDrawSteps(
  plan: TerrainChunkPlan,
  sources: Pick<GameArtTerrainSources, 'terrains' | 'atlases'>,
  surface: ElevationSurface | null = null,
): Generator<GpuTerrainDraw, void, void> {
  type PlainDraw =
    { kind: 'solid'; color: number } | { kind: 'texture'; terrain: number; mask: number | null };
  const lists: { tiles: readonly number[]; walls: boolean; draw: PlainDraw }[] = [];
  for (const [color, tiles] of plan.fallback) {
    lists.push({ tiles, walls: true, draw: { kind: 'solid', color } });
  }
  for (const [terrain, tiles] of plan.base) {
    if (!sources.terrains.get(terrain)?.texture) continue;
    lists.push({ tiles, walls: true, draw: { kind: 'texture', terrain, mask: null } });
  }
  for (const [layer, tiles] of plan.layers) {
    const source = sources.terrains.get(layer);
    if (!source?.texture || !source.overlayMask) continue;
    lists.push({ tiles, walls: false, draw: { kind: 'texture', terrain: layer, mask: layer } });
  }
  const mesh = plainMeshes(plan, lists, surface);
  for (const [index, list] of lists.entries()) {
    yield { ...list.draw, mesh: mesh(index) };
  }
  for (const group of plan.blends) {
    const upper = sources.terrains.get(group.upper.terrain);
    if (!sources.atlases[group.mode] || !upper?.texture) continue;
    const vertices = surface
      ? raisedBlendQuads(group.quads, surface)
      : blendQuads(group.quads, plan.width);
    const words = surface ? raisedBlendVertexWords : blendVertexWords;
    const quads: TerrainMesh = {
      vertices,
      indices: quadIndices(vertices.length / (4 * words)),
    };
    yield {
      kind: 'blend',
      terrain: group.upper.terrain,
      mask: null,
      mode: group.mode,
      mesh: quads,
    };
    if (group.upper.layer !== noTerrainLayer) {
      const layered = sources.terrains.get(group.upper.layer);
      if (layered?.texture && layered.overlayMask) {
        yield {
          kind: 'blend',
          terrain: group.upper.layer,
          mask: group.upper.layer,
          mode: group.mode,
          mesh: quads,
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
  const counted = new Set<TerrainMesh>();
  for (const draw of draws) {
    if (counted.has(draw.mesh)) continue;
    counted.add(draw.mesh);
    bytes += draw.mesh.vertices.byteLength + draw.mesh.indices.byteLength;
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

const raisedVertexHeader = `#version 300 es
precision highp float;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform float uDrawBias;
out vec2 vMap;
flat out float vCode;
${raisedVertexCommon}
`;

const raisedVertexPosition = `
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec2 local = vec2(aPosition.x, aPosition.y - aPosition.z);
  gl_Position = vec4((mvp * vec3(local, 1.0)).xy, raisedDepthZ(aPosition.y + aPosition.z, uDrawBias), 1.0);
  vMap = vec2(aPosition.x - aPosition.y, aPosition.x + aPosition.y) * 0.5;
  vCode = aPosition.w;
`;

export const gpuRaisedTerrainPlainVertex = `${raisedVertexHeader}
in vec4 aPosition;
void main() {${raisedVertexPosition}}
`;

export const gpuRaisedTerrainBlendVertex = `${raisedVertexHeader}
in vec4 aPosition;
in vec4 aLocal;
in vec4 aCells;
in vec4 aMoreCells;
out vec2 vLocal;
flat out vec4 vCells;
flat out vec4 vMoreCells;
void main() {${raisedVertexPosition}
  vLocal = aLocal.xy;
  vCells = aCells;
  vMoreCells = aMoreCells;
}
`;

const raisedLit = `
  float kind = raisedWallKind(vCode);
  float light = kind > 0.5
    ? raisedCodeLight(vCode)
    : texture(uLight, (vMap + 0.5) / uLightSize).r * 2.0;
  vec3 lit = raisedGridded(min(color.rgb * light, vec3(1.0)), vMap, kind);
`;

const raisedFragmentHeader = `flat in float vCode;
uniform sampler2D uLight;
uniform vec2 uLightSize;
${raisedFragmentCommon}`;

export const gpuRaisedTerrainPlainFragment = `${fragmentHeader}${raisedFragmentHeader}
void main() {${fragmentBody}${raisedLit}
  float alpha = color.a * uColor.a;
  finalColor = vec4(lit * uColor.rgb * alpha, alpha);
}
`;

export const gpuRaisedTerrainBlendFragment = gpuTerrainBlendFragment
  .replace('in vec2 vLocal;', `${raisedFragmentHeader}\nin vec2 vLocal;`)
  .replace(
    `  float alpha = color.a * atlasAlpha() * uColor.a;
  finalColor = vec4(color.rgb * uColor.rgb * alpha, alpha);`,
    `${raisedLit}
  float alpha = color.a * atlasAlpha() * uColor.a;
  finalColor = vec4(lit * uColor.rgb * alpha, alpha);`,
  );

let plainProgram: GlProgram | null = null;
let blendProgram: GlProgram | null = null;
let raisedPlainProgram: GlProgram | null = null;
let raisedBlendProgram: GlProgram | null = null;

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

function raisedPrograms(): { plain: GlProgram; blend: GlProgram } {
  raisedPlainProgram ??= GlProgram.from({
    name: 'rmside-raised-terrain',
    vertex: gpuRaisedTerrainPlainVertex,
    fragment: gpuRaisedTerrainPlainFragment,
    preferredFragmentPrecision: 'highp',
  });
  raisedBlendProgram ??= GlProgram.from({
    name: 'rmside-raised-terrain-blend',
    vertex: gpuRaisedTerrainBlendVertex,
    fragment: gpuRaisedTerrainBlendFragment,
    preferredFragmentPrecision: 'highp',
  });
  return { plain: raisedPlainProgram, blend: raisedBlendProgram };
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

type DrawLayout = 'plain' | 'blend' | 'raised-plain' | 'raised-blend';

function drawGeometry(mesh: TerrainMesh, layout: DrawLayout): Geometry {
  const buffer = new Buffer({ data: mesh.vertices, usage: BufferUsage.VERTEX });
  const attributes = {
    plain: () => ({
      aPosition: { buffer, format: 'sint16x2', stride: plainVertexWords * 2, offset: 0 },
    }),
    blend: () => {
      const stride = blendVertexWords * 2;
      return {
        aPosition: { buffer, format: 'sint16x2', stride, offset: 0 },
        aLocal: { buffer, format: 'uint8x4', stride, offset: 4 },
        aCells: { buffer, format: 'uint8x4', stride, offset: 8 },
        aMoreCells: { buffer, format: 'uint8x4', stride, offset: 12 },
      };
    },
    'raised-plain': () => ({
      aPosition: { buffer, format: 'sint16x4', stride: raisedVertexWords * 2, offset: 0 },
    }),
    'raised-blend': () => {
      const stride = raisedBlendVertexWords * 2;
      return {
        aPosition: { buffer, format: 'sint16x4', stride, offset: 0 },
        aLocal: { buffer, format: 'uint8x4', stride, offset: 8 },
        aCells: { buffer, format: 'uint8x4', stride, offset: 12 },
        aMoreCells: { buffer, format: 'uint8x4', stride, offset: 16 },
      };
    },
  }[layout]();
  return new Geometry({
    attributes: attributes as NonNullable<ConstructorParameters<typeof Geometry>[0]>['attributes'],
    indexBuffer: mesh.indices,
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
  raisedQuads = 0;
  raisedWallQuads = 0;
  private readonly planner: Generator<number, TerrainChunkPlan, void>;
  private draws: Generator<GpuTerrainDraw, void, void> | null = null;
  private readonly geometryByMesh = new Map<TerrainMesh, Geometry>();
  private frame: number | null = null;
  private readonly glPrograms: { plain: GlProgram; blend: GlProgram };
  private readonly lightSource: TextureSource | null = null;
  private drawIndex = 0;

  constructor(
    private readonly scene: GameArtTerrainScene,
    private readonly terrainSources: GameArtTerrainSources,
    private readonly overlay: TerrainTileOverlay | null,
    private readonly onChange: () => void,
    private readonly onPresented: () => void = () => undefined,
    private readonly raised: {
      surface: ElevationSurface;
      uniforms: RaisedTerrainUniforms;
    } | null = null,
  ) {
    this.container.eventMode = 'none';
    this.container.visible = false;
    this.glPrograms = raised ? raisedPrograms() : programs();
    this.planner = planTerrainMapRows(scene, terrainSources.terrains, (mode) =>
      Boolean(terrainSources.atlases[mode]),
    );
    if (raised) {
      this.lightSource = raisedLightSource(raised.surface, raisedLightStrength.gameTextures);
      this.statistics.textureBytes += (scene.width + 1) * (scene.height + 1) * 4;
    }
  }

  get raisedOverlayBias(): number {
    return (this.drawIndex + 16) * raisedDepthBiasStep;
  }

  private terrainUniforms(kind: number, useMask: boolean, color: number) {
    if (this.raised) {
      this.drawIndex += 1;
      return {
        ...this.flatUniforms(kind, useMask, color),
        uDrawBias: { value: this.drawIndex * raisedDepthBiasStep, type: 'f32' },
        uLightSize: { value: [this.scene.width + 1, this.scene.height + 1], type: 'vec2<f32>' },
      };
    }
    return this.flatUniforms(kind, useMask, color);
  }

  private flatUniforms(kind: number, useMask: boolean, color: number) {
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
    const mesh = this.raised
      ? new Mesh({ geometry, shader, state: raisedTerrainState(this.raised.surface.hasSteps) })
      : new Mesh({ geometry, shader });
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
        ...(this.raised && this.lightSource
          ? { uLight: this.lightSource, raisedUniforms: this.raised.uniforms.group }
          : {}),
        terrainUniforms: this.terrainUniforms(
          draw.kind === 'solid' ? gpuTerrainKinds.solid : gpuTerrainKinds.texture,
          Boolean(mask),
          draw.kind === 'solid' ? draw.color : 0xffffff,
        ),
      },
    });
    let geometry = this.geometryByMesh.get(draw.mesh);
    if (!geometry) {
      const layout: DrawLayout = this.raised
        ? draw.kind === 'blend'
          ? 'raised-blend'
          : 'raised-plain'
        : draw.kind === 'blend'
          ? 'blend'
          : 'plain';
      geometry = drawGeometry(draw.mesh, layout);
      this.geometryByMesh.set(draw.mesh, geometry);
      this.geometries.push(geometry);
      this.statistics.textureBytes += gpuTerrainDrawBytes([draw]);
      if (this.raised && draw.kind !== 'blend') {
        const counted = draw.mesh as TerrainMesh & { quads?: number; wallQuads?: number };
        this.raisedQuads += counted.quads ?? 0;
        this.raisedWallQuads += counted.wallQuads ?? 0;
      }
    }
    this.addMesh(geometry, shader);
  }

  private addShading(): void {
    if (this.raised) return;
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
      0,
      0,
      width,
      -width,
      width + height,
      height - width,
      height,
      height,
    ]);
    const geometry = drawGeometry({ vertices: corners, indices: quadIndices(1) }, 'plain');
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
        if (step.done) {
          this.draws = gpuTerrainDrawSteps(
            step.value,
            this.terrainSources,
            this.raised?.surface ?? null,
          );
        }
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
    requestPreviewRender(this.container);
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
    this.lightSource?.destroy();
  }
}
