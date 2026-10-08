import type { WindowBounds, WindowDisplayFingerprint } from '../shared/api';

export interface PlacementDisplay {
  id: number;
  bounds: WindowBounds;
  workArea: WindowBounds;
  scaleFactor: number;
}

export interface RememberedWindowPlacement {
  bounds: WindowBounds | null;
  maximized: boolean;
  display: WindowDisplayFingerprint | null;
}

export type WindowDisplayOverride =
  | { kind: 'index'; index: number }
  | { kind: 'primary' }
  | { kind: 'secondary' }
  | { kind: 'cursor' }
  | { kind: 'away' };

export interface WindowPlacementDefaults {
  width: number;
  height: number;
  minimumWidth: number;
  minimumHeight: number;
}

export interface WindowPlacementInput {
  remembered: unknown;
  displays: readonly PlacementDisplay[];
  primaryDisplayId: number;
  cursorDisplayId: number | null;
  override: WindowDisplayOverride | null;
  defaults: WindowPlacementDefaults;
}

export type WindowPlacementSource =
  'default' | 'override' | 'remembered-display' | 'fallback-display';

export interface WindowPlacement {
  bounds: WindowBounds | null;
  displayId: number | null;
  maximized: boolean;
  source: WindowPlacementSource;
}

const maximumCoordinate = 100_000;
const maximumExtent = 131_072;
const maximumOverrideIndex = 63;

export function resolveWindowPlacement(input: WindowPlacementInput): WindowPlacement {
  const remembered = parseRememberedWindowPlacement(input.remembered);
  const maximized = remembered?.maximized ?? false;
  const displays = input.displays.filter(isUsableDisplay);
  const defaultPlacement: WindowPlacement = {
    bounds: null,
    displayId: null,
    maximized,
    source: 'default',
  };
  if (displays.length === 0) return defaultPlacement;

  const overrideDisplay = resolveOverrideDisplay(input, displays);
  if (!remembered?.bounds) {
    if (!overrideDisplay) return defaultPlacement;
    return {
      bounds: centeredBounds(input.defaults.width, input.defaults.height, overrideDisplay, input),
      displayId: overrideDisplay.id,
      maximized,
      source: 'override',
    };
  }

  const rememberedDisplay = findRememberedDisplay(remembered.bounds, remembered.display, displays);
  if (rememberedDisplay) {
    return {
      bounds: clampIntoWorkArea(remembered.bounds, rememberedDisplay, input.defaults),
      displayId: rememberedDisplay.id,
      maximized,
      source: 'remembered-display',
    };
  }

  const target =
    overrideDisplay ??
    displays.find((display) => display.id === input.primaryDisplayId) ??
    orderedDisplays(displays)[0]!;
  return {
    bounds: centeredBounds(remembered.bounds.width, remembered.bounds.height, target, input),
    displayId: target.id,
    maximized,
    source: 'fallback-display',
  };
}

export function parseWindowDisplayOverride(
  value: string | undefined,
): WindowDisplayOverride | null {
  const text = value?.trim().toLowerCase();
  if (!text) return null;
  if (text === 'primary') return { kind: 'primary' };
  if (text === 'secondary') return { kind: 'secondary' };
  if (text === 'cursor') return { kind: 'cursor' };
  if (text === 'away') return { kind: 'away' };
  if (!/^\d{1,2}$/u.test(text)) return null;
  const index = Number(text);
  return index <= maximumOverrideIndex ? { kind: 'index', index } : null;
}

export function orderedDisplays(displays: readonly PlacementDisplay[]): PlacementDisplay[] {
  return [...displays].sort(
    (left, right) =>
      left.bounds.x - right.bounds.x || left.bounds.y - right.bounds.y || left.id - right.id,
  );
}

export function displayFingerprint(display: PlacementDisplay): WindowDisplayFingerprint | null {
  return parseWindowDisplayFingerprint({
    version: 1,
    id: display.id,
    bounds: roundedBounds(display.bounds),
    scaleFactor: display.scaleFactor,
  });
}

export function parseRememberedWindowPlacement(value: unknown): RememberedWindowPlacement | null {
  if (!isRecord(value) || typeof value.maximized !== 'boolean') return null;
  const bounds = value.bounds === null ? null : parseBounds(value.bounds);
  if (bounds === undefined) return null;
  return {
    bounds,
    maximized: value.maximized,
    display: parseWindowDisplayFingerprint(value.display),
  };
}

