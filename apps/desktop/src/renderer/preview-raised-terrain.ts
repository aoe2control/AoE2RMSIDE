import {
  Buffer,
  BufferImageSource,
  BufferUsage,
  Container,
  Geometry,
  GlProgram,
  Mesh,
  Shader,
  State,
  UniformGroup,
  type TextureSource,
} from 'pixi.js';
import { raisedLightStrength, type ElevationSurface } from './preview-elevation';
import type { ShownRaisedPicture } from './preview-shown-picture';
import {
  EdgeMarks,
  markRaisedPieces,
  markWalls,
  raisedChunkedMesh,
  raisedColorVertexWords,
  raisedPieces,
  type RaisedMeshChunk,
  type TerrainMesh,
} from './preview-raised-mesh';
import { requestPreviewRender } from './preview-render-scheduler';
import {
  terrainLayerTransform,
  tileEdgeScreenPixels,
  tileGridStrength,
  type TileGridColor,
} from './preview-tile-grid';
import type { PreviewCamera, PreviewViewport } from './top-down-preview';

export const raisedDepthBiasStep = 2 ** -20;

export interface RaisedDepth {
  offset: number;
  scale: number;
}

export function raisedDepth(surface: ElevationSurface): RaisedDepth {
  const minimum = -surface.width + surface.minimum - 1;
  const maximum = surface.height + surface.maximum + 1;
  return { offset: minimum, scale: 1.9 / (maximum - minimum) };
}

export function raisedDepthZ(depth: RaisedDepth, d: number, bias = 0): number {
  return Math.min(1, Math.max(-1, 0.95 - (d - depth.offset) * depth.scale - bias));
}

export function raisedTerrainState(
  depthTest: boolean,
  depthWrite = depthTest,
  blend = true,
): State {
  const state = State.for2d();
  state.depthTest = depthTest;
  state.depthMask = depthTest && depthWrite;
  state.blend = blend;
  return state;
}

export const raisedVertexCommon = `
uniform vec4 uRaisedDepth;
float raisedDepthZ(float d, float bias) {
  return clamp(0.95 - (d - uRaisedDepth.x) * uRaisedDepth.y - bias, -1.0, 1.0);
}
`;

export const raisedFragmentCommon = `
uniform vec4 uRaisedGrid;
float raisedWallKind(float code) { return floor((code + 0.5) / 4096.0); }
float raisedCodeLight(float code) { return (code - raisedWallKind(code) * 4096.0) / 1000.0; }
// The tile a fragment belongs to: a wall lies on its owner's front edge.
ivec2 raisedOwnerTile(vec2 map, float kind) {
  if (kind > 1.5) return ivec2(int(floor(map.x)), int(floor(map.y + 0.5)) - 1);
  if (kind > 0.5) return ivec2(int(floor(map.x + 0.5)), int(floor(map.y)));
  return ivec2(floor(map));
}
// The optional tile grid (one device pixel along tile edges), drawn with the
// terrain so it follows the raised surface and hides with it. On a wall
// only the tile corners make lines.
vec3 raisedGridded(vec3 color, vec2 map, float kind) {
  if (uRaisedGrid.a <= 0.0) return color;
  vec2 edge = abs(fract(map + 0.5) - 0.5) / max(fwidth(map), vec2(1e-6));
  float distance = kind > 1.5 ? edge.x : kind > 0.5 ? edge.y : min(edge.x, edge.y);
  float line = 1.0 - clamp(distance - 0.5, 0.0, 1.0);
  return mix(color, uRaisedGrid.rgb, uRaisedGrid.a * line);
}
`;

export class RaisedTerrainUniforms {
  readonly group: UniformGroup;
  readonly depth: RaisedDepth;

  constructor(surface: ElevationSurface) {
    this.depth = raisedDepth(surface);
    this.group = new UniformGroup({
      uRaisedDepth: {
        value: new Float32Array([this.depth.offset, this.depth.scale, 0, 0]),
        type: 'vec4<f32>',
      },
      uRaisedGrid: { value: new Float32Array([0, 0, 0, 0]), type: 'vec4<f32>' },
    });
  }

  setGrid(color: number, opacity: number): void {
    const grid = this.group.uniforms.uRaisedGrid as Float32Array;
    grid[0] = ((color >> 16) & 0xff) / 255;
    grid[1] = ((color >> 8) & 0xff) / 255;
    grid[2] = (color & 0xff) / 255;
    grid[3] = Math.max(0, Math.min(1, opacity));
    this.group.update();
  }

