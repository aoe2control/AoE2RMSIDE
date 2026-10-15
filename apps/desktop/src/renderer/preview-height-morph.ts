import {
  Buffer,
  BufferImageSource,
  BufferUsage,
  Geometry,
  GlProgram,
  Mesh,
  Shader,
  UniformGroup,
  type TextureSource,
} from 'pixi.js';
import { raisedLightStrength, type ElevationSurface } from './preview-elevation';
import { defaultMorphFieldOptions } from './preview-morph-field';
import { raisedLightCodeScale } from './preview-raised-mesh';
import {
  raisedFragmentCommon,
  raisedTerrainState,
  type RaisedDepth,
  type RaisedTerrainUniforms,
} from './preview-raised-terrain';

const heightBias = 32_768;

export function morphCornerHeightTexels(
  surface: ElevationSurface | null,
  width: number,
  height: number,
): Uint8Array {
  const columns = width + 1;
  const texels = new Uint8Array(columns * (height + 1) * 4);
  for (let cornerY = 0; cornerY <= height; cornerY += 1) {
    const tileY = Math.min(cornerY, height - 1);
    for (let cornerX = 0; cornerX <= width; cornerX += 1) {
      const tileX = Math.min(cornerX, width - 1);
      const corner = cornerX > tileX ? (cornerY > tileY ? 2 : 1) : cornerY > tileY ? 3 : 0;
      const value = surface ? surface.corner(tileY * width + tileX, corner) : 0;
      const stored = Math.max(0, Math.min(65_535, value + heightBias));
      const at = (cornerY * columns + cornerX) * 4;
      texels[at] = stored >> 8;
      texels[at + 1] = stored & 0xff;
      texels[at + 3] = 255;
    }
  }
  return texels;
}

export function decodeMorphCornerHeight(texels: Uint8Array, corner: number): number {
  return texels[corner * 4]! * 256 + texels[corner * 4 + 1]! - heightBias;
}

export function litMorphTexels(texels: Uint8Array, surface: ElevationSurface | null): Uint8Array {
  if (!surface) return texels;
  const tiles = surface.width * surface.height;
  const lit = new Uint8Array(tiles * 4);
  for (let tile = 0; tile < tiles; tile += 1) {
    const light =
      Math.round(surface.tileLight(tile, raisedLightStrength.colorLooks) * raisedLightCodeScale) /
      raisedLightCodeScale;
    const at = tile * 4;
    lit[at] = Math.min(255, Math.round(texels[at]! * light));
    lit[at + 1] = Math.min(255, Math.round(texels[at + 1]! * light));
    lit[at + 2] = Math.min(255, Math.round(texels[at + 2]! * light));
    lit[at + 3] = 255;
  }
  return lit;
}

export function morphGridPositions(width: number, height: number): Float32Array {
  const columns = width + 1;
  const positions = new Float32Array(columns * (height + 1) * 2);
  for (let y = 0; y <= height; y += 1) {
    for (let x = 0; x <= width; x += 1) {
      const at = (y * columns + x) * 2;
      positions[at] = x;
      positions[at + 1] = y;
    }
  }
  return positions;
}

export function morphGridIndices(
  width: number,
  height: number,
  foldsTopBottom: (tile: number) => boolean,
): Uint16Array | Uint32Array {
  const columns = width + 1;
  const count = width * height * 6;
  const indices =
    columns * (height + 1) <= 65_536 ? new Uint16Array(count) : new Uint32Array(count);
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const left = y * columns + x;
      const top = left + 1;
      const right = left + columns + 1;
      const bottom = left + columns;
      const corners = foldsTopBottom(y * width + x)
        ? [top, right, bottom, left]
        : [left, top, right, bottom];
      indices[at] = corners[0]!;
      indices[at + 1] = corners[1]!;
      indices[at + 2] = corners[2]!;
      indices[at + 3] = corners[0]!;
      indices[at + 4] = corners[2]!;
      indices[at + 5] = corners[3]!;
      at += 6;
    }
  }
  return indices;
}

