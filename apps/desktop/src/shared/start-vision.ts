export const startVisionGaiaSlot = 0;
export const startVisionMaximumSlot = 8;

export const defaultStartVisionSlots: readonly number[] = Object.freeze([1]);

export const startVisionFogPercent = Object.freeze({
  minimum: 0,
  maximum: 100,
  step: 5,
  default: 60,
});

export function clampStartVisionFogPercent(value: number): number {
  const { minimum, maximum, step } = startVisionFogPercent;
  if (!Number.isFinite(value)) return startVisionFogPercent.default;
  return Math.min(maximum, Math.max(minimum, Math.round(value / step) * step));
}

export function isStartVisionSlotList(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length > startVisionMaximumSlot + 1) return false;
  const seen = new Set<number>();
  for (const slot of value) {
    if (
      !Number.isInteger(slot) ||
      (slot as number) < startVisionGaiaSlot ||
      (slot as number) > startVisionMaximumSlot ||
      seen.has(slot as number)
    ) {
      return false;
    }
    seen.add(slot as number);
  }
  return true;
}
