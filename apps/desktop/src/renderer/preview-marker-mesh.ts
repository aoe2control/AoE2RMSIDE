import {
  Buffer,
  BufferUsage,
  buildCircle,
  buildLine,
  type Container,
  earcut,
  Geometry,
  GlProgram,
  Mesh,
  Shader,
  type StrokeAttributes,
  UniformGroup,
} from 'pixi.js';
import {
  markerZoomAttributes,
  markerZoomProgram,
  MarkerZoomRecorder,
  zoomLawTriple,
  type MarkerZoomRecord,
} from './preview-marker-zoom';
import type { ZoomSizeLaw } from './top-down-preview';

export class MarkerMeshBuilder {
  private storage = takeMarkerStorage();
  private vertexCount = 0;
  private indexCount = 0;
  private readonly zoom = new MarkerZoomRecorder();
  private readonly outlinePoints = new Map<number, number[]>([
    [6, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]],
    [8, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]],
    [20, new Array<number>(20).fill(0.5)],
  ]);

  get empty(): boolean {
    return this.indexCount === 0;
  }

  anchor(
    mapX: number,
    mapY: number,
    centerX: number,
    centerY: number,
    base: number,
    minimum: number,
    maximum: number,
  ): void {
    this.zoom.anchor(this.vertexCount, mapX, mapY, centerX, centerY, base, minimum, maximum);
  }

  setOffsetLaw(law: ZoomSizeLaw): void {
    this.zoom.setOffsetLaw(law);
  }

  ellipse(x: number, y: number, radiusX: number, radiusY: number, color: number): void {
    const points = ellipsePoints(x, y, radiusX, radiusY);
    if (!points) return;
    const firstVertex = this.vertexCount;
    const vertexAdded = points.length / 2 + 1;
    this.reserve(vertexAdded, (points.length / 2) * 3);
    triangulateEllipse(
      points,
      this.storage.vertices,
      firstVertex,
      this.storage.indices,
      this.indexCount,
    );
    this.indexCount += (points.length / 2) * 3;
    this.paint(firstVertex, vertexAdded, color, 1);
  }

  polygon(points: readonly number[], color: number, alpha = 1): void {
    const triangles = earcut(points as number[], noHoles, 2);
    if (!triangles) return;
    const firstVertex = this.vertexCount;
    const vertexAdded = points.length / 2;
    this.reserve(vertexAdded, triangles.length);
    const { indices, vertices } = this.storage;
    for (let index = 0; index < triangles.length; index += 1) {
      indices[this.indexCount++] = triangles[index]! + firstVertex;
    }
    for (let index = 0; index < points.length; index += 1) {
      vertices[firstVertex * 2 + index] = points[index]!;
    }
    this.paint(firstVertex, vertexAdded, color, alpha);
  }

  outline(
    unit: readonly number[],
    x: number,
    y: number,
    radius: number,
    verticalScale: number,
    color: number,
  ): void {
    const points = this.outlinePoints.get(unit.length);
    if (!points) {
      this.polygon(
        unit.map((value, index) =>
          index % 2 === 0 ? x + value * radius : y + value * radius * verticalScale,
        ),
        color,
      );
      return;
    }
    for (let index = 0; index < unit.length; index += 2) {
      points[index] = x + unit[index]! * radius;
      points[index + 1] = y + unit[index + 1]! * radius * verticalScale;
    }
    this.polygon(points, color);
  }

  stroke(
    points: readonly number[],
    closed: boolean,
    style: { color: number; width: number; alpha: number; cap?: 'butt' | 'square' },
  ): void {
    if (points.length <= 2) return;
    const vertices: number[] = [];
    const indices: number[] = [];
    buildLine(
      points as number[],
      { ...markerStrokeStyle, width: style.width, cap: style.cap ?? markerStrokeStyle.cap },
      false,
      closed,
      vertices,
      indices,
    );
    const firstVertex = this.vertexCount;
    const vertexAdded = vertices.length / 2;
    this.reserve(vertexAdded, indices.length);
    for (const index of indices) this.storage.indices[this.indexCount++] = index + firstVertex;
    this.storage.vertices.set(vertices, firstVertex * 2);
    this.paint(firstVertex, vertexAdded, style.color, style.alpha);
    this.zoom.stroke(firstVertex, vertexAdded, points, closed);
  }

  strokeEllipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    style: { color: number; width: number; alpha: number },
  ): void {
    const points = ellipsePoints(x, y, radiusX, radiusY);
    if (points) this.stroke(Array.from(points), true, style);
  }

  triangles(): { vertices: number[]; indices: number[]; colors: number[] } {
    return {
      vertices: Array.from(this.storage.vertices.subarray(0, this.vertexCount * 2)),
      indices: Array.from(this.storage.indices.subarray(0, this.indexCount)),
      colors: Array.from(this.storage.colors.subarray(0, this.vertexCount)),
    };
  }

  build(): Mesh<Geometry, Shader> | null {
    if (this.empty) return null;
    const positions = this.storage.vertices.slice(0, this.vertexCount * 2);
    const colors = this.storage.colors.slice(0, this.vertexCount);
    const indices = this.storage.indices.slice(0, this.indexCount);
    const zoom = this.zoom.take();
    releaseMarkerStorage(this.storage);
    this.storage = {
      vertices: new Float32Array(0),
      indices: new Uint32Array(0),
      colors: new Uint32Array(0),
    };
    this.vertexCount = 0;
    this.indexCount = 0;
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
      indexBuffer: indices,
    });
    const mesh = new OwnedMarkerMesh(
      { geometry, shader: new Shader({ glProgram: markerProgram(), resources: {} }) },
      zoom,
    );
    mesh.eventMode = 'none';
    return mesh;
  }

  private paint(first: number, count: number, color: number, alpha: number): void {
    const rgba = packedRgba(color, alpha);
    this.storage.colors.fill(rgba, first, first + count);
    this.vertexCount = first + count;
  }

  private reserve(vertices: number, indices: number): void {
    const storage = this.storage;
    const vertexCount = this.vertexCount + vertices;
    if (vertexCount > storage.colors.length) {
      const capacity = Math.max(vertexCount, storage.colors.length * 2);
      const grown = new Float32Array(capacity * 2);
      grown.set(storage.vertices.subarray(0, this.vertexCount * 2));
      storage.vertices = grown;
      const grownColors = new Uint32Array(capacity);
      grownColors.set(storage.colors.subarray(0, this.vertexCount));
      storage.colors = grownColors;
    }
    const indexCount = this.indexCount + indices;
    if (indexCount > storage.indices.length) {
      const grown = new Uint32Array(Math.max(indexCount, storage.indices.length * 2));
      grown.set(storage.indices.subarray(0, this.indexCount));
      storage.indices = grown;
    }
  }
}

