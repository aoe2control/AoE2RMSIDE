import type { EditionCapabilities } from './edition';

export const tourCardIds = ['explorer', 'editor', 'run', 'preview', 'output'] as const;
export type TourCardId = (typeof tourCardIds)[number];

export type TourProgress = { status: 'active'; card: TourCardId } | { status: 'done' };

export const initialTourProgress: TourProgress = Object.freeze({
  status: 'active',
  card: 'explorer',
});

export const doneTourProgress: TourProgress = Object.freeze({ status: 'done' });

export const tourRecordFileName = 'app-tour-v1.json';
export const tourRecordVersion = 1;
export const tourRecordMaximumBytes = 1024;

export type TourRecord =
  { version: 1; status: 'active'; card: TourCardId } | { version: 1; status: 'done' };

export function isTourCardId(value: unknown): value is TourCardId {
  return typeof value === 'string' && (tourCardIds as readonly string[]).includes(value);
}

export function parseTourRecord(value: unknown): TourProgress {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return doneTourProgress;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== tourRecordVersion) return doneTourProgress;
  if (record.status === 'active' && isTourCardId(record.card)) {
    return { status: 'active', card: record.card };
  }
  return doneTourProgress;
}

export function tourRecordFor(progress: TourProgress): TourRecord {
  return progress.status === 'active'
    ? { version: tourRecordVersion, status: 'active', card: progress.card }
    : { version: tourRecordVersion, status: 'done' };
}

export function validateTourProgress(value: unknown): TourProgress {
  if (typeof value !== 'object' || value === null) throw new Error('tour progress is invalid');
  const progress = value as Record<string, unknown>;
  if (progress.status === 'done' && Object.keys(progress).length === 1) return doneTourProgress;
  if (
    progress.status === 'active' &&
    isTourCardId(progress.card) &&
    Object.keys(progress).length === 2
  ) {
    return { status: 'active', card: progress.card };
  }
  throw new Error('tour progress is invalid');
}

export function tourCardsFor(
  capabilities: Pick<EditionCapabilities, 'preview'>,
): readonly TourCardId[] {
  return capabilities.preview ? tourCardIds : ['explorer', 'editor'];
}

export function tourStep(
  card: TourCardId,
  cards: readonly TourCardId[],
): { step: number; total: number } {
  return { step: cards.indexOf(card) + 1, total: cards.length };
}

export function normalizeTourProgress(
  progress: TourProgress,
  cards: readonly TourCardId[],
): TourProgress {
  if (progress.status === 'done') return progress;
  if (cards.includes(progress.card)) return progress;
  const from = tourCardIds.indexOf(progress.card);
  const next = tourCardIds.slice(from + 1).find((card) => cards.includes(card));
  return next ? { status: 'active', card: next } : doneTourProgress;
}

export function advanceTour(progress: TourProgress, cards: readonly TourCardId[]): TourProgress {
  if (progress.status === 'done') return progress;
  const index = cards.indexOf(progress.card);
  const next = index < 0 ? undefined : cards[index + 1];
  return next ? { status: 'active', card: next } : doneTourProgress;
}

export function skipTour(): TourProgress {
  return doneTourProgress;
}

export function restartTour(cards: readonly TourCardId[]): TourProgress {
  const first = cards[0];
  return first ? { status: 'active', card: first } : doneTourProgress;
}

export type TourTargetState = 'shown' | 'hidden' | 'absent';

export interface TourMoment {
  idleMilliseconds: number;
  surfaceOpen: boolean;
  runActive: boolean;
  target: TourTargetState;
  previewReady: boolean;
}

export const tourSettleMilliseconds = 600;

export type TourDecision = 'show' | 'wait' | 'skip';

export function tourCardDecision(card: TourCardId, moment: TourMoment): TourDecision {
  if (moment.target === 'absent') return 'skip';
  if (moment.surfaceOpen || moment.target === 'hidden') return 'wait';
  if ((card === 'run' || card === 'preview') && moment.runActive) return 'wait';
  if (card === 'preview' && !moment.previewReady) return 'wait';
  if (moment.idleMilliseconds < tourSettleMilliseconds) return 'wait';
  return 'show';
}

export type TourTextPart = { kind: 'text'; text: string } | { kind: 'term'; text: string };

export function tourTextParts(text: string): TourTextPart[] {
  const parts: TourTextPart[] = [];
  const pieces = text.split('`');
  const paired = pieces.length % 2 === 1 ? pieces.length : pieces.length - 1;
  pieces.forEach((piece, index) => {
    const term = index % 2 === 1 && index < paired;
    const value = index % 2 === 1 && !term ? `\`${piece}` : piece;
    if (value === '') return;
    const previous = parts.at(-1);
    if (!term && previous?.kind === 'text') previous.text += value;
    else parts.push({ kind: term ? 'term' : 'text', text: value });
  });
  return parts;
}

export interface TourRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type TourCardSide = 'right' | 'left' | 'bottom' | 'top' | 'over';

export const tourSpotlightPadding = 6;
export const tourCardGap = 10;
export const tourViewportMargin = 12;

