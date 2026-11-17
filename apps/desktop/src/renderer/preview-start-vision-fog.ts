import {
  Buffer,
  BufferImageSource,
  BufferUsage,
  Container,
  Geometry,
  GlProgram,
  Matrix,
  Mesh,
  Shader,
  Sprite,
  Texture,
  UniformGroup,
} from 'pixi.js';
import type { ElevationSurface } from './preview-elevation';
import { raisedColorVertexWords, type TerrainMesh } from './preview-raised-mesh';
import {
  raisedColorMesh,
  raisedTerrainState,
  raisedVertexCommon,
  type RaisedTerrainUniforms,
} from './preview-raised-terrain';
import { requestPreviewRender } from './preview-render-scheduler';
import { terrainLayerTransform } from './preview-tile-grid';
import type { PreviewCamera, PreviewViewport } from './top-down-preview';

export interface StartVisionFogRaised {
  surface: ElevationSurface;
  uniforms: RaisedTerrainUniforms;
  overlayBias(): number;
}

const fogVertex = `#version 300 es
precision highp float;
in vec4 aPosition;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uFog;
out vec2 vMap;
flat out float vKind;
${raisedVertexCommon}
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  // The colour terrain's rule: its rise and flatten included.
  float lift = 1.0 - uRaisedDepth.z;
  float height = aPosition.z * lift;
  vec2 local = vec2(aPosition.x, aPosition.y - height);
  gl_Position = vec4((mvp * vec3(local, 1.0)).xy, raisedDepthZ(aPosition.y + height, uFog.w), 1.0);
  vMap = vec2(aPosition.x - aPosition.y, aPosition.x + aPosition.y) * 0.5;
  vKind = floor((aPosition.w + 0.5) / 4096.0);
}
`;

const fogFragment = `#version 300 es
precision highp float;
in vec2 vMap;
flat in float vKind;
uniform sampler2D uFogMask;
// xy: the map's size in tiles, z: the fog's opacity, w: the depth bias.
uniform vec4 uFog;
out vec4 finalColor;
void main() {
  // The tile a fragment belongs to: a wall lies on its owner's front edge.
  ivec2 tile = vKind > 1.5
    ? ivec2(int(floor(vMap.x)), int(floor(vMap.y + 0.5)) - 1)
    : vKind > 0.5
      ? ivec2(int(floor(vMap.x + 0.5)), int(floor(vMap.y)))
      : ivec2(floor(vMap));
  tile = clamp(tile, ivec2(0), ivec2(uFog.xy) - 1);
  float alpha = texelFetch(uFogMask, tile, 0).a * uFog.z;
  finalColor = vec4(0.0, 0.0, 0.0, alpha);
}
`;

export const startVisionFogShaders = { vertex: fogVertex, fragment: fogFragment };

let fogProgram: GlProgram | null = null;

const fogMeshes = new WeakMap<ElevationSurface, TerrainMesh>();

function fogMesh(surface: ElevationSurface): TerrainMesh {
  let mesh = fogMeshes.get(surface);
  if (!mesh) {
    const built = raisedColorMesh(surface, new Uint8Array(surface.width * surface.height * 4));
    mesh = { vertices: built.vertices, indices: built.indices };
    fogMeshes.set(surface, mesh);
  }
  return mesh;
}

export function startVisionFogTexels(fog: Uint8Array, into: Uint8Array): void {
  for (let tile = 0; tile < fog.length; tile += 1) {
    into[tile * 4] = 0;
    into[tile * 4 + 1] = 0;
    into[tile * 4 + 2] = 0;
    into[tile * 4 + 3] = fog[tile] ? 255 : 0;
  }
}

