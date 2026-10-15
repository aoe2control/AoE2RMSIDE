import { GlProgram } from 'pixi.js';
import type { ZoomSizeLaw } from './top-down-preview';

export const mapLinearLaw: ZoomSizeLaw = Object.freeze({
  base: 1,
  minimum: 0,
  maximum: Number.POSITIVE_INFINITY,
});

const unbounded = 1e30;

const runStride = 8;

export class MarkerZoomRecorder {
  private runs = new Float64Array(runStride * 1024);
  private runCount = 0;
  private readonly strokes: MarkerZoomStroke[] = [];
  private offsetLaw: ZoomSizeLaw = mapLinearLaw;

  anchor(
    firstVertex: number,
    mapX: number,
    mapY: number,
    centerX: number,
    centerY: number,
    base: number,
    minimum: number,
    maximum: number,
  ): void {
    let runs = this.runs;
    const at = this.runCount * runStride;
    if (at + runStride > runs.length) {
      const grown = new Float64Array(runs.length * 2);
      grown.set(runs);
      this.runs = runs = grown;
    }
    runs[at] = firstVertex;
    runs[at + 1] = mapX;
    runs[at + 2] = mapY;
    runs[at + 3] = centerX;
    runs[at + 4] = centerY;
    runs[at + 5] = base;
    runs[at + 6] = minimum;
    runs[at + 7] = maximum;
    this.runCount += 1;
  }

  setOffsetLaw(law: ZoomSizeLaw): void {
    this.offsetLaw = law;
  }

  stroke(
    firstVertex: number,
    vertexCount: number,
    points: readonly number[],
    closed: boolean,
  ): void {
    this.strokes.push({ firstVertex, vertexCount, points: Array.from(points), closed });
  }

  take(): MarkerZoomRecord {
    const record: MarkerZoomRecord = {
      runs: this.runs,
      runCount: this.runCount,
      strokes: this.strokes.splice(0),
      offsetLaw: this.offsetLaw,
    };
    this.runs = new Float64Array(runStride * 1024);
    this.runCount = 0;
    this.offsetLaw = mapLinearLaw;
    return record;
  }
}

export interface MarkerZoomStroke {
  firstVertex: number;
  vertexCount: number;
  points: number[];
  closed: boolean;
}

export interface MarkerZoomRecord {
  runs: Float64Array;
  runCount: number;
  strokes: MarkerZoomStroke[];
  offsetLaw: ZoomSizeLaw;
}

export interface MarkerZoomAttributes {
  anchors: Float32Array;
  lines: Float32Array;
  laws: Float32Array;
}

export function markerZoomAttributes(
  positions: Float32Array,
  vertexCount: number,
  record: MarkerZoomRecord,
): MarkerZoomAttributes {
  const anchors = new Float32Array(vertexCount * 4);
  const lines = new Float32Array(vertexCount * 2);
  const laws = new Float32Array(vertexCount * 3);
  const { runs, runCount } = record;
  let run = -1;
  let nextStart = runCount > 0 ? runs[0]! : Number.POSITIVE_INFINITY;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    while (vertex >= nextStart) {
      run += 1;
      nextStart = run + 1 < runCount ? runs[(run + 1) * runStride]! : Number.POSITIVE_INFINITY;
    }
    const x = positions[vertex * 2]!;
    const y = positions[vertex * 2 + 1]!;
    lines[vertex * 2] = x;
    lines[vertex * 2 + 1] = y;
    if (run < 0) {
      anchors[vertex * 4] = x;
      anchors[vertex * 4 + 1] = y;
      anchors[vertex * 4 + 2] = x;
      anchors[vertex * 4 + 3] = y;
      laws[vertex * 3] = mapLinearLaw.base;
      laws[vertex * 3 + 1] = mapLinearLaw.minimum;
      laws[vertex * 3 + 2] = unbounded;
      continue;
    }
    const at = run * runStride;
    anchors[vertex * 4] = runs[at + 1]!;
    anchors[vertex * 4 + 1] = runs[at + 2]!;
    anchors[vertex * 4 + 2] = runs[at + 3]!;
    anchors[vertex * 4 + 3] = runs[at + 4]!;
    laws[vertex * 3] = runs[at + 5]!;
    laws[vertex * 3 + 1] = runs[at + 6]!;
    laws[vertex * 3 + 2] = Math.min(runs[at + 7]!, unbounded);
  }
  for (const stroke of record.strokes) {
    const joints = strokeJoints(stroke.points, stroke.closed);
    const end = Math.min(vertexCount, stroke.firstVertex + stroke.vertexCount);
    for (let vertex = stroke.firstVertex; vertex < end; vertex += 1) {
      const x = positions[vertex * 2]!;
      const y = positions[vertex * 2 + 1]!;
      let nearest = 0;
      let best = Number.POSITIVE_INFINITY;
      for (let joint = 0; joint < joints.length; joint += 2) {
        const distance = (joints[joint]! - x) ** 2 + (joints[joint + 1]! - y) ** 2;
        if (distance < best) {
          best = distance;
          nearest = joint;
        }
      }
      lines[vertex * 2] = joints[nearest] ?? x;
      lines[vertex * 2 + 1] = joints[nearest + 1] ?? y;
    }
  }
  return { anchors, lines, laws };
}