export function heightMorphDepth(
  width: number,
  height: number,
  minimum: number,
  maximum: number,
): RaisedDepth {
  const low = -width + Math.min(0, minimum) - 1;
  const high = height + Math.max(0, maximum) + 1;
  return { offset: low, scale: 1.9 / (high - low) };
}

export interface HeightMorphPicture {
  colours: Uint8Array;
  width: number;
  height: number;
  surface: ElevationSurface | null;
}

const heightMorphVertex = `#version 300 es
precision highp float;
in vec2 aPosition;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform sampler2D uField;
uniform sampler2D uPreviousHeights;
uniform sampler2D uNextHeights;
// x: eased progress, y: the field's full-range offset, zw: the new map's size.
uniform vec4 uMorph;
// xy: the previous map's size, zw: the depth offset and scale.
uniform vec4 uMorphFrame;
out vec2 vMap;
float decodeHeight(vec4 texel) {
  return floor(texel.r * 255.0 + 0.5) * 256.0 + floor(texel.g * 255.0 + 0.5) - 32768.0;
}
// The corner heights at a normalised map point, bilinear between corners.
float morphHeight(sampler2D heights, vec2 uv, vec2 size) {
  vec2 corner = clamp(uv, 0.0, 1.0) * size;
  vec2 cell = min(floor(corner), size - 1.0);
  vec2 f = corner - cell;
  ivec2 at = ivec2(cell);
  float a = decodeHeight(texelFetch(heights, at, 0));
  float b = decodeHeight(texelFetch(heights, at + ivec2(1, 0), 0));
  float c = decodeHeight(texelFetch(heights, at + ivec2(0, 1), 0));
  float d = decodeHeight(texelFetch(heights, at + ivec2(1, 1), 0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
  vec2 uv = aPosition / uMorph.zw;
  vec2 offset = (textureLod(uField, uv, 0.0).rg * 255.0 - 128.0) / 127.0 * uMorph.y;
  float t = uMorph.x;
  float h = mix(
    morphHeight(uPreviousHeights, uv + t * offset, uMorphFrame.xy),
    morphHeight(uNextHeights, uv - (1.0 - t) * offset, uMorph.zw),
    t
  );
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  // Map point (x, y) at height h lies at (x + y, y - x - h); its depth is t + h.
  vec2 local = vec2(aPosition.x + aPosition.y, aPosition.y - aPosition.x - h);
  float depth = clamp(0.95 - (aPosition.y - aPosition.x + h - uMorphFrame.z) * uMorphFrame.w, -1.0, 1.0);
  gl_Position = vec4((mvp * vec3(local, 1.0)).xy, depth, 1.0);
  vMap = aPosition;
}
`;

const heightMorphFragment = `#version 300 es
precision highp float;
in vec2 vMap;
uniform sampler2D uPrevious;
uniform sampler2D uNext;
uniform sampler2D uField;
uniform vec4 uMorph;
out vec4 finalColor;
${raisedFragmentCommon}
void main() {
  vec2 uv = vMap / uMorph.zw;
  vec2 offset = (texture(uField, uv).rg * 255.0 - 128.0) / 127.0 * uMorph.y;
  float t = uMorph.x;
  vec4 previous = texture(uPrevious, uv + t * offset);
  vec4 next = texture(uNext, uv - (1.0 - t) * offset);
  vec3 color = mix(previous, next, smoothstep(0.15, 0.85, t)).rgb;
  // The new map's tile grid, where it is on.
  finalColor = vec4(uRaisedGrid.a > 0.0 ? raisedGridded(color, vMap, 0.0) : color, 1.0);
}
`;

export const heightMorphShaders = { vertex: heightMorphVertex, fragment: heightMorphFragment };

let heightMorphProgram: GlProgram | null = null;

function texelSource(
  texels: Uint8Array,
  width: number,
  height: number,
  scaleMode: 'nearest' | 'linear' = 'nearest',
): BufferImageSource {
  return new BufferImageSource({
    resource: texels,
    width,
    height,
    format: 'rgba8unorm',
    scaleMode,
    addressMode: 'clamp-to-edge',
    autoGenerateMipmaps: false,
  });
}