  get gridOpacity(): number {
    return (this.group.uniforms.uRaisedGrid as Float32Array)[3]!;
  }
}

export class RaisedTileGrid {
  readonly lineCount: number;
  opacity = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly uniforms: RaisedTerrainUniforms,
    private color: TileGridColor,
    private readonly node: Container,
  ) {
    this.lineCount = width + height + 2;
  }

  setColor(color: TileGridColor): void {
    this.color = color;
    this.uniforms.setGrid(color.color, this.opacity);
    requestPreviewRender(this.node);
  }

  update(
    scene: { width: number; height: number },
    camera: PreviewCamera,
    viewport: PreviewViewport,
  ): void {
    const strength = tileGridStrength(tileEdgeScreenPixels(scene, camera, viewport));
    this.opacity = strength * this.color.alpha;
    this.uniforms.setGrid(this.color.color, this.opacity);
    requestPreviewRender(this.node);
  }

  destroy(): void {
    this.opacity = 0;
    this.uniforms.setGrid(0, 0);
    requestPreviewRender(this.node);
  }
}

const colorVertex = `#version 300 es
precision highp float;
in vec4 aPosition;
in vec4 aColor;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vMap;
// The triangle's lit colour and wall kind, decoded once per vertex.
flat out vec4 vColor;
${raisedVertexCommon}
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec2 local = vec2(aPosition.x, aPosition.y - aPosition.z);
  gl_Position = vec4((mvp * vec3(local, 1.0)).xy, raisedDepthZ(aPosition.y + aPosition.z, 0.0), 1.0);
  vMap = vec2(aPosition.x - aPosition.y, aPosition.x + aPosition.y) * 0.5;
  float kind = floor((aPosition.w + 0.5) / 4096.0);
  float light = (aPosition.w - kind * 4096.0) / 1000.0;
  vColor = vec4(min(aColor.rgb / 255.0 * light, vec3(1.0)), kind);
}
`;

const colorFragment = `#version 300 es
precision highp float;
in vec2 vMap;
flat in vec4 vColor;
out vec4 finalColor;
${raisedFragmentCommon}
void main() {
  // One flat colour per triangle: software rendering runs this for every
  // pixel of the map, so it stays this short.
  finalColor = vec4(uRaisedGrid.a > 0.0 ? raisedGridded(vColor.rgb, vMap, vColor.a) : vColor.rgb, 1.0);
}
`;

let colorProgram: GlProgram | null = null;

export const raisedColorShaders = { vertex: colorVertex, fragment: colorFragment };

function colorGlProgram(): GlProgram {
  colorProgram ??= GlProgram.from({
    name: 'rmside-raised-terrain-colors',
    vertex: colorVertex,
    fragment: colorFragment,
    preferredFragmentPrecision: 'highp',
  });
  return colorProgram;
}

export function raisedColorShader(uniforms: RaisedTerrainUniforms): Shader {
  return new Shader({ glProgram: colorGlProgram(), resources: { raisedUniforms: uniforms.group } });
}

export function raisedColorPixiMesh(
  mesh: TerrainMesh,
  shader: Shader,
  state: State,
): { mesh: Mesh<Geometry, Shader>; geometry: Geometry } {
  const buffer = new Buffer({ data: mesh.vertices, usage: BufferUsage.VERTEX });
  const stride = raisedColorVertexWords * 2;
  const geometry = new Geometry({
    attributes: {
      aPosition: { buffer, format: 'sint16x4', stride, offset: 0 },
      aColor: { buffer, format: 'uint8x4', stride, offset: 8 },
    },
    indexBuffer: mesh.indices,
  });
  const drawn = new Mesh({ geometry, shader, state });
  drawn.eventMode = 'none';
  return { mesh: drawn, geometry };
}

export const raisedColorChunkSize = 32;

export function raisedColorMesh(
  surface: ElevationSurface,
  texels: Uint8Array,
): TerrainMesh & {
  quads: number;
  wallQuads: number;
  chunks: RaisedMeshChunk[];
} {
  const tiles = new Array<number>(surface.width * surface.height);
  for (let index = 0; index < tiles.length; index += 1) tiles[index] = index;
  const colorOf = (tile: number) =>
    (texels[tile * 4]! << 16) | (texels[tile * 4 + 1]! << 8) | texels[tile * 4 + 2]!;
  const pieces = raisedPieces(tiles, surface, true, colorOf);
  const marks = new EdgeMarks(surface.width, surface.height);
  markRaisedPieces(marks, pieces, surface.width);
  markWalls(marks, tiles, surface);
  return raisedChunkedMesh(
    pieces,
    surface,
    marks,
    raisedLightStrength.colorLooks,
    colorOf,
    raisedColorChunkSize,
  );
}

