import { useRef, type MouseEvent as ReactMouseEvent } from 'react';

export const plainClickDragThreshold = 4;

export interface ClickPoint {
  x: number;
  y: number;
}

export function clickEndsSelection(
  press: ClickPoint | null,
  click: ClickPoint & { shiftKey: boolean },
  selectedText: string,
): boolean {
  if (selectedText.length === 0) return false;
  if (click.shiftKey) return true;
  if (!press) return false;
  return Math.hypot(click.x - press.x, click.y - press.y) > plainClickDragThreshold;
}

export function preventMultiClickSelection(event: ReactMouseEvent<HTMLElement>): void {
  if (event.button === 0 && event.detail > 1) event.preventDefault();
}

export interface PlainClickHandlers {
  onClick(event: ReactMouseEvent<HTMLElement>): void;
  onMouseDown(event: ReactMouseEvent<HTMLElement>): void;
}

function documentSelectionText(): string {
  return window.getSelection()?.toString() ?? '';
}

export function plainClickHandlers(
  action: () => void,
  press: { current: ClickPoint | null },
  selectedText: () => string = documentSelectionText,
): PlainClickHandlers {
  return {
    onMouseDown(event) {
      press.current = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    },
    onClick(event) {
      const start = press.current;
      press.current = null;
      if ((event.target as Element).closest('button')) return;
      const click = { x: event.clientX, y: event.clientY, shiftKey: event.shiftKey };
      if (clickEndsSelection(start, click, selectedText())) return;
      action();
    },
  };
}

export function usePlainClick(action: () => void): PlainClickHandlers {
  const press = useRef<ClickPoint | null>(null);
  return plainClickHandlers(action, press);
}