export class HeightMorphMesh {
  readonly mesh: Mesh<Geometry, Shader>;
  private readonly geometry: Geometry;
  private readonly fieldSource: BufferImageSource;
  private readonly sources: TextureSource[];
  private readonly uniforms: UniformGroup;
  private destroyed = false;

  constructor(
    previous: HeightMorphPicture,
    next: HeightMorphPicture & { surface: ElevationSurface },
    nextUniforms: RaisedTerrainUniforms,
  ) {
    const { width, height } = next;
    const size = defaultMorphFieldOptions.field;
    const field = new Uint8Array(size * size * 4);
    for (let index = 0; index < size * size; index += 1) {
      field[index * 4] = 128;
      field[index * 4 + 1] = 128;
      field[index * 4 + 3] = 255;
    }
    this.fieldSource = texelSource(field, size, size, 'linear');
    const previousColours = texelSource(previous.colours, previous.width, previous.height);
    const nextColours = texelSource(next.colours, width, height);
    const previousHeights = texelSource(
      morphCornerHeightTexels(previous.surface, previous.width, previous.height),
      previous.width + 1,
      previous.height + 1,
    );
    const nextHeights = texelSource(
      morphCornerHeightTexels(next.surface, width, height),
      width + 1,
      height + 1,
    );
    this.sources = [previousColours, nextColours, previousHeights, nextHeights];
    const depth = heightMorphDepth(
      width,
      height,
      Math.min(previous.surface?.minimum ?? 0, next.surface.minimum),
      Math.max(previous.surface?.maximum ?? 0, next.surface.maximum),
    );
    this.uniforms = new UniformGroup({
      uMorph: { value: new Float32Array([0, 0, width, height]), type: 'vec4<f32>' },
      uMorphFrame: {
        value: new Float32Array([previous.width, previous.height, depth.offset, depth.scale]),
        type: 'vec4<f32>',
      },
    });
    heightMorphProgram ??= GlProgram.from({
      name: 'rmside-height-morph',
      vertex: heightMorphVertex,
      fragment: heightMorphFragment,
      preferredFragmentPrecision: 'highp',
    });
    const surface = next.surface;
    this.geometry = new Geometry({
      attributes: {
        aPosition: {
          buffer: new Buffer({
            data: morphGridPositions(width, height),
            usage: BufferUsage.VERTEX,
          }),
          format: 'float32x2',
        },
      },
      indexBuffer: morphGridIndices(width, height, (tile) => surface.foldsTopBottom(tile)),
    });
    this.mesh = new Mesh({
      geometry: this.geometry,
      shader: new Shader({
        glProgram: heightMorphProgram,
        resources: {
          uPrevious: previousColours,
          uNext: nextColours,
          uPreviousHeights: previousHeights,
          uNextHeights: nextHeights,
          uField: this.fieldSource,
          morphUniforms: this.uniforms,
          raisedUniforms: nextUniforms.group,
        },
      }),
      state: raisedTerrainState(true, true, false),
    });
    this.mesh.eventMode = 'none';
    this.mesh.label = 'height-morph';
  }

  setField(texels: Uint8Array, size: number, maximum: number): boolean {
    if (this.destroyed || size !== this.fieldSource.width) return false;
    (this.fieldSource.resource as Uint8Array).set(texels);
    this.fieldSource.update();
    const morph = this.uniforms.uniforms.uMorph as Float32Array;
    morph[1] = maximum;
    this.uniforms.update();
    return true;
  }

  setProgress(progress: number): void {
    if (this.destroyed) return;
    const morph = this.uniforms.uniforms.uMorph as Float32Array;
    if (morph[0] === progress) return;
    morph[0] = progress;
    this.uniforms.update();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (!this.mesh.destroyed) {
      this.mesh.removeFromParent();
      this.mesh.shader?.destroy(false);
      this.mesh.destroy();
    }
    this.geometry.destroy(true);
    this.fieldSource.destroy();
    for (const source of this.sources) source.destroy();
  }
}