export function strokeJoints(points: readonly number[], closed: boolean): number[] {
  const joints = Array.from(points);
  if (!closed || joints.length < 4) return joints;
  const closePoint = 1e-4;
  if (
    Math.abs(joints[0]! - joints[joints.length - 2]!) < closePoint &&
    Math.abs(joints[1]! - joints[joints.length - 1]!) < closePoint
  ) {
    joints.length -= 2;
  }
  joints.push(
    (joints[0]! + joints[joints.length - 2]!) / 2,
    (joints[1]! + joints[joints.length - 1]!) / 2,
  );
  return joints;
}

export function zoomLawRatio(law: ZoomSizeLaw, factor: number): number {
  const drawn = Math.max(clampLaw(law.base, law), 1e-6);
  return clampLaw(law.base * factor, law) / (drawn * factor);
}

function clampLaw(value: number, law: ZoomSizeLaw): number {
  return Math.min(Math.max(value, law.minimum), law.maximum);
}

export function zoomedMarkerVertex(
  positions: Float32Array,
  attributes: MarkerZoomAttributes,
  offsetLaw: ZoomSizeLaw,
  index: number,
  factor: number,
): { x: number; y: number } {
  const { anchors, lines, laws } = attributes;
  const offset = zoomLawRatio(offsetLaw, factor);
  const size = zoomLawRatio(
    { base: laws[index * 3]!, minimum: laws[index * 3 + 1]!, maximum: laws[index * 3 + 2]! },
    factor,
  );
  const coordinate = (axis: 0 | 1) => {
    const map = anchors[index * 4 + axis]!;
    const center = anchors[index * 4 + 2 + axis]!;
    const line = lines[index * 2 + axis]!;
    return (
      map +
      (center - map) * offset +
      (line - center) * size +
      (positions[index * 2 + axis]! - line) / factor
    );
  };
  return { x: coordinate(0), y: coordinate(1) };
}

export function zoomLawTriple(law: ZoomSizeLaw): [number, number, number] {
  return [law.base, law.minimum, Math.min(law.maximum, unbounded)];
}

const zoomVertex = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec4 aColor;
in vec4 aAnchor;
in vec2 aLine;
in vec3 aLaw;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform float uMarkerZoom;
uniform vec3 uMarkerOffsetLaw;
out vec4 vColor;
float lawRatio(vec3 law) {
  float drawn = max(clamp(law.x, law.y, law.z), 1e-6);
  return clamp(law.x * uMarkerZoom, law.y, law.z) / (drawn * uMarkerZoom);
}
void main() {
  vec2 local = aAnchor.xy
    + (aAnchor.zw - aAnchor.xy) * lawRatio(uMarkerOffsetLaw)
    + (aLine - aAnchor.zw) * lawRatio(aLaw)
    + (aPosition - aLine) / uMarkerZoom;
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(local, 1.0)).xy, 0.0, 1.0);
  vColor = vec4(aColor.rgb * aColor.a, aColor.a);
}
`;

const zoomFragment = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 finalColor;
void main() {
  finalColor = vColor;
}
`;

let program: GlProgram | null = null;

export function markerZoomProgram(): GlProgram {
  program ??= GlProgram.from({
    name: 'rmside-object-markers-zoom',
    vertex: zoomVertex,
    fragment: zoomFragment,
  });
  return program;
}
