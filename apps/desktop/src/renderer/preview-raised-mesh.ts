import { raisedWallLight, type ElevationSurface } from './preview-elevation';

export const flatVertexWords = 2;
export const raisedVertexWords = 4;
export const raisedColorVertexWords = 6;

export const raisedWallCodeUnit = 4096;
export const raisedLightCodeScale = 1000;

export function raisedLightCode(light: number, wallKind: 0 | 1 | 2 = 0): number {
  return wallKind * raisedWallCodeUnit + Math.round(light * raisedLightCodeScale);
}

export interface TerrainMesh {
  vertices: Int16Array;
  indices: Uint16Array | Uint32Array;
}

function compactIndices(indices: Uint32Array, vertexCount: number): Uint16Array | Uint32Array {
  return vertexCount <= 0x1_0000 ? Uint16Array.from(indices) : indices;
}

export class EdgeMarks {
  readonly marks: Uint8Array;
  readonly stride: number;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly originX = 0,
    readonly originY = 0,
  ) {
    this.stride = width + 1;
    this.marks = new Uint8Array(this.stride * (height + 1));
  }

  piece(x0: number, x1: number, y: number): void {
    const top = (y - this.originY) * this.stride - this.originX;
    const bottom = top + this.stride;
    this.marks[top + x0] = 1;
    this.marks[top + x1] = 1;
    this.marks[bottom + x0] = 1;
    this.marks[bottom + x1] = 1;
  }

  line(line: number, x0: number, x1: number): void {
    const start = (line - this.originY) * this.stride - this.originX;
    this.marks.fill(1, start + x0, start + x1 + 1);
  }

  has(x: number, line: number): boolean {
    return this.marks[(line - this.originY) * this.stride + x - this.originX] === 1;
  }
}

export function tileRuns(tiles: readonly number[], width: number): number[] {
  const runs: number[] = [];
  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index]!;
    const x = tile % width;
    const y = (tile - x) / width;
    const last = runs.length - 3;
    if (last >= 0 && runs[last + 2] === y && runs[last + 1] === x) runs[last + 1] = x + 1;
    else runs.push(x, x + 1, y);
  }
  return runs;
}

export function markRuns(marks: EdgeMarks, runs: readonly number[]): void {
  for (let run = 0; run < runs.length; run += 3)
    marks.piece(runs[run]!, runs[run + 1]!, runs[run + 2]!);
}

class MeshWriter {
  private vertices: Int16Array;
  private indices: Uint32Array;
  vertexCount = 0;
  indexCount = 0;
  color = 0;
  tracking = false;
  minimumS = 0;
  maximumS = 0;
  minimumV = 0;
  maximumV = 0;

  constructor(
    readonly words: number,
    capacity = 256,
  ) {
    this.vertices = new Int16Array(capacity * words);
    this.indices = new Uint32Array(capacity * 2);
  }

  vertex(s: number, t: number, h = 0, code = 0): number {
    if ((this.vertexCount + 1) * this.words > this.vertices.length) {
      const next = new Int16Array(this.vertices.length * 2);
      next.set(this.vertices);
      this.vertices = next;
    }
    const word = this.vertexCount * this.words;
    this.vertices[word] = s;
    this.vertices[word + 1] = t;
    if (this.words > 2) {
      this.vertices[word + 2] = h;
      this.vertices[word + 3] = code;
    }
    if (this.words > 4) {
      this.vertices[word + 4] = ((this.color >> 16) & 0xff) | (((this.color >> 8) & 0xff) << 8);
      this.vertices[word + 5] = this.color & 0xff;
    }
    if (this.tracking) {
      const v = t - h;
      if (s < this.minimumS) this.minimumS = s;
      if (s > this.maximumS) this.maximumS = s;
      if (v < this.minimumV) this.minimumV = v;
      if (v > this.maximumV) this.maximumV = v;
    }
    this.vertexCount += 1;
    return this.vertexCount - 1;
  }

  resetBounds(): void {
    this.minimumS = Number.POSITIVE_INFINITY;
    this.maximumS = Number.NEGATIVE_INFINITY;
    this.minimumV = Number.POSITIVE_INFINITY;
    this.maximumV = Number.NEGATIVE_INFINITY;
  }

