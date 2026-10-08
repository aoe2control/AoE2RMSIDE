import { join } from 'node:path';
import type { TerrainMinimapColor } from '../shared/api';

export const localMinimapPaletteRelativePath = join(
  'resources',
  '_common',
  'palettes',
  'original.pal',
);

export const localMinimapPaletteLimits = Object.freeze({
  maximumBytes: 64 * 1024,
  maximumEntries: 4096,
  maximumTerrainId: 255,
});

export interface TerrainMinimapIndices {
  id: number;
  highIndex: number;
  mediumIndex: number;
  lowIndex: number;
}

export function parseJascPalette(bytes: Uint8Array): number[] {
  if (bytes.byteLength > localMinimapPaletteLimits.maximumBytes) {
    throw new Error('palette exceeds its size limit');
  }
  const lines = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString('latin1')
    .split(/\r\n|\r|\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines[0] !== 'JASC-PAL' || lines[1] !== '0100') {
    throw new Error('unsupported palette header');
  }
  const count = Number(lines[2]);
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > localMinimapPaletteLimits.maximumEntries ||
    lines.length !== count + 3
  ) {
    throw new Error('invalid palette size');
  }
  return lines.slice(3).map((line) => {
    const channels = line.split(/\s+/u).slice(0, 3).map(Number);
    if (
      channels.length !== 3 ||
      channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)
    ) {
      throw new Error('invalid palette entry');
    }
    return (channels[0]! << 16) | (channels[1]! << 8) | channels[2]!;
  });
}

export function resolveTerrainMinimapColors(
  indices: readonly TerrainMinimapIndices[],
  palette: readonly number[],
): TerrainMinimapColor[] {
  const colors: TerrainMinimapColor[] = [];
  for (const entry of indices) {
    if (
      !Number.isInteger(entry.id) ||
      entry.id < 0 ||
      entry.id > localMinimapPaletteLimits.maximumTerrainId ||
      (colors.length > 0 && colors.at(-1)!.terrainId >= entry.id)
    ) {
      continue;
    }
    const high = palette[entry.highIndex];
    const medium = palette[entry.mediumIndex];
    const low = palette[entry.lowIndex];
    if (high === undefined || medium === undefined || low === undefined) continue;
    colors.push({ terrainId: entry.id, highColor: high, mediumColor: medium, lowColor: low });
  }
  return colors;
}