export class OrderedMarkerLayer {
  readonly marks = new MarkerMeshBuilder();

  constructor(private readonly stage: Container) {}

  finish(): void {
    const mesh = this.marks.build();
    if (mesh) this.stage.addChild(mesh);
  }
}

class OwnedMarkerMesh extends Mesh<Geometry, Shader> {
  private readonly plain: { geometry: Geometry; shader: Shader };
  private zoomed: ZoomedMarkerMesh | null = null;
  private zoomFactor = 1;

  constructor(
    options: { geometry: Geometry; shader: Shader },
    private readonly zoomRecord: MarkerZoomRecord,
  ) {
    super(options);
    this.plain = options;
  }

  setZoom(factor: number): void {
    const next = Number.isFinite(factor) && factor > 0 ? factor : 1;
    if (next === this.zoomFactor || this.destroyed) return;
    this.zoomFactor = next;
    if (next === 1) {
      this.geometry = this.plain.geometry;
      this.shader = this.plain.shader;
      return;
    }
    const zoomed = (this.zoomed ??= this.buildZoomed());
    zoomed.uniforms.uniforms.uMarkerZoom = next;
    zoomed.uniforms.update();
    this.geometry = zoomed.geometry;
    this.shader = zoomed.shader;
  }

  get zoom(): number {
    return this.zoomFactor;
  }

  private buildZoomed(): ZoomedMarkerMesh {
    const plain = this.plain.geometry;
    const position = plain.getAttribute('aPosition');
    const positions = position.buffer.data as Float32Array;
    const attributes = markerZoomAttributes(positions, positions.length / 2, this.zoomRecord);
    const geometry = new Geometry({
      attributes: {
        aPosition: position,
        aColor: plain.getAttribute('aColor'),
        aAnchor: {
          buffer: new Buffer({ data: attributes.anchors, usage: BufferUsage.VERTEX }),
          format: 'float32x4',
        },
        aLine: {
          buffer: new Buffer({ data: attributes.lines, usage: BufferUsage.VERTEX }),
          format: 'float32x2',
        },
        aLaw: {
          buffer: new Buffer({ data: attributes.laws, usage: BufferUsage.VERTEX }),
          format: 'float32x3',
        },
      },
      indexBuffer: plain.indexBuffer,
    });
    const uniforms = new UniformGroup({
      uMarkerZoom: { value: 1, type: 'f32' },
      uMarkerOffsetLaw: {
        value: new Float32Array(zoomLawTriple(this.zoomRecord.offsetLaw)),
        type: 'vec3<f32>',
      },
    });
    const shader = new Shader({ glProgram: markerZoomProgram(), resources: { uniforms } });
    return { geometry, shader, uniforms };
  }

