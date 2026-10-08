import {
  mapToScreen,
  panPreviewCamera,
  selectionTileCount,
  type MapPoint,
  type PreviewCamera,
  type PreviewSelection,
  type PreviewViewport,
} from './top-down-preview';
import { t } from '../shared/i18n/translator';

export type PreviewKeyboardCommand =
  | { kind: 'select-all' }
  | { kind: 'clear' }
  | { kind: 'fit' }
  | { kind: 'zoom'; factor: number }
  | { kind: 'pan'; screenX: number; screenY: number }
  | { kind: 'move'; x: number; y: number; extend: boolean };

export interface PreviewKeyboardInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function previewKeyboardHelp(): string {
  return t('preview-panel.keyboard.help');
}

export const previewKeyboardShortcuts =
  'ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft ' +
  'Shift+ArrowRight Control+ArrowUp Control+ArrowDown Control+ArrowLeft Control+ArrowRight ' +
  'Plus Minus 0 Home Control+A Escape';

const arrowDirections: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export function previewKeyboardCommand(input: PreviewKeyboardInput): PreviewKeyboardCommand | null {
  const control = input.ctrlKey || input.metaKey;
  if (input.altKey) return null;
  if (control && input.key.toLowerCase() === 'a') return { kind: 'select-all' };
  const direction = arrowDirections[input.key];
  if (direction) {
    if (control) {
      if (input.shiftKey) return null;
      return { kind: 'pan', screenX: direction[0], screenY: direction[1] };
    }
    return { kind: 'move', x: direction[0], y: direction[1], extend: input.shiftKey };
  }
  if (control) return null;
  if (input.key === 'Escape') return { kind: 'clear' };
  if (input.key === '0' || input.key === 'Home') return { kind: 'fit' };
  if (input.key === '+' || input.key === '=') return { kind: 'zoom', factor: 1.25 };
  if (input.key === '-' || input.key === '_') return { kind: 'zoom', factor: 0.8 };
  return null;
}

export interface PreviewKeyboardCursor {
  cursor: MapPoint;
  anchor: MapPoint;
}

export function keyboardCursorFor(
  selection: PreviewSelection | null,
  mapWidth: number,
  mapHeight: number,
): PreviewKeyboardCursor {
  if (!selection) {
    const center = { x: Math.floor(mapWidth / 2), y: Math.floor(mapHeight / 2) };
    return { anchor: center, cursor: center };
  }
  return {
    anchor: { x: selection.minimumX, y: selection.minimumY },
    cursor: { x: selection.maximumX, y: selection.maximumY },
  };
}

export function moveKeyboardSelection(
  state: PreviewKeyboardCursor,
  hadSelection: boolean,
  move: { x: number; y: number; extend: boolean },
  mapWidth: number,
  mapHeight: number,
): { state: PreviewKeyboardCursor; selection: PreviewSelection } {
  const step = hadSelection ? 1 : 0;
  const cursor = {
    x: clampTile(state.cursor.x + move.x * step, mapWidth),
    y: clampTile(state.cursor.y + move.y * step, mapHeight),
  };
  const anchor = move.extend && hadSelection ? state.anchor : cursor;
  return {
    state: { anchor, cursor },
    selection: {
      minimumX: Math.min(anchor.x, cursor.x),
      maximumX: Math.max(anchor.x, cursor.x),
      minimumY: Math.min(anchor.y, cursor.y),
      maximumY: Math.max(anchor.y, cursor.y),
    },
  };
}

export function keyboardPanStep(viewport: PreviewViewport): { x: number; y: number } {
  return {
    x: Math.max(24, Math.round(viewport.width / 8)),
    y: Math.max(24, Math.round(viewport.height / 8)),
  };
}

export function panCameraByKeyboard(
  camera: PreviewCamera,
  direction: { screenX: number; screenY: number },
  mapWidth: number,
  mapHeight: number,
  viewport: PreviewViewport,
): PreviewCamera {
  const step = keyboardPanStep(viewport);
  return panPreviewCamera(
    camera,
    -direction.screenX * step.x,
    -direction.screenY * step.y,
    mapWidth,
    mapHeight,
    viewport,
  );
}

export function cameraRevealingTile(
  camera: PreviewCamera,
  tile: MapPoint,
  mapWidth: number,
  mapHeight: number,
  viewport: PreviewViewport,
  margin = 32,
): PreviewCamera | null {
  const point = mapToScreen(
    { x: tile.x + 0.5, y: tile.y + 0.5 },
    mapWidth,
    mapHeight,
    camera,
    viewport,
  );
  const insetX = Math.min(margin, viewport.width / 2);
  const insetY = Math.min(margin, viewport.height / 2);
  const targetX = Math.min(viewport.width - insetX, Math.max(insetX, point.x));
  const targetY = Math.min(viewport.height - insetY, Math.max(insetY, point.y));
  if (Math.abs(targetX - point.x) < 0.5 && Math.abs(targetY - point.y) < 0.5) return null;
  const next = panPreviewCamera(
    camera,
    targetX - point.x,
    targetY - point.y,
    mapWidth,
    mapHeight,
    viewport,
  );
  const moved =
    Math.abs(next.centerX - camera.centerX) > 1e-6 ||
    Math.abs(next.centerY - camera.centerY) > 1e-6;
  return moved ? next : null;
}

export function describePreviewSelection(
  selection: PreviewSelection | null,
  layers: readonly { description: string; count: number }[] | null,
): string {
  if (!selection) return t('preview-panel.selection.announce.cleared');
  const single =
    selection.minimumX === selection.maximumX && selection.minimumY === selection.maximumY;
  const area = single
    ? t('preview-panel.selection.announce.tile', { x: selection.minimumX, y: selection.minimumY })
    : t('preview-panel.selection.announce.tiles', {
        fromX: selection.minimumX,
        fromY: selection.minimumY,
        toX: selection.maximumX,
        toY: selection.maximumY,
        count: selectionTileCount(selection),
      });
  if (!layers) return area;
  if (layers.length === 0) return t('preview-panel.selection.announce.no-layers', { area });
  const shown = layers
    .slice(0, 3)
    .map((layer) =>
      t('preview-panel.selection.announce.layer', { name: layer.description, count: layer.count }),
    );
  return layers.length > 3
    ? t('preview-panel.selection.announce.layers-more', {
        area,
        count: layers.length,
        shown,
        more: layers.length - 3,
      })
    : t('preview-panel.selection.announce.layers', { area, count: layers.length, shown });
}

function clampTile(value: number, size: number): number {
  return Math.min(Math.max(0, size - 1), Math.max(0, value));
}