  triangle(a: number, b: number, c: number): void {
    if (this.indexCount + 3 > this.indices.length) {
      const next = new Uint32Array(this.indices.length * 2);
      next.set(this.indices);
      this.indices = next;
    }
    this.indices[this.indexCount] = a;
    this.indices[this.indexCount + 1] = b;
    this.indices[this.indexCount + 2] = c;
    this.indexCount += 3;
  }

  result(): TerrainMesh {
    return {
      vertices: this.vertices.slice(0, this.vertexCount * this.words),
      indices: compactIndices(this.indices.subarray(0, this.indexCount), this.vertexCount),
    };
  }
}

function writeRun(
  writer: MeshWriter,
  marks: EdgeMarks,
  x0: number,
  x1: number,
  y: number,
  h: number,
  code: number,
): void {
  const vertex = (x: number, line: number) => writer.vertex(x + line, line - x, h, code);
  let topX = x0;
  let bottomX = x0;
  let top = vertex(x0, y);
  let bottom = vertex(x0, y + 1);
  while (topX < x1 || bottomX < x1) {
    let nextTop = topX + 1;
    while (nextTop < x1 && !marks.has(nextTop, y)) nextTop += 1;
    let nextBottom = bottomX + 1;
    while (nextBottom < x1 && !marks.has(nextBottom, y + 1)) nextBottom += 1;
    if (topX < x1 && (bottomX >= x1 || nextTop <= nextBottom)) {
      const next = vertex(nextTop, y);
      writer.triangle(top, next, bottom);
      top = next;
      topX = nextTop;
    } else {
      const next = vertex(nextBottom, y + 1);
      writer.triangle(top, next, bottom);
      bottom = next;
      bottomX = nextBottom;
    }
  }
}

export function flatRunMesh(runs: readonly number[], marks: EdgeMarks): TerrainMesh {
  const writer = new MeshWriter(flatVertexWords, Math.max(16, runs.length * 2));
  for (let run = 0; run < runs.length; run += 3) {
    writeRun(writer, marks, runs[run]!, runs[run + 1]!, runs[run + 2]!, 0, 0);
  }
  return writer.result();
}

export interface RaisedPieces {
  runs: number[];
  sloped: number[];
  walls: boolean;
  tiles: readonly number[];
}

export function raisedPieces(
  tiles: readonly number[],
  surface: ElevationSurface,
  walls: boolean,
  keyOf: ((tile: number) => number) | null = null,
): RaisedPieces {
  const width = surface.width;
  const runs: number[] = [];
  const sloped: number[] = [];
  for (let position = 0; position < tiles.length; position += 1) {
    const tile = tiles[position]!;
    const x = tile % width;
    const y = (tile - x) / width;
    if (!surface.flat(tile)) {
      sloped.push(tile);
      continue;
    }
    const h = surface.corners[tile * 4]!;
    const last = runs.length - 4;
    if (
      last >= 0 &&
      runs[last + 2] === y &&
      runs[last + 1] === x &&
      runs[last + 3] === h &&
      (!keyOf || keyOf(tile) === keyOf(tile - 1))
    ) {
      runs[last + 1] = x + 1;
    } else {
      runs.push(x, x + 1, y, h);
    }
  }
  return { runs, sloped, walls, tiles };
}

export function markRaisedPieces(marks: EdgeMarks, pieces: RaisedPieces, width: number): void {
  for (let run = 0; run < pieces.runs.length; run += 4) {
    marks.piece(pieces.runs[run]!, pieces.runs[run + 1]!, pieces.runs[run + 2]!);
  }
  for (const tile of pieces.sloped) {
    const x = tile % width;
    marks.piece(x, x + 1, (tile - x) / width);
  }
}

export function markWalls(
  marks: EdgeMarks,
  tiles: readonly number[],
  surface: ElevationSurface,
): void {
  const width = surface.width;
  for (const tile of tiles) {
    const x = tile % width;
    const y = (tile - x) / width;
    if (surface.frontWalls(x, y) !== 0) marks.piece(x, x + 1, y);
  }
}