  override destroy(options?: Parameters<Mesh['destroy']>[0]): void {
    const { geometry, shader } = this.plain;
    const zoomed = this.zoomed;
    this.zoomed = null;
    super.destroy(options);
    if (zoomed) {
      const own = ['aAnchor', 'aLine', 'aLaw'].map(
        (name) => zoomed.geometry.getAttribute(name).buffer,
      );
      zoomed.geometry.destroy(false);
      for (const buffer of own) buffer.destroy();
      zoomed.shader.destroy();
    }
    geometry.destroy(true);
    shader.destroy();
  }
}

interface ZoomedMarkerMesh {
  geometry: Geometry;
  shader: Shader;
  uniforms: UniformGroup;
}

export function zoomMarkerMeshes(layer: Container, factor: number): void {
  for (const child of layer.children) {
    if (child instanceof OwnedMarkerMesh) child.setZoom(factor);
  }
}

export function markerMeshZoom(layer: Container): number | null {
  for (const child of layer.children) {
    if (child instanceof OwnedMarkerMesh) return child.zoom;
  }
  return null;
}

interface MarkerStorage {
  vertices: Float32Array;
  indices: Uint32Array;
  colors: Uint32Array;
}

let spareStorage: MarkerStorage | null = null;
const maximumSpareBytes = 32 * 1024 * 1024;

function takeMarkerStorage(): MarkerStorage {
  const storage = spareStorage ?? {
    vertices: new Float32Array(8192),
    indices: new Uint32Array(12288),
    colors: new Uint32Array(4096),
  };
  spareStorage = null;
  return storage;
}

function releaseMarkerStorage(storage: MarkerStorage): void {
  const bytes =
    storage.vertices.byteLength + storage.indices.byteLength + storage.colors.byteLength;
  if (bytes <= maximumSpareBytes) spareStorage = storage;
}

const noHoles: number[] = [];

function triangulateEllipse(
  points: Float64Array,
  vertices: Float32Array,
  verticesOffset: number,
  indices: Uint32Array,
  indicesOffset: number,
): void {
  if (points.length === 0) return;
  let centerX = 0;
  let centerY = 0;
  for (let index = 0; index < points.length; index += 2) {
    centerX += points[index]!;
    centerY += points[index + 1]!;
  }
  centerX /= points.length / 2;
  centerY /= points.length / 2;
  let count = verticesOffset;
  vertices[count * 2] = centerX;
  vertices[count * 2 + 1] = centerY;
  const centerIndex = count++;
  for (let index = 0; index < points.length; index += 2) {
    vertices[count * 2] = points[index]!;
    vertices[count * 2 + 1] = points[index + 1]!;
    if (index > 0) {
      indices[indicesOffset++] = count;
      indices[indicesOffset++] = centerIndex;
      indices[indicesOffset++] = count - 1;
    }
    count++;
  }
  indices[indicesOffset++] = centerIndex + 1;
  indices[indicesOffset++] = centerIndex;
  indices[indicesOffset++] = count - 1;
}

const markerStrokeStyle: StrokeAttributes = {
  width: 1,
  alignment: 0.5,
  miterLimit: 10,
  cap: 'butt',
  join: 'miter',
};

interface EllipseTemplate {
  offsets: Float64Array;
  points: Float64Array;
}

const ellipseTemplates = new Map<number, Map<number, EllipseTemplate>>();
let ellipseTemplateCount = 0;
const maximumEllipseTemplates = 512;

function ellipsePoints(
  x: number,
  y: number,
  radiusX: number,
  radiusY: number,
): Float64Array | null {
  if (radiusX <= 0 || radiusY <= 0) return null;
  let byHeight = ellipseTemplates.get(radiusX);
  let template = byHeight?.get(radiusY);
  if (!template) {
    const offsets: number[] = [];
    if (
      !buildCircle.build(
        { type: 'ellipse', x: 0, y: 0, halfWidth: radiusX, halfHeight: radiusY } as never,
        offsets,
      )
    ) {
      return null;
    }
    if (ellipseTemplateCount >= maximumEllipseTemplates) {
      ellipseTemplates.clear();
      ellipseTemplateCount = 0;
      byHeight = undefined;
    }
    if (!byHeight) {
      byHeight = new Map();
      ellipseTemplates.set(radiusX, byHeight);
    }
    template = {
      offsets: Float64Array.from(offsets),
      points: new Float64Array(offsets.length),
    };
    byHeight.set(radiusY, template);
    ellipseTemplateCount += 1;
  }
  const { offsets, points } = template;
  for (let index = 0; index < offsets.length; index += 2) {
    points[index] = x + offsets[index]!;
    points[index + 1] = y + offsets[index + 1]!;
  }
  return points;
}

function packedRgba(color: number, alpha: number): number {
  return (
    (((alpha * 255) << 24) | ((color & 0xff) << 16) | (color & 0xff00) | ((color >> 16) & 0xff)) >>>
    0
  );
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
  vColor = vec4(aColor.rgb * aColor.a, aColor.a);
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
