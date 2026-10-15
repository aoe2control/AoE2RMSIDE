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
import { defaultMorphFieldOptions } from './preview-morph-field';

const morphVertex = `#version 300 es
precision highp float;
in vec2 aPosition;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vMap;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  // The layer's local point (x + y, y - x) back to map point (x, y).
  vMap = vec2(aPosition.x - aPosition.y, aPosition.x + aPosition.y) * 0.5;
}
`;

const morphFragment = `#version 300 es
precision highp float;
in vec2 vMap;
uniform sampler2D uPrevious;
uniform sampler2D uNext;
uniform sampler2D uField;
// x: eased progress, y: the field's full-range offset, zw: the map's size.
uniform vec4 uMorph;
out vec4 finalColor;
void main() {
  vec2 uv = vMap / uMorph.zw;
  vec2 offset = (texture(uField, uv).rg * 255.0 - 128.0) / 127.0 * uMorph.y;
  float t = uMorph.x;
  vec4 previous = texture(uPrevious, uv + t * offset);
  vec4 next = texture(uNext, uv - (1.0 - t) * offset);
  finalColor = mix(previous, next, smoothstep(0.15, 0.85, t));
}
`;

export const terrainMorphShaders = { vertex: morphVertex, fragment: morphFragment };

let morphProgram: GlProgram | null = null;

export function morphQuadPositions(width: number, height: number): Float32Array {
  return new Float32Array([0, 0, width, -width, width + height, height - width, height, height]);
}

export class TerrainMorphMesh {
  readonly mesh: Mesh<Geometry, Shader>;
  private readonly geometry: Geometry;
  private readonly fieldSource: BufferImageSource;
  private readonly uniforms: UniformGroup;
  private destroyed = false;

  constructor(
    readonly width: number,
    readonly height: number,
    previous: TextureSource,
    next: TextureSource,
  ) {
    const size = defaultMorphFieldOptions.field;
    const texels = new Uint8Array(size * size * 4);
    for (let index = 0; index < size * size; index += 1) {
      texels[index * 4] = 128;
      texels[index * 4 + 1] = 128;
      texels[index * 4 + 3] = 255;
    }
    this.fieldSource = new BufferImageSource({
      resource: texels,
      width: size,
      height: size,
      format: 'rgba8unorm',
      scaleMode: 'linear',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
    });
    this.uniforms = new UniformGroup({
      uMorph: { value: new Float32Array([0, 0, width, height]), type: 'vec4<f32>' },
    });
    morphProgram ??= GlProgram.from({
      name: 'rmside-terrain-morph',
      vertex: morphVertex,
      fragment: morphFragment,
      preferredFragmentPrecision: 'highp',
    });
    this.geometry = new Geometry({
      attributes: {
        aPosition: {
          buffer: new Buffer({
            data: morphQuadPositions(width, height),
            usage: BufferUsage.VERTEX,
          }),
          format: 'float32x2',
        },
      },
      indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
    });
    this.mesh = new Mesh({
      geometry: this.geometry,
      shader: new Shader({
        glProgram: morphProgram,
        resources: {
          uPrevious: previous,
          uNext: next,
          uField: this.fieldSource,
          morphUniforms: this.uniforms,
        },
      }),
    });
    this.mesh.eventMode = 'none';
    this.mesh.label = 'terrain-morph';
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
  }
}