export interface RaisedLocalRect {
  minimumS: number;
  maximumS: number;
  minimumV: number;
  maximumV: number;
}

export function raisedViewRect(
  scene: { width: number; height: number },
  cameras: readonly PreviewCamera[],
  viewport: PreviewViewport,
  overscanPixels: number,
): RaisedLocalRect | null {
  let rect: RaisedLocalRect | null = null;
  for (const camera of cameras) {
    const { scaleX, scaleY, x, y } = terrainLayerTransform(scene, camera, viewport);
    if (!(scaleX > 0) || !(scaleY > 0)) continue;
    const minimumS = (-overscanPixels - x) / scaleX;
    const maximumS = (viewport.width + overscanPixels - x) / scaleX;
    const minimumV = (-overscanPixels - y) / scaleY;
    const maximumV = (viewport.height + overscanPixels - y) / scaleY;
    rect = rect
      ? {
          minimumS: Math.min(rect.minimumS, minimumS),
          maximumS: Math.max(rect.maximumS, maximumS),
          minimumV: Math.min(rect.minimumV, minimumV),
          maximumV: Math.max(rect.maximumV, maximumV),
        }
      : { minimumS, maximumS, minimumV, maximumV };
  }
  return rect;
}

export function composeChunkIndices(
  indices: Uint16Array | Uint32Array,
  chunks: readonly RaisedMeshChunk[],
  selection: Uint8Array,
  into: Uint16Array | Uint32Array,
): number {
  let at = 0;
  let chunk = 0;
  while (chunk < chunks.length) {
    if (!selection[chunk] || chunks[chunk]!.count === 0) {
      chunk += 1;
      continue;
    }
    const start = chunks[chunk]!.start;
    let end = start;
    while (chunk < chunks.length && (selection[chunk] || chunks[chunk]!.count === 0)) {
      end = chunks[chunk]!.start + chunks[chunk]!.count;
      chunk += 1;
    }
    into.set(indices.subarray(start, end), at);
    at += end - start;
  }
  return at;
}

