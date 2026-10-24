import { PictureError } from './picture-error';
import { forEachTextPixel } from './picture-font';

export const pictureMaximumShapeWork = 512 * 1024 * 1024;
const cancellationStride = 32;

export interface PictureClip {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export class PictureCanvas {
  readonly pixels: Uint8ClampedArray;
  private clipRect: PictureClip;
  private work = 0;
  private rows = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    background: number,
    private readonly signal?: AbortSignal,
  ) {
    this.pixels = new Uint8ClampedArray(width * height * 4);
    const red = (background >> 16) & 0xff;
    const green = (background >> 8) & 0xff;
    const blue = background & 0xff;
    for (let offset = 0; offset < this.pixels.length; offset += 4) {
      this.pixels[offset] = red;
      this.pixels[offset + 1] = green;
      this.pixels[offset + 2] = blue;
      this.pixels[offset + 3] = 255;
    }
    this.clipRect = { left: 0, top: 0, right: width, bottom: height };
  }

  get clip(): PictureClip {
    return this.clipRect;
  }

  setClip(clip: PictureClip | null): void {
    this.clipRect = clip
      ? {
          left: Math.max(0, Math.floor(clip.left)),
          top: Math.max(0, Math.floor(clip.top)),
          right: Math.min(this.width, Math.ceil(clip.right)),
          bottom: Math.min(this.height, Math.ceil(clip.bottom)),
        }
      : { left: 0, top: 0, right: this.width, bottom: this.height };
  }

  checkCancelled(): void {
    if (this.signal?.aborted) throw new PictureError('cancelled', 'the picture was cancelled');
  }

  tickRow(): void {
    this.rows += 1;
    if (this.rows % cancellationStride === 0) this.checkCancelled();
  }

  setPixel(x: number, y: number, rgb: number): void {
    const offset = (y * this.width + x) * 4;
    this.pixels[offset] = (rgb >> 16) & 0xff;
    this.pixels[offset + 1] = (rgb >> 8) & 0xff;
    this.pixels[offset + 2] = rgb & 0xff;
  }

  fillRect(left: number, top: number, width: number, height: number, rgb: number): void {
    const bounds = this.bounds(left, top, left + width, top + height, true);
    if (!bounds) return;
    for (let y = bounds.top; y < bounds.bottom; y += 1) {
      for (let x = bounds.left; x < bounds.right; x += 1) this.setPixel(x, y, rgb);
    }
  }

  fillBox(left: number, top: number, right: number, bottom: number, rgb: number): void {
    const bounds = this.bounds(
      Math.ceil(left - 0.5),
      Math.ceil(top - 0.5),
      Math.ceil(right - 0.5),
      Math.ceil(bottom - 0.5),
      true,
    );
    if (!bounds) return;
    for (let y = bounds.top; y < bounds.bottom; y += 1) {
      for (let x = bounds.left; x < bounds.right; x += 1) this.setPixel(x, y, rgb);
    }
  }

