import type { PreviewGenerationResult } from '../shared/api';
import {
  defaultStartVisionSlots,
  startVisionGaiaSlot,
  startVisionMaximumSlot,
} from '../shared/start-vision';
import type { PreviewMapOrigin } from './map-test-preview';

export function startVisionPlayerSlots(playerColorIds: readonly number[]): number[] {
  const players: number[] = [];
  for (let slot = 1; slot <= startVisionMaximumSlot; slot += 1) {
    const colorId = playerColorIds[slot];
    if (colorId !== undefined && Number.isInteger(colorId) && colorId >= 0) players.push(slot);
  }
  return players;
}

export function startVisionMenuSlots(players: readonly number[]): number[] {
  return [...players.filter((slot) => slot !== startVisionGaiaSlot), startVisionGaiaSlot];
}

export function shownStartVisionSlots(
  remembered: readonly number[],
  entries: readonly number[],
): number[] {
  const kept = entries.filter((slot) => remembered.includes(slot));
  if (kept.length > 0) return kept;
  const fallback = defaultStartVisionSlots.filter((slot) => entries.includes(slot));
  if (fallback.length > 0) return fallback;
  return entries.length > 0 ? [entries[0]!] : [];
}

export interface StartVisionCheckChange {
  enabled: boolean;
  slots: number[];
}

export function changeStartVisionCheck(
  checked: readonly number[],
  slot: number,
  on: boolean,
  entries: readonly number[],
): StartVisionCheckChange {
  const next = on
    ? entries.filter((entry) => entry === slot || checked.includes(entry))
    : entries.filter((entry) => entry !== slot && checked.includes(entry));
  if (next.length === 0) return { enabled: false, slots: [...checked] };
  return { enabled: true, slots: next };
}

export function startVisionOwnerBits(slots: readonly number[]): number {
  let bits = 0;
  for (const slot of slots) {
    if (Number.isInteger(slot) && slot >= startVisionGaiaSlot && slot <= startVisionMaximumSlot) {
      bits |= 1 << slot;
    }
  }
  return bits;
}

export function startVisionFogTiles(
  column: Uint8Array,
  width: number,
  height: number,
  slots: readonly number[],
): Uint8Array | null {
  const tiles = width * height;
  if (!Number.isInteger(tiles) || tiles <= 0 || column.length !== tiles * 2) return null;
  const bits = startVisionOwnerBits(slots);
  const fog = new Uint8Array(tiles);
  for (let tile = 0; tile < tiles; tile += 1) {
    const seen = column[tile * 2]! | (column[tile * 2 + 1]! << 8);
    fog[tile] = (seen & bits) === 0 ? 1 : 0;
  }
  return fog;
}

export function startVisionAvailable(
  map: Pick<PreviewGenerationResult, 'backend' | 'width' | 'height' | 'startVisionLe'> | null,
  origin: PreviewMapOrigin,
): boolean {
  if (!map || origin !== 'generation' || map.backend === 'synthetic') return false;
  const column = map.startVisionLe;
  return column instanceof Uint8Array && column.length === map.width * map.height * 2;
}
