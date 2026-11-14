export const tileGridOpacityPercent = Object.freeze({
  minimum: 10,
  maximum: 100,
  step: 5,
  default: 100,
});

export function clampTileGridOpacityPercent(value: number): number {
  const { minimum, maximum, step } = tileGridOpacityPercent;
  if (!Number.isFinite(value)) return tileGridOpacityPercent.default;
  return Math.min(maximum, Math.max(minimum, Math.round(value / step) * step));
}