export function tourSpotlightRect(
  target: TourRect,
  viewport: { width: number; height: number },
): TourRect {
  const left = Math.max(0, target.left - tourSpotlightPadding);
  const top = Math.max(0, target.top - tourSpotlightPadding);
  const right = Math.min(viewport.width, target.left + target.width + tourSpotlightPadding);
  const bottom = Math.min(viewport.height, target.top + target.height + tourSpotlightPadding);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function tourUncoveredRect(spotlight: TourRect, cover: TourRect | null): TourRect {
  if (cover === null || cover.width <= 0 || cover.height <= 0) return spotlight;
  const right = spotlight.left + spotlight.width;
  const bottom = spotlight.top + spotlight.height;
  const coverRight = cover.left + cover.width;
  const coverBottom = cover.top + cover.height;
  if (cover.top >= bottom || coverBottom <= spotlight.top) return spotlight;
  if (coverRight <= spotlight.left || cover.left >= right) return spotlight;
  if (cover.left <= spotlight.left + tourSpotlightPadding) {
    const left = Math.min(right, coverRight);
    return { ...spotlight, left, width: right - left };
  }
  if (coverRight >= right - tourSpotlightPadding) {
    const end = Math.max(spotlight.left, cover.left);
    return { ...spotlight, width: end - spotlight.left };
  }
  return spotlight;
}

function clampInto(value: number, minimum: number, maximum: number): number {
  return maximum < minimum ? minimum : Math.min(maximum, Math.max(minimum, value));
}

export const tourControlClearance = 4;

function coveredControlArea(
  left: number,
  top: number,
  card: { width: number; height: number },
  controls: readonly TourRect[],
): number {
  let area = 0;
  for (const control of controls) {
    const width =
      Math.min(left + card.width, control.left + control.width + tourControlClearance) -
      Math.max(left, control.left - tourControlClearance);
    const height =
      Math.min(top + card.height, control.top + control.height + tourControlClearance) -
      Math.max(top, control.top - tourControlClearance);
    if (width > 0 && height > 0) area += width * height;
  }
  return area;
}

export function tourCardPlacement(
  spotlight: TourRect,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  controls: readonly TourRect[] = [],
): { left: number; top: number; side: TourCardSide; maxHeight?: number } {
  const margin = tourViewportMargin;
  const gap = tourCardGap;
  const right = spotlight.left + spotlight.width;
  const bottom = spotlight.top + spotlight.height;
  const maximumLeft = viewport.width - margin - card.width;
  const maximumTop = viewport.height - margin - card.height;
  const clampLeft = (value: number) => clampInto(value, margin, maximumLeft);
  const clampTop = (value: number) => clampInto(value, margin, maximumTop);
  const alignedTop = clampTop(spotlight.top);
  const alignedLeft = clampLeft(spotlight.left);
  const fitsTall = card.height <= viewport.height - 2 * margin;
  const fitsWide = card.width <= viewport.width - 2 * margin;
  const clearance = tourControlClearance;
  const tops = [
    alignedTop,
    clampTop(bottom - card.height),
    clampTop(spotlight.top + (spotlight.height - card.height) / 2),
    ...controls.flatMap((control) => [
      clampTop(control.top + control.height + clearance),
      clampTop(control.top - clearance - card.height),
    ]),
  ];
  const lefts = [
    alignedLeft,
    clampLeft(right - card.width),
    clampLeft(spotlight.left + (spotlight.width - card.width) / 2),
    ...controls.flatMap((control) => [
      clampLeft(control.left + control.width + clearance),
      clampLeft(control.left - clearance - card.width),
    ]),
  ];
  type Place = { left: number; top: number; side: TourCardSide };
  const sides: Place[][] = [];
  if (fitsTall && right + gap + card.width <= viewport.width - margin) {
    sides.push(tops.map((top) => ({ left: right + gap, top, side: 'right' })));
  }
  if (fitsTall && spotlight.left - gap - card.width >= margin) {
    sides.push(tops.map((top) => ({ left: spotlight.left - gap - card.width, top, side: 'left' })));
  }
  if (fitsWide && bottom + gap + card.height <= viewport.height - margin) {
    sides.push(lefts.map((left) => ({ left, top: bottom + gap, side: 'bottom' })));
  }
  if (fitsWide && spotlight.top - gap - card.height >= margin) {
    sides.push(
      lefts.map((left) => ({ left, top: spotlight.top - gap - card.height, side: 'top' })),
    );
  }
  const overLefts = [clampLeft(spotlight.left + (spotlight.width - card.width) / 2), ...lefts];
  const overTops = [
    clampTop(bottom - gap - card.height),
    clampTop(spotlight.top + (spotlight.height - card.height) / 2),
    clampTop(spotlight.top + gap),
    ...tops.slice(3),
  ];
  const over: Place[] = overTops.flatMap((top) =>
    overLefts.map((left): Place => ({ left, top, side: 'over' })),
  );
  const places: Place[] = [
    ...sides.map((places) => places[0]!),
    ...sides.flatMap((places) => places.slice(1)),
    ...over,
  ];
  for (const place of places) {
    if (coveredControlArea(place.left, place.top, card, controls) === 0) return place;
  }
  let shortened: { place: Place; height: number } | null = null;
  for (const place of places) {
    const height = clearCardHeight(place.left, place.top, card, controls);
    if (height >= tourCardMinimumHeight && (shortened === null || height > shortened.height)) {
      shortened = { place, height };
    }
  }
  if (shortened) return { ...shortened.place, maxHeight: shortened.height };
  let best = places[0]!;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const place of places) {
    const area = coveredControlArea(place.left, place.top, card, controls);
    if (area < bestArea) {
      best = place;
      bestArea = area;
    }
  }
  return best;
}

export const tourCardMinimumHeight = 140;

function clearCardHeight(
  left: number,
  top: number,
  card: { width: number; height: number },
  controls: readonly TourRect[],
): number {
  let height = card.height;
  for (const control of controls) {
    const start = control.left - tourControlClearance;
    const end = control.left + control.width + tourControlClearance;
    if (left >= end || left + card.width <= start) continue;
    const controlTop = control.top - tourControlClearance;
    const controlBottom = control.top + control.height + tourControlClearance;
    if (controlBottom <= top) continue;
    if (controlTop <= top) return 0;
    height = Math.min(height, controlTop - top);
  }
  return height;
}
