export const autoSaveDelayTenths = Object.freeze({
  minimum: 0,
  maximum: 50,
  step: 1,
  default: 10,
});

export function clampAutoSaveDelayTenths(value: number): number {
  const { minimum, maximum } = autoSaveDelayTenths;
  if (!Number.isFinite(value)) return autoSaveDelayTenths.default;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function autoSaveDelayMilliseconds(tenths: number): number {
  return clampAutoSaveDelayTenths(tenths) * 100;
}