export function raisedMesh(
  pieces: RaisedPieces,
  surface: ElevationSurface,
  marks: EdgeMarks,
  lightStrength: number,
  colorOf: ((tile: number) => number) | null = null,
): TerrainMesh & { wallQuads: number; quads: number } {
  const writer = new MeshWriter(
    colorOf ? raisedColorVertexWords : raisedVertexWords,
    Math.max(16, pieces.runs.length + pieces.sloped.length * 4),
  );
  const write = new RaisedPieceWriter(writer, pieces, surface, marks, lightStrength, colorOf);
  for (let run = 0; run < pieces.runs.length; run += 4) write.run(run);
  for (const tile of pieces.sloped) write.sloped(tile);
  let wallQuads = 0;
  if (pieces.walls) {
    for (const tile of pieces.tiles) wallQuads += write.walls(tile);
  }
  return {
    ...writer.result(),
    wallQuads,
    quads: pieces.runs.length / 4 + pieces.sloped.length,
  };
}

class RaisedPieceWriter {
  private readonly width: number;
  private readonly flatCode = raisedLightCode(1);
  private readonly leftCode: number;
  private readonly rightCode: number;

  constructor(
    private readonly writer: MeshWriter,
    private readonly pieces: RaisedPieces,
    private readonly surface: ElevationSurface,
    private readonly marks: EdgeMarks,
    private readonly lightStrength: number,
    private readonly colorOf: ((tile: number) => number) | null,
  ) {
    this.width = surface.width;
    this.leftCode = raisedLightCode(raisedWallLight('left', lightStrength), 1);
    this.rightCode = raisedLightCode(raisedWallLight('right', lightStrength), 2);
  }

  run(run: number): void {
    const runs = this.pieces.runs;
    if (this.colorOf) this.writer.color = this.colorOf(runs[run + 2]! * this.width + runs[run]!);
    writeRun(
      this.writer,
      this.marks,
      runs[run]!,
      runs[run + 1]!,
      runs[run + 2]!,
      runs[run + 3]!,
      this.flatCode,
    );
  }

  sloped(tile: number): void {
    if (this.colorOf) this.writer.color = this.colorOf(tile);
    writeSlopedTile(this.writer, this.surface, tile, this.lightStrength);
  }

  walls(tile: number): number {
    if (this.colorOf) this.writer.color = this.colorOf(tile);
    return writeWalls(this.writer, this.surface, tile, this.leftCode, this.rightCode);
  }
}

export interface RaisedMeshChunk {
  start: number;
  count: number;
  minimumS: number;
  maximumS: number;
  minimumV: number;
  maximumV: number;
}

