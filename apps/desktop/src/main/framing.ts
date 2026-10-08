import { Buffer } from 'node:buffer';

export const maximumFrameBytes = 20 * 1024 * 1024;

export function encodeFrame(body: Uint8Array): Buffer {
  if (body.byteLength > maximumFrameBytes) throw new Error('protocol frame exceeds maximum length');
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32LE(body.byteLength, 0);
  Buffer.from(body).copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength > 0) {
      this.chunks.push(Buffer.from(chunk));
      this.bufferedBytes += chunk.byteLength;
    }
    const frames: Uint8Array[] = [];
    while (this.bufferedBytes >= 4) {
      const length = this.peekLength();
      if (length > maximumFrameBytes)
        throw new Error('protocol frame declares an excessive length');
      if (this.bufferedBytes < length + 4) break;
      const joined = this.take(length + 4);
      frames.push(Uint8Array.from(joined.subarray(4)));
    }
    return frames;
  }

  finish(): void {
    if (this.bufferedBytes !== 0) {
      throw new Error('a program of AoE2RMSIDE ended in the middle of a message');
    }
  }

  private peekLength(): number {
    const first = this.chunks[0]!;
    if (first.byteLength >= 4) return first.readUInt32LE(0);
    return this.take(4, false).readUInt32LE(0);
  }

  private take(bytes: number, consume = true): Buffer {
    const first = this.chunks[0]!;
    if (first.byteLength >= bytes) {
      if (!consume) return first.subarray(0, bytes);
      const part = first.subarray(0, bytes);
      if (first.byteLength === bytes) this.chunks.shift();
      else this.chunks[0] = first.subarray(bytes);
      this.bufferedBytes -= bytes;
      return part;
    }
    const joined = Buffer.concat(this.chunks, this.bufferedBytes);
    if (!consume) {
      this.chunks = [joined];
      return joined.subarray(0, bytes);
    }
    const rest = joined.subarray(bytes);
    this.chunks = rest.byteLength > 0 ? [rest] : [];
    this.bufferedBytes = rest.byteLength;
    return joined.subarray(0, bytes);
  }
}