function sameSelection(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function chunkMeets(chunk: RaisedMeshChunk, rect: RaisedLocalRect): boolean {
  return (
    chunk.count > 0 &&
    chunk.maximumS >= rect.minimumS &&
    chunk.minimumS <= rect.maximumS &&
    chunk.maximumV >= rect.minimumV &&
    chunk.minimumV <= rect.maximumV
  );
}

export const raisedCullMargin = 0.25;
export const raisedCullSlack = 3;

export function raisedChunkSelection(
  chunks: readonly RaisedMeshChunk[],
  drawn: Uint8Array,
  drawnIndices: number,
  view: RaisedLocalRect | null,
): Uint8Array | null {
  let missing = false;
  let visibleIndices = 0;
  if (view) {
    for (let chunk = 0; chunk < chunks.length; chunk += 1) {
      const entry = chunks[chunk]!;
      if (!chunkMeets(entry, view)) continue;
      visibleIndices += entry.count;
      if (!drawn[chunk]) missing = true;
    }
  }
  if (!missing && drawnIndices <= visibleIndices * raisedCullSlack) return null;
  const next = new Uint8Array(chunks.length);
  if (!view) return next;
  const marginS = (view.maximumS - view.minimumS) * raisedCullMargin;
  const marginV = (view.maximumV - view.minimumV) * raisedCullMargin;
  const widened: RaisedLocalRect = {
    minimumS: view.minimumS - marginS,
    maximumS: view.maximumS + marginS,
    minimumV: view.minimumV - marginV,
    maximumV: view.maximumV + marginV,
  };
  for (let chunk = 0; chunk < chunks.length; chunk += 1) {
    if (chunkMeets(chunks[chunk]!, widened)) next[chunk] = 1;
  }
  return next;
}

export class RaisedColorTerrainLayer {
  readonly container = new Container({ label: 'raised-terrain-colors' });
  readonly quads: number;
  readonly wallQuads: number;
  readonly vertexCount: number;
  readonly bytes: number;
  readonly buildMilliseconds: number;
  readonly chunkCount: number;
  readonly triangleCount: number;
  drawnChunks: number;
  drawnTriangles: number;
  private readonly geometry: Geometry;
  private readonly shader: Shader;
  private readonly drawnMesh: Mesh<Geometry, Shader>;
  private readonly chunks: RaisedMeshChunk[];
  private readonly indices: Uint16Array | Uint32Array;
  private readonly composed: Uint16Array | Uint32Array;
  private readonly indexBuffer: Buffer;
  private drawn: Uint8Array;
  private drawnIndices: number;

  constructor(surface: ElevationSurface, texels: Uint8Array, uniforms: RaisedTerrainUniforms) {
    const started = performance.now();
    this.container.eventMode = 'none';
    const mesh = raisedColorMesh(surface, texels);
    this.quads = mesh.quads;
    this.wallQuads = mesh.wallQuads;
    this.vertexCount = mesh.vertices.length / raisedColorVertexWords;
    this.bytes = mesh.vertices.byteLength + mesh.indices.byteLength;
    this.chunks = mesh.chunks;
    this.indices = mesh.indices;
    this.composed =
      mesh.indices instanceof Uint16Array
        ? new Uint16Array(mesh.indices.length)
        : new Uint32Array(mesh.indices.length);
    this.chunkCount = mesh.chunks.filter((chunk) => chunk.count > 0).length;
    this.triangleCount = mesh.indices.length / 3;
    this.drawn = Uint8Array.from(mesh.chunks, (chunk) => (chunk.count > 0 ? 1 : 0));
    this.drawnIndices = mesh.indices.length;
    this.drawnChunks = this.chunkCount;
    this.drawnTriangles = this.triangleCount;
    const buffer = new Buffer({ data: mesh.vertices, usage: BufferUsage.VERTEX });
    this.indexBuffer = new Buffer({
      data: mesh.indices,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
      shrinkToFit: false,
    });
    const stride = raisedColorVertexWords * 2;
    this.geometry = new Geometry({
      attributes: {
        aPosition: { buffer, format: 'sint16x4', stride, offset: 0 },
        aColor: { buffer, format: 'uint8x4', stride, offset: 8 },
      },
      indexBuffer: this.indexBuffer,
    });
    this.shader = raisedColorShader(uniforms);
    this.drawnMesh = new Mesh({
      geometry: this.geometry,
      shader: this.shader,
      state: raisedTerrainState(surface.hasSteps, surface.hasSteps, false),
    });
    this.drawnMesh.eventMode = 'none';
    this.container.addChild(this.drawnMesh);
    this.buildMilliseconds = performance.now() - started;
    requestPreviewRender(this.container);
  }

  updateView(view: RaisedLocalRect | null): boolean {
    const next = raisedChunkSelection(this.chunks, this.drawn, this.drawnIndices, view);
    if (!next || sameSelection(next, this.drawn)) return false;
    let count = 0;
    let chunks = 0;
    for (let chunk = 0; chunk < this.chunks.length; chunk += 1) {
      if (!next[chunk]) continue;
      chunks += 1;
      count += this.chunks[chunk]!.count;
    }
    if (chunks === this.chunkCount) {
      if (this.indexBuffer.data !== this.indices) this.indexBuffer.data = this.indices;
    } else if (count > 0) {
      const length = composeChunkIndices(this.indices, this.chunks, next, this.composed);
      this.indexBuffer.data = this.composed.subarray(0, length);
    }
    this.drawnMesh.visible = count > 0;
    this.drawn = next;
    this.drawnIndices = count;
    this.drawnChunks = chunks;
    this.drawnTriangles = count / 3;
    requestPreviewRender(this.container);
    return true;
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.geometry.destroy(true);
    this.shader.destroy(false);
  }
}

export function raisedLightSource(surface: ElevationSurface, strength: number): TextureSource {
  const light = surface.cornerLight(strength);
  const width = surface.width + 1;
  const height = surface.height + 1;
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const value = Math.round(Math.min(1, light[index]! / 2) * 255);
    pixels[index * 4] = value;
    pixels[index * 4 + 1] = value;
    pixels[index * 4 + 2] = value;
    pixels[index * 4 + 3] = 255;
  }
  return new BufferImageSource({
    resource: pixels,
    width,
    height,
    format: 'rgba8unorm',
    scaleMode: 'linear',
    addressMode: 'clamp-to-edge',
    autoGenerateMipmaps: false,
  });
}

const overlayVertex = `#version 300 es
precision highp float;
in vec2 aPosition;
in float aDepth;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform float uOverlayBias;
${raisedVertexCommon}
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, raisedDepthZ(aDepth, uOverlayBias), 1.0);
}
`;