export function raisedChunkedMesh(
  pieces: RaisedPieces,
  surface: ElevationSurface,
  marks: EdgeMarks,
  lightStrength: number,
  colorOf: ((tile: number) => number) | null,
  chunkSize: number,
): TerrainMesh & {
  wallQuads: number;
  quads: number;
  chunks: RaisedMeshChunk[];
} {
  const width = surface.width;
  const height = surface.height;
  const size = Math.max(1, Math.floor(chunkSize));
  const chunksX = Math.max(1, Math.ceil(width / size));
  const chunkCount = chunksX * Math.max(1, Math.ceil(height / size));
  const columnChunk = new Uint32Array(width);
  for (let x = 0; x < width; x += 1) columnChunk[x] = Math.floor(x / size);
  const rowChunk = new Uint32Array(height);
  for (let y = 0; y < height; y += 1) rowChunk[y] = Math.floor(y / size) * chunksX;
  const runCount = pieces.runs.length / 4;
  const runKeys = new Uint32Array(runCount);
  for (let run = 0; run < runCount; run += 1) {
    runKeys[run] = rowChunk[pieces.runs[run * 4 + 2]!]! + columnChunk[pieces.runs[run * 4]!]!;
  }
  const tileChunk = (tile: number) => {
    const x = tile % width;
    return rowChunk[(tile - x) / width]! + columnChunk[x]!;
  };
  const slopedKeys = new Uint32Array(pieces.sloped.length);
  for (let index = 0; index < slopedKeys.length; index += 1) {
    slopedKeys[index] = tileChunk(pieces.sloped[index]!);
  }
  const wallTiles: number[] = [];
  if (pieces.walls && surface.wallCount > 0) {
    const corners = surface.corners;
    const count = width * height;
    for (const tile of pieces.tiles) {
      const base = tile * 4;
      const below = (tile + width) * 4;
      if (
        (tile % width > 0 &&
          (corners[base]! > corners[base - 3]! || corners[base + 3]! > corners[base - 2]!)) ||
        (tile + width < count &&
          (corners[base + 3]! > corners[below]! || corners[base + 2]! > corners[below + 1]!))
      ) {
        wallTiles.push(tile);
      }
    }
  }
  const runs = bucketByChunk(runKeys, chunkCount);
  const sloped = bucketByChunk(slopedKeys, chunkCount);
  const wallKeys = new Uint32Array(wallTiles.length);
  for (let index = 0; index < wallKeys.length; index += 1) {
    wallKeys[index] = tileChunk(wallTiles[index]!);
  }
  const walls = bucketByChunk(wallKeys, chunkCount);
  const writer = new MeshWriter(
    colorOf ? raisedColorVertexWords : raisedVertexWords,
    Math.max(16, pieces.runs.length + pieces.sloped.length * 4),
  );
  writer.tracking = true;
  const write = new RaisedPieceWriter(writer, pieces, surface, marks, lightStrength, colorOf);
  const chunks: RaisedMeshChunk[] = [];
  let wallQuads = 0;
  for (let chunk = 0; chunk < chunkCount; chunk += 1) {
    writer.resetBounds();
    const start = writer.indexCount;
    for (let at = runs.offsets[chunk]!; at < runs.offsets[chunk + 1]!; at += 1) {
      write.run(runs.order[at]! * 4);
    }
    for (let at = sloped.offsets[chunk]!; at < sloped.offsets[chunk + 1]!; at += 1) {
      write.sloped(pieces.sloped[sloped.order[at]!]!);
    }
    for (let at = walls.offsets[chunk]!; at < walls.offsets[chunk + 1]!; at += 1) {
      wallQuads += write.walls(wallTiles[walls.order[at]!]!);
    }
    const count = writer.indexCount - start;
    chunks.push(
      count > 0
        ? {
            start,
            count,
            minimumS: writer.minimumS,
            maximumS: writer.maximumS,
            minimumV: writer.minimumV,
            maximumV: writer.maximumV,
          }
        : { start, count: 0, minimumS: 0, maximumS: 0, minimumV: 0, maximumV: 0 },
    );
  }
  return { ...writer.result(), wallQuads, quads: runCount + pieces.sloped.length, chunks };
}

export interface RaisedTileRect {
  minimumX: number;
  maximumX: number;
  minimumY: number;
  maximumY: number;
}

export function raisedRectMesh(
  surface: ElevationSurface,
  rect: RaisedTileRect,
  lightStrength: number,
  colorOf: ((tile: number) => number) | null,
): TerrainMesh & {
  quads: number;
  wallQuads: number;
  bounds: Omit<RaisedMeshChunk, 'start' | 'count'>;
} {
  const width = surface.width;
  const tiles: number[] = [];
  for (let y = rect.minimumY; y <= rect.maximumY; y += 1) {
    for (let x = rect.minimumX; x <= rect.maximumX; x += 1) tiles.push(y * width + x);
  }
  const pieces = raisedPieces(tiles, surface, true, colorOf);
  const marks = new EdgeMarks(
    rect.maximumX - rect.minimumX + 1,
    rect.maximumY - rect.minimumY + 1,
    rect.minimumX,
    rect.minimumY,
  );
  markRaisedPieces(marks, pieces, width);
  markWalls(marks, tiles, surface);
  marks.line(rect.minimumY, rect.minimumX, rect.maximumX + 1);
  marks.line(rect.maximumY + 1, rect.minimumX, rect.maximumX + 1);
  const writer = new MeshWriter(
    colorOf ? raisedColorVertexWords : raisedVertexWords,
    Math.max(16, pieces.runs.length + pieces.sloped.length * 4),
  );
  writer.tracking = true;
  writer.resetBounds();
  const write = new RaisedPieceWriter(writer, pieces, surface, marks, lightStrength, colorOf);
  for (let run = 0; run < pieces.runs.length; run += 4) write.run(run);
  for (const tile of pieces.sloped) write.sloped(tile);
  let wallQuads = 0;
  if (surface.wallCount > 0) {
    for (const tile of tiles) wallQuads += write.walls(tile);
  }
  const empty = writer.vertexCount === 0;
  return {
    ...writer.result(),
    quads: pieces.runs.length / 4 + pieces.sloped.length,
    wallQuads,
    bounds: {
      minimumS: empty ? 0 : writer.minimumS,
      maximumS: empty ? 0 : writer.maximumS,
      minimumV: empty ? 0 : writer.minimumV,
      maximumV: empty ? 0 : writer.maximumV,
    },
  };
}

