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

export async function withNativeDialog<T>(
  window: DialogWindow,
  show: () => Promise<T>,
  cursorPosition: () => Point,
): Promise<T> {
  try {
    return await show();
  } finally {
    if (!window.isDestroyed() && !window.webContents.isDestroyed() && window.isFocused()) {
      window.webContents.sendInputEvent({
        type: 'mouseMove',
        ...dialogPointerPosition(cursorPosition(), window.getContentBounds()),
      });
    }
  }
}