  fillPolygon(points: readonly number[], rgb: number): void {
    const count = points.length / 2;
    if (count < 3) return;
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < count; index += 1) {
      const x = points[index * 2]!;
      const y = points[index * 2 + 1]!;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
    const bounds = this.bounds(left, top, right, bottom, false);
    if (!bounds) return;
    const crossings: number[] = [];
    for (let py = bounds.top; py < bounds.bottom; py += 1) {
      const sampleY = py + 0.5;
      crossings.length = 0;
      for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
        const x0 = points[index * 2]!;
        const y0 = points[index * 2 + 1]!;
        const x1 = points[previous * 2]!;
        const y1 = points[previous * 2 + 1]!;
        if (y0 > sampleY !== y1 > sampleY) {
          crossings.push(((x1 - x0) * (sampleY - y0)) / (y1 - y0) + x0);
        }
      }
      crossings.sort((a, b) => a - b);
      for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
        const from = Math.max(bounds.left, Math.ceil(crossings[pair]! - 0.5));
        const to = Math.min(bounds.right, Math.ceil(crossings[pair + 1]! - 0.5));
        for (let px = from; px < to; px += 1) this.setPixel(px, py, rgb);
      }
    }
  }

  strokeSegment(x0: number, y0: number, x1: number, y1: number, width: number, rgb: number): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lengthSquared = dx * dx + dy * dy;
    const half = width / 2;
    const limit = half * half;
    const bounds = this.bounds(
      Math.min(x0, x1) - half,
      Math.min(y0, y1) - half,
      Math.max(x0, x1) + half,
      Math.max(y0, y1) + half,
      false,
    );
    if (!bounds) return;
    for (let py = bounds.top; py < bounds.bottom; py += 1) {
      const sampleY = py + 0.5 - y0;
      for (let px = bounds.left; px < bounds.right; px += 1) {
        const sampleX = px + 0.5 - x0;
        const t =
          lengthSquared > 0
            ? Math.min(1, Math.max(0, (sampleX * dx + sampleY * dy) / lengthSquared))
            : 0;
        const offsetX = sampleX - t * dx;
        const offsetY = sampleY - t * dy;
        if (offsetX * offsetX + offsetY * offsetY <= limit) this.setPixel(px, py, rgb);
      }
    }
  }

  fillEllipse(x: number, y: number, radiusX: number, radiusY: number, rgb: number): void {
    if (!(radiusX > 0) || !(radiusY > 0)) return;
    const bounds = this.bounds(x - radiusX, y - radiusY, x + radiusX, y + radiusY, false);
    if (!bounds) return;
    for (let py = bounds.top; py < bounds.bottom; py += 1) {
      const v = (py + 0.5 - y) / radiusY;
      for (let px = bounds.left; px < bounds.right; px += 1) {
        const u = (px + 0.5 - x) / radiusX;
        if (u * u + v * v <= 1) this.setPixel(px, py, rgb);
      }
    }
  }

  strokeRing(
    x: number,
    y: number,
    inner: number,
    outer: number,
    verticalScale: number,
    rgb: number,
  ): void {
    if (!(outer > 0)) return;
    const bounds = this.bounds(
      x - outer,
      y - outer * verticalScale,
      x + outer,
      y + outer * verticalScale,
      false,
    );
    if (!bounds) return;
    const innerSquared = inner * inner;
    const outerSquared = outer * outer;
    for (let py = bounds.top; py < bounds.bottom; py += 1) {
      const v = (py + 0.5 - y) / verticalScale;
      for (let px = bounds.left; px < bounds.right; px += 1) {
        const u = px + 0.5 - x;
        const distance = u * u + v * v;
        if (distance <= outerSquared && distance >= innerSquared) this.setPixel(px, py, rgb);
      }
    }
  }

  drawText(
    text: string,
    left: number,
    top: number,
    scale: number,
    rgb: number,
    outline?: number,
  ): void {
    if (outline !== undefined) {
      forEachTextPixel(text, left, top, scale, (x, y) =>
        this.fillRect(x - scale, y - scale, scale * 3, scale * 3, outline),
      );
    }
    forEachTextPixel(text, left, top, scale, (x, y) => this.fillRect(x, y, scale, scale, rgb));
  }

  private bounds(
    left: number,
    top: number,
    right: number,
    bottom: number,
    exclusive: boolean,
  ): { left: number; top: number; right: number; bottom: number } | null {
    if (![left, top, right, bottom].every(Number.isFinite)) return null;
    const clip = this.clipRect;
    const minimumX = Math.max(clip.left, Math.floor(left));
    const minimumY = Math.max(clip.top, Math.floor(top));
    const maximumX = Math.min(clip.right, exclusive ? Math.ceil(right) : Math.floor(right) + 1);
    const maximumY = Math.min(clip.bottom, exclusive ? Math.ceil(bottom) : Math.floor(bottom) + 1);
    if (minimumX >= maximumX || minimumY >= maximumY) return null;
    this.work += (maximumX - minimumX) * (maximumY - minimumY);
    if (this.work > pictureMaximumShapeWork) {
      throw new PictureError('too-large', 'the picture needs more drawing work than allowed');
    }
    return { left: minimumX, top: minimumY, right: maximumX, bottom: maximumY };
  }
}