function bucketByChunk(
  keys: Uint32Array,
  buckets: number,
): { order: Uint32Array; offsets: Uint32Array } {
  const count = keys.length;
  const offsets = new Uint32Array(buckets + 1);
  for (let item = 0; item < count; item += 1) offsets[keys[item]! + 1]! += 1;
  for (let bucket = 0; bucket < buckets; bucket += 1) offsets[bucket + 1]! += offsets[bucket]!;
  const next = offsets.slice(0, buckets);
  const order = new Uint32Array(count);
  for (let item = 0; item < count; item += 1) {
    const key = keys[item]!;
    order[next[key]!] = item;
    next[key]! += 1;
  }
  return { order, offsets };
}

function cornerX(x: number, corner: number): number {
  return corner === 1 || corner === 2 ? x + 1 : x;
}

function cornerY(y: number, corner: number): number {
  return corner >= 2 ? y + 1 : y;
}

function writeSlopedTile(
  writer: MeshWriter,
  surface: ElevationSurface,
  tile: number,
  strength: number,
): void {
  const width = surface.width;
  const x = tile % width;
  const y = (tile - x) / width;
  const h = (corner: number) => surface.corners[tile * 4 + corner]!;
  const order = surface.foldsTopBottom(tile) ? [1, 2, 3, 0] : [0, 1, 2, 3];
  const code = raisedLightCode(surface.tileLight(tile, strength));
  const indices = order.map((corner) => {
    const mapX = cornerX(x, corner);
    const mapY = cornerY(y, corner);
    return writer.vertex(mapX + mapY, mapY - mapX, h(corner), code);
  });
  writer.triangle(indices[0]!, indices[1]!, indices[2]!);
  writer.triangle(indices[0]!, indices[2]!, indices[3]!);
}

function writeWalls(
  writer: MeshWriter,
  surface: ElevationSurface,
  tile: number,
  leftCode: number,
  rightCode: number,
): number {
  const width = surface.width;
  const x = tile % width;
  const y = (tile - x) / width;
  const walls = surface.frontWalls(x, y);
  if (walls === 0) return 0;
  const corners = surface.corners;
  let count = 0;
  const quad = (
    x0: number,
    y0: number,
    top0: number,
    foot0: number,
    x1: number,
    y1: number,
    top1: number,
    foot1: number,
    code: number,
  ) => {
    const a = writer.vertex(x0 + y0, y0 - x0, top0, code);
    const b = writer.vertex(x1 + y1, y1 - x1, top1, code);
    const c = writer.vertex(x1 + y1, y1 - x1, Math.min(top1, foot1), code);
    const d = writer.vertex(x0 + y0, y0 - x0, Math.min(top0, foot0), code);
    writer.triangle(a, b, c);
    writer.triangle(a, c, d);
    count += 1;
  };
  if (walls & 1) {
    const neighbour = (tile - 1) * 4;
    quad(
      x,
      y,
      corners[tile * 4]!,
      corners[neighbour + 1]!,
      x,
      y + 1,
      corners[tile * 4 + 3]!,
      corners[neighbour + 2]!,
      leftCode,
    );
  }
  if (walls & 2) {
    const neighbour = (tile + width) * 4;
    quad(
      x,
      y + 1,
      corners[tile * 4 + 3]!,
      corners[neighbour]!,
      x + 1,
      y + 1,
      corners[tile * 4 + 2]!,
      corners[neighbour + 1]!,
      rightCode,
    );
  }
  return count;
}

export function quadIndices(quadCount: number): Uint16Array | Uint32Array {
  const indices =
    quadCount * 4 <= 0x1_0000 ? new Uint16Array(quadCount * 6) : new Uint32Array(quadCount * 6);
  for (let quad = 0, at = 0; quad < quadCount; quad += 1, at += 6) {
    const vertex = quad * 4;
    indices[at] = vertex;
    indices[at + 1] = vertex + 1;
    indices[at + 2] = vertex + 2;
    indices[at + 3] = vertex;
    indices[at + 4] = vertex + 2;
    indices[at + 5] = vertex + 3;
  }
  return indices;
}
