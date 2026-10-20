import { useCallback, useEffect, useRef, useState } from 'react';

export interface HandoffRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface HandoffPoint {
  readonly x: number;
  readonly y: number;
}

export type EditorListHandoffPhase = 'idle' | 'travelling' | 'on-list';

export function insideHandoffBand(point: HandoffPoint, list: HandoffRect): boolean {
  return point.y >= list.top && point.y <= list.bottom;
}

function insideRect(point: HandoffPoint, rect: HandoffRect): boolean {
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  );
}

export function startsEditorListHandoff(options: {
  readonly point: HandoffPoint;
  readonly buttons: number;
  readonly code: HandoffRect;
  readonly list: HandoffRect | null;
}): boolean {
  const { point, buttons, code, list } = options;
  if (!list || buttons !== 0) return false;
  if (list.left < code.right - 1) return false;
  if (point.x < code.right - 1) return false;
  return insideHandoffBand(point, list) && point.x <= list.right;
}

export function nextEditorListHandoffPhase(
  phase: EditorListHandoffPhase,
  point: HandoffPoint,
  list: HandoffRect | null,
): EditorListHandoffPhase {
  if (phase === 'idle' || !list) return 'idle';
  if (!insideHandoffBand(point, list)) return 'idle';
  if (insideRect(point, list)) return 'on-list';
  return point.x < list.left ? 'travelling' : 'idle';
}

export function shownCodeHighlightTiles<T>(
  code: readonly T[],
  hoveredEntry: readonly T[],
  listsCode: boolean,
  none: readonly T[],
): readonly T[] {
  return listsCode && hoveredEntry.length > 0 ? none : code;
}

export function editorPopulatedListRect(root: ParentNode = document): HandoffRect | null {
  const list = root.querySelector<HTMLElement>(
    '.preview-map-legend[data-legend-content="source-highlight"]:not([data-ending-style])',
  );
  if (!list) return null;
  const box = list.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
}

export interface EditorPointerLeave {
  readonly clientX: number;
  readonly clientY: number;
  readonly buttons: number;
  readonly code: HandoffRect;
}

export function useEditorListHandoff<T>(
  live: readonly T[],
  none: readonly T[],
  resetKey: unknown,
): {
  readonly operations: readonly T[];
  readonly phase: EditorListHandoffPhase;
  readonly setPointerInside: (inside: boolean, leave?: EditorPointerLeave) => void;
} {
  const [pointerInside, setPointerInsideState] = useState(false);
  const [handoff, setHandoff] = useState<{
    readonly phase: EditorListHandoffPhase;
    readonly operations: readonly T[];
  }>({ phase: 'idle', operations: none });
  const liveRef = useRef(live);
  liveRef.current = live;
  const phaseRef = useRef<EditorListHandoffPhase>('idle');
  phaseRef.current = handoff.phase;

  const end = useCallback(() => {
    if (phaseRef.current === 'idle') return;
    phaseRef.current = 'idle';
    setHandoff({ phase: 'idle', operations: none });
  }, [none]);

  const setPointerInside = useCallback(
    (inside: boolean, leave?: EditorPointerLeave) => {
      setPointerInsideState(inside);
      if (inside || !leave) {
        end();
        return;
      }
      const operations = liveRef.current;
      const starts =
        operations.length > 0 &&
        startsEditorListHandoff({
          point: { x: leave.clientX, y: leave.clientY },
          buttons: leave.buttons,
          code: leave.code,
          list: editorPopulatedListRect(),
        });
      if (!starts) {
        end();
        return;
      }
      phaseRef.current = 'travelling';
      setHandoff({ phase: 'travelling', operations });
    },
    [end],
  );

  const active = handoff.phase !== 'idle';
  useEffect(() => {
    if (!active) return undefined;
    const move = (event: PointerEvent) => {
      const next = nextEditorListHandoffPhase(
        phaseRef.current,
        { x: event.clientX, y: event.clientY },
        editorPopulatedListRect(),
      );
      if (next === phaseRef.current) return;
      if (next === 'idle') {
        end();
        return;
      }
      phaseRef.current = next;
      setHandoff((current) => ({ ...current, phase: next }));
    };
    const press = (event: PointerEvent) => {
      const list = editorPopulatedListRect();
      if (!list || !insideRect({ x: event.clientX, y: event.clientY }, list)) end();
    };
    const out = (event: PointerEvent) => {
      if (event.relatedTarget === null) end();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerdown', press, true);
    document.addEventListener('pointerout', out);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerdown', press, true);
      document.removeEventListener('pointerout', out);
      window.removeEventListener('blur', end);
    };
  }, [active, end]);

  const shownResetKey = useRef(resetKey);
  useEffect(() => {
    if (shownResetKey.current === resetKey) return;
    shownResetKey.current = resetKey;
    end();
  }, [end, resetKey]);

  return {
    operations: pointerInside ? live : active ? handoff.operations : none,
    phase: handoff.phase,
    setPointerInside,
  };
}
