export type OverflowPosition = 'start' | 'moving' | 'end' | 'returning';

export type OverflowEvent =
  | { type: 'enter'; distance: number }
  | { type: 'leave'; offset: number }
  | { type: 'arrived' }
  | { type: 'returned' }
  | { type: 'measured'; distance: number };

export const overflowLabelScrollPixelsPerSecond = 24;

const restingOffsetPixels = 0.5;

export function nextOverflowPosition(
  position: OverflowPosition,
  event: OverflowEvent,
): OverflowPosition {
  switch (event.type) {
    case 'enter':
      if (event.distance <= 0) return 'start';
      return position === 'end' ? 'end' : 'moving';
    case 'leave':
      if (position === 'start' || position === 'returning') return position;
      return event.offset > restingOffsetPixels ? 'returning' : 'start';
    case 'arrived':
      return position === 'moving' ? 'end' : position;
    case 'returned':
      return position === 'returning' ? 'start' : position;
    case 'measured':
      return event.distance <= 0 ? 'start' : position;
  }
}

export function overflowForwardSeconds(distance: number, offset: number): number {
  return Math.max(0, distance - offset) / overflowLabelScrollPixelsPerSecond;
}

export function overflowReturnSeconds(offset: number): number {
  return Math.min(0.3, 0.12 + Math.max(0, offset) / 400);
}
