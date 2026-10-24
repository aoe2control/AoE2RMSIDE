import type { PreviewGenerationResult } from '../../shared/api';
import type { PictureMap } from '../pictures/picture-map';

export const shownPreviewMapCapacity = 2;

interface Entry {
  requestHash: string;
  result: PreviewGenerationResult | null;
  picture: PictureMap | null;
}

export class ShownPreviewMaps {
  private entries: Entry[] = [];

  constructor(
    private readonly toPicture: (result: PreviewGenerationResult) => PictureMap,
    private readonly capacity = shownPreviewMapCapacity,
  ) {}

  remember(result: PreviewGenerationResult): void {
    if (result.backend !== 'exact' || typeof result.requestHash !== 'string') return;
    this.entries = this.entries.filter((entry) => entry.requestHash !== result.requestHash);
    this.entries.push({ requestHash: result.requestHash, result, picture: null });
    while (this.entries.length > this.capacity) this.entries.shift();
  }

  picture(requestHash: string): PictureMap | undefined {
    const entry = this.entries.find((candidate) => candidate.requestHash === requestHash);
    if (!entry) return undefined;
    if (!entry.picture) {
      entry.picture = this.toPicture(entry.result!);
      entry.result = null;
    }
    return entry.picture;
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }
}
