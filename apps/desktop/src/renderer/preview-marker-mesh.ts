import {
  Buffer,
  BufferUsage,
  buildCircle,
  buildPolygon,
  Container,
  Geometry,
  GlProgram,
  Graphics,
  Mesh,
  Shader,
  type ShapeBuildCommand,
} from 'pixi.js';

export class MarkerMeshBuilder {
  private readonly vertices: number[] = [];
  private readonly indices: number[] = [];
  private readonly colors: number[] = [];

  get empty(): boolean {
    return this.indices.length === 0;
  }

  ellipse(x: number, y: number, radiusX: number, radiusY: number, color: number): void {
    this.fill(
      buildCircle,
      { type: 'ellipse', x, y, halfWidth: radiusX, halfHeight: radiusY } as never,
      color,
    );
  }

  polygon(points: readonly number[], color: number): void {
    this.fill(buildPolygon, { type: 'polygon', points, closePath: true } as never, color);
  }

  private fill(builder: ShapeBuildCommand, shape: never, color: number): void {
    const points: number[] = [];
    if (!builder.build(shape, points)) return;
    const firstVertex = this.vertices.length / 2;
    builder.triangulate(points, this.vertices, 2, firstVertex, this.indices, this.indices.length);
    const rgba = packedRgba(color);
    for (let vertex = firstVertex; vertex < this.vertices.length / 2; vertex += 1) {
      this.colors.push(rgba);
    }
  }

  triangles(): { vertices: number[]; indices: number[]; colors: number[] } {
    return { vertices: [...this.vertices], indices: [...this.indices], colors: [...this.colors] };
  }

  build(): Mesh<Geometry, Shader> | null {
    if (this.empty) return null;
    const positions = new Float32Array(this.vertices);
    const colors = new Uint32Array(this.colors);
    const geometry = new Geometry({
      attributes: {
        aPosition: {
          buffer: new Buffer({ data: positions, usage: BufferUsage.VERTEX }),
          format: 'float32x2',
        },
        aColor: {
          buffer: new Buffer({ data: colors, usage: BufferUsage.VERTEX }),
          format: 'unorm8x4',
        },
      },
      indexBuffer: new Uint32Array(this.indices),
    });
    const mesh = new OwnedMarkerMesh({
      geometry,
      shader: new Shader({ glProgram: markerProgram(), resources: {} }),
    });
    mesh.eventMode = 'none';
    return mesh;
  }
}

export class OrderedMarkerLayer {
  private fills = new MarkerMeshBuilder();
  private strokes: Graphics | null = null;

  constructor(private readonly stage: Container) {}

  get fill(): MarkerMeshBuilder {
    if (this.strokes) this.strokes = null;
    return this.fills;
  }

  get stroke(): Graphics {
    if (!this.strokes) {
      this.flushFills();
      this.strokes = new Graphics();
      this.stage.addChild(this.strokes);
    }
    return this.strokes;
  }

  finish(): void {
    this.flushFills();
  }

  private flushFills(): void {
    const mesh = this.fills.build();
    if (mesh) this.stage.addChild(mesh);
    this.fills = new MarkerMeshBuilder();
  }
}

class OwnedMarkerMesh extends Mesh<Geometry, Shader> {
  override destroy(options?: Parameters<Mesh['destroy']>[0]): void {
    const geometry = this.geometry;
    const shader = this.shader;
    super.destroy(options);
    geometry.destroy(true);
    shader?.destroy();
  }
}

function packedRgba(color: number): number {
  return (0xff000000 | ((color & 0xff) << 16) | (color & 0xff00) | ((color >> 16) & 0xff)) >>> 0;
}

const markerVertex = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec4 aColor;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec4 vColor;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vColor = aColor;
}
`;

const markerFragment = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 finalColor;
void main() {
  finalColor = vColor;
}
`;

let program: GlProgram | null = null;

function markerProgram(): GlProgram {
  program ??= GlProgram.from({
    name: 'rmside-object-markers',
    vertex: markerVertex,
    fragment: markerFragment,
  });
  return program;
}
