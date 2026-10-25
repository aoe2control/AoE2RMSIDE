import type { BrowserWindow, Point, Rectangle } from 'electron';

type DialogWindow = Pick<BrowserWindow, 'isDestroyed' | 'isFocused' | 'getContentBounds'> & {
  webContents: Pick<BrowserWindow['webContents'], 'isDestroyed' | 'sendInputEvent'>;
};

export function dialogPointerPosition(cursor: Point, content: Rectangle): Point {
  const x = cursor.x - content.x;
  const y = cursor.y - content.y;
  if (x < 0 || y < 0 || x >= content.width || y >= content.height) return { x: -1, y: -1 };
  return { x: Math.round(x), y: Math.round(y) };
}

export function reconcilePointerHover(window: DialogWindow, cursorPosition: () => Point): void {
  if (window.isDestroyed() || window.webContents.isDestroyed() || !window.isFocused()) return;
  window.webContents.sendInputEvent({
    type: 'mouseMove',
    ...dialogPointerPosition(cursorPosition(), window.getContentBounds()),
  });
}

let nativeDialogsOpen = 0;

export function nativeDialogOpen(): boolean {
  return nativeDialogsOpen > 0;
}

export async function withNativeDialog<T>(
  window: DialogWindow,
  show: () => Promise<T>,
  cursorPosition: () => Point,
): Promise<T> {
  nativeDialogsOpen += 1;
  try {
    return await show();
  } finally {
    nativeDialogsOpen -= 1;
    reconcilePointerHover(window, cursorPosition);
  }
}