export function parseWindowDisplayFingerprint(value: unknown): WindowDisplayFingerprint | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (!Number.isSafeInteger(value.id)) return null;
  const bounds = parseBounds(value.bounds);
  const scaleFactor = value.scaleFactor;
  if (!bounds || typeof scaleFactor !== 'number' || !Number.isFinite(scaleFactor)) return null;
  if (scaleFactor < 0.25 || scaleFactor > 16) return null;
  return { version: 1, id: value.id as number, bounds, scaleFactor };
}

function findRememberedDisplay(
  bounds: WindowBounds,
  fingerprint: WindowDisplayFingerprint | null,
  displays: readonly PlacementDisplay[],
): PlacementDisplay | null {
  if (fingerprint) {
    const byId = displays.find((display) => display.id === fingerprint.id);
    if (byId) return byId;
    const byBounds = orderedDisplays(displays).find((display) =>
      sameBounds(roundedBounds(display.bounds), fingerprint.bounds),
    );
    return byBounds ?? null;
  }
  let best: PlacementDisplay | null = null;
  let bestArea = 0;
  for (const display of orderedDisplays(displays)) {
    const area = intersectionArea(bounds, display.workArea);
    if (area > bestArea) {
      best = display;
      bestArea = area;
    }
  }
  return best;
}

function resolveOverrideDisplay(
  input: WindowPlacementInput,
  displays: readonly PlacementDisplay[],
): PlacementDisplay | null {
  const override = input.override;
  if (!override) return null;
  if (override.kind === 'index') return orderedDisplays(displays)[override.index] ?? null;
  if (override.kind === 'secondary') {
    const ordered = orderedDisplays(displays);
    return (
      ordered.find((display) => display.id !== input.primaryDisplayId) ??
      ordered.find((display) => display.id === input.primaryDisplayId) ??
      null
    );
  }
  if (override.kind === 'away') {
    const ordered = orderedDisplays(displays);
    return (
      ordered.find((display) => display.id !== input.cursorDisplayId) ??
      ordered.find((display) => display.id === input.cursorDisplayId) ??
      null
    );
  }
  const id = override.kind === 'primary' ? input.primaryDisplayId : input.cursorDisplayId;
  return displays.find((display) => display.id === id) ?? null;
}

function clampIntoWorkArea(
  bounds: WindowBounds,
  display: PlacementDisplay,
  defaults: WindowPlacementDefaults,
): WindowBounds {
  const area = roundedBounds(display.workArea);
  const width = clampExtent(bounds.width, defaults.minimumWidth, area.width);
  const height = clampExtent(bounds.height, defaults.minimumHeight, area.height);
  return {
    x: clamp(bounds.x, area.x, area.x + area.width - width),
    y: clamp(bounds.y, area.y, area.y + area.height - height),
    width,
    height,
  };
}

function centeredBounds(
  width: number,
  height: number,
  display: PlacementDisplay,
  input: WindowPlacementInput,
): WindowBounds {
  const area = roundedBounds(display.workArea);
  const clampedWidth = clampExtent(width, input.defaults.minimumWidth, area.width);
  const clampedHeight = clampExtent(height, input.defaults.minimumHeight, area.height);
  return {
    x: area.x + Math.floor((area.width - clampedWidth) / 2),
    y: area.y + Math.floor((area.height - clampedHeight) / 2),
    width: clampedWidth,
    height: clampedHeight,
  };
}

function clampExtent(value: number, minimum: number, available: number): number {
  return Math.max(1, Math.min(Math.max(Math.round(value), minimum), available));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function intersectionArea(left: WindowBounds, right: WindowBounds): number {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function isUsableDisplay(display: PlacementDisplay): boolean {
  return (
    Number.isSafeInteger(display.id) &&
    parseBounds(roundedBounds(display.bounds)) !== undefined &&
    parseBounds(roundedBounds(display.workArea)) !== undefined
  );
}

function parseBounds(value: unknown): WindowBounds | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  const coordinate = (entry: unknown) =>
    Number.isInteger(entry) && Math.abs(entry as number) <= maximumCoordinate;
  const extent = (entry: unknown) =>
    Number.isInteger(entry) && (entry as number) >= 1 && (entry as number) <= maximumExtent;
  if (!coordinate(x) || !coordinate(y) || !extent(width) || !extent(height)) return undefined;
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

function roundedBounds(bounds: WindowBounds): WindowBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

function sameBounds(left: WindowBounds, right: WindowBounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