export class StartVisionFogLayer {
  readonly container = new Container({ label: 'start-vision-fog' });
  private source: BufferImageSource | null = null;
  private texture: Texture | null = null;
  private sprite: Sprite | null = null;
  private mesh: Mesh<Geometry, Shader> | null = null;
  private geometry: Geometry | null = null;
  private uniforms: UniformGroup | null = null;
  private opacity = 0;
  private fog: Uint8Array | null = null;
  private destroyed = false;

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly raised: StartVisionFogRaised | null,
    private readonly objects: ((fog: Uint8Array | null, opacity: number) => void) | null = null,
  ) {
    this.container.eventMode = 'none';
    this.container.visible = false;
  }

  get underSprites(): boolean {
    return this.objects !== null;
  }

  get shown(): boolean {
    return this.container.visible;
  }

  place(camera: PreviewCamera, viewport: PreviewViewport): void {
    if (this.destroyed || this.underSprites) return;
    const transform = terrainLayerTransform(this, camera, viewport);
    this.container.scale.set(transform.scaleX, transform.scaleY);
    this.container.position.set(transform.x, transform.y);
  }

  set(fog: Uint8Array | null, opacity: number): void {
    if (this.destroyed) return;
    this.opacity = Math.min(1, Math.max(0, opacity));
    if (!fog || fog.length !== this.width * this.height) {
      this.fog = null;
      this.objects?.(null, this.opacity);
      this.container.visible = false;
      requestPreviewRender(this.container);
      return;
    }
    this.fog = fog;
    this.objects?.(fog, this.opacity);
    const source = this.ensureSource();
    startVisionFogTexels(fog, source.resource as Uint8Array);
    source.update();
    if (this.raised) this.ensureMesh(source);
    else this.ensureSprite(source);
    this.applyOpacity();
    this.container.visible = this.opacity > 0;
    requestPreviewRender(this.container);
  }

  setOpacity(opacity: number): void {
    if (this.destroyed) return;
    this.opacity = Math.min(1, Math.max(0, opacity));
    this.applyOpacity();
    if (this.fog) this.objects?.(this.fog, this.opacity);
    if (this.source) this.container.visible = this.opacity > 0;
    requestPreviewRender(this.container);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.objects?.(null, 0);
    if (this.mesh && !this.mesh.destroyed) {
      this.mesh.removeFromParent();
      this.mesh.shader?.destroy(false);
      this.mesh.destroy();
    }
    this.mesh = null;
    this.geometry?.destroy(true);
    this.geometry = null;
    if (this.sprite && !this.sprite.destroyed) {
      this.sprite.removeFromParent();
      this.sprite.destroy();
    }
    this.sprite = null;
    this.texture?.destroy(false);
    this.texture = null;
    this.source?.destroy();
    this.source = null;
    if (!this.container.destroyed) {
      this.container.removeFromParent();
      this.container.destroy();
    }
  }

  private ensureSource(): BufferImageSource {
    this.source ??= new BufferImageSource({
      resource: new Uint8Array(this.width * this.height * 4),
      width: this.width,
      height: this.height,
      format: 'rgba8unorm',
      alphaMode: 'premultiplied-alpha',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
    });
    return this.source;
  }

  private ensureSprite(source: BufferImageSource): void {
    if (this.sprite) return;
    this.texture = new Texture({ source });
    this.sprite = new Sprite({ texture: this.texture });
    this.sprite.eventMode = 'none';
    this.sprite.setFromMatrix(new Matrix(1, -1, 1, 1, 0, 0));
    this.container.addChild(this.sprite);
  }

  private ensureMesh(source: BufferImageSource): void {
    if (this.mesh || !this.raised) return;
    const { surface, uniforms } = this.raised;
    const mesh = fogMesh(surface);
    const stride = raisedColorVertexWords * 2;
    this.geometry = new Geometry({
      attributes: {
        aPosition: {
          buffer: new Buffer({ data: mesh.vertices, usage: BufferUsage.VERTEX }),
          format: 'sint16x4',
          stride,
          offset: 0,
        },
      },
      indexBuffer: mesh.indices,
    });
    fogProgram ??= GlProgram.from({
      name: 'rmside-start-vision-fog',
      vertex: fogVertex,
      fragment: fogFragment,
      preferredFragmentPrecision: 'highp',
    });
    this.uniforms = new UniformGroup({
      uFog: {
        value: new Float32Array([this.width, this.height, 0, 0]),
        type: 'vec4<f32>',
      },
    });
    this.mesh = new Mesh({
      geometry: this.geometry,
      shader: new Shader({
        glProgram: fogProgram,
        resources: {
          raisedUniforms: uniforms.group,
          fogUniforms: this.uniforms,
          uFogMask: source,
        },
      }),
      state: raisedTerrainState(surface.hasSteps, false),
    });
    this.mesh.eventMode = 'none';
    this.container.addChild(this.mesh);
  }

  private applyOpacity(): void {
    if (this.sprite) this.sprite.alpha = this.opacity;
    if (this.uniforms && this.raised) {
      const fog = this.uniforms.uniforms.uFog as Float32Array;
      fog[2] = this.opacity;
      fog[3] = this.raised.overlayBias();
      this.uniforms.update();
    }
  }
}