const overlayFragment = `#version 300 es
precision highp float;
uniform vec4 uOverlayColor;
out vec4 finalColor;
void main() {
  finalColor = vec4(uOverlayColor.rgb * uOverlayColor.a, uOverlayColor.a);
}
`;

let overlayProgram: GlProgram | null = null;

export const raisedOverlayShaders = { vertex: overlayVertex, fragment: overlayFragment };

export class RaisedOverlayFill {
  readonly container = new Container({ label: 'raised-highlight' });
  private mesh: Mesh<Geometry, Shader> | null = null;
  private geometry: Geometry | null = null;
  private readonly shader: Shader;
  private destroyed = false;

  constructor(
    uniforms: RaisedTerrainUniforms,
    color: number,
    alpha: number,
    private readonly depthTest: boolean,
    private readonly bias: () => number,
  ) {
    this.container.eventMode = 'none';
    overlayProgram ??= GlProgram.from({
      name: 'rmside-raised-overlay',
      vertex: overlayVertex,
      fragment: overlayFragment,
      preferredFragmentPrecision: 'highp',
    });
    this.shader = new Shader({
      glProgram: overlayProgram,
      resources: {
        raisedUniforms: uniforms.group,
        overlayUniforms: {
          uOverlayColor: {
            value: [
              ((color >> 16) & 0xff) / 255,
              ((color >> 8) & 0xff) / 255,
              (color & 0xff) / 255,
              alpha,
            ],
            type: 'vec4<f32>',
          },
          uOverlayBias: { value: 0, type: 'f32' },
        },
      },
    });
  }

  set(positions: Float32Array, depths: Float32Array, indices: Uint32Array): void {
    if (this.destroyed) return;
    if (indices.length === 0) {
      this.clear();
      return;
    }
    const uniforms = this.shader.resources.overlayUniforms as {
      uniforms: { uOverlayBias: number };
    };
    uniforms.uniforms.uOverlayBias = this.bias();
    if (!this.geometry || !this.mesh) {
      this.geometry = new Geometry({
        attributes: {
          aPosition: {
            buffer: new Buffer({
              data: positions,
              usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
            }),
            format: 'float32x2',
          },
          aDepth: {
            buffer: new Buffer({ data: depths, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST }),
            format: 'float32',
          },
        },
        indexBuffer: indices,
      });
      this.mesh = new Mesh({
        geometry: this.geometry,
        shader: this.shader,
        state: raisedTerrainState(this.depthTest, false),
      });
      this.mesh.eventMode = 'none';
      this.container.addChild(this.mesh);
    } else {
      this.geometry.getAttribute('aPosition').buffer.data = positions;
      this.geometry.getAttribute('aDepth').buffer.data = depths;
      this.geometry.indexBuffer.data = indices;
      this.mesh.visible = true;
    }
    requestPreviewRender(this.container);
  }

  clear(): void {
    if (this.destroyed) return;
    if (this.mesh) this.mesh.visible = false;
    requestPreviewRender(this.container);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.container.destroy({ children: true });
    this.mesh = null;
    this.geometry?.destroy(true);
    this.geometry = null;
    this.shader.destroy(false);
  }
}

export class ShownRaisedHighlight {
  private fill: RaisedOverlayFill | null = null;
  private uniforms: RaisedTerrainUniforms | null = null;
  private picture: ShownRaisedPicture | null = null;

  constructor(
    private readonly layer: Container,
    private readonly graphics: Container,
    private readonly shown: () => ShownRaisedPicture | null,
  ) {}

  current(scene: {
    width: number;
    height: number;
  }): { surface: ElevationSurface; fill: RaisedOverlayFill } | null {
    const picture = this.shown();
    if (
      !picture ||
      picture.surface.width !== scene.width ||
      picture.surface.height !== scene.height
    ) {
      this.clear();
      return null;
    }
    this.picture = picture;
    if (!this.fill || this.uniforms !== picture.uniforms) {
      this.fill?.destroy();
      this.fill = new RaisedOverlayFill(
        picture.uniforms,
        0xffffff,
        0.6,
        picture.surface.hasSteps,
        () => this.picture?.overlayBias() ?? 0,
      );
      this.uniforms = picture.uniforms;
      if (!this.layer.destroyed && !this.graphics.destroyed) {
        this.layer.addChildAt(this.fill.container, this.layer.getChildIndex(this.graphics));
      }
    }
    return { surface: picture.surface, fill: this.fill };
  }

  clear(): void {
    this.fill?.clear();
  }

  destroy(): void {
    this.fill?.destroy();
    this.fill = null;
    this.uniforms = null;
    this.picture = null;
  }
}
