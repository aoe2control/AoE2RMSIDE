import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { motionDuration, motionEasing, prefersReducedMotion } from './motion';
import {
  previewLegendPanelWidth,
  previewReadoutWidth,
  type PreviewLegendTextMetrics,
} from './preview-materials';

export interface OverlayRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function rectContainsPoint(rect: OverlayRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export const previewInformationSelector = '.preview-map-information';

export function useOverlayPointerHover(host: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const container = host.current;
    if (!container) return undefined;
    let over: HTMLElement | null = null;
    const set = (element: HTMLElement | null) => {
      if (over === element) return;
      if (over) delete over.dataset.pointerOver;
      over = element;
      if (over) over.dataset.pointerOver = 'true';
    };
    const update = (event: PointerEvent) => {
      const information = container.querySelector<HTMLElement>(previewInformationSelector);
      if (!information || information.hasAttribute('data-ending-style')) {
        set(null);
        return;
      }
      set(
        rectContainsPoint(information.getBoundingClientRect(), event.clientX, event.clientY)
          ? information
          : null,
      );
    };
    const leave = () => set(null);
    container.addEventListener('pointermove', update, { passive: true });
    container.addEventListener('pointerleave', leave);
    return () => {
      container.removeEventListener('pointermove', update);
      container.removeEventListener('pointerleave', leave);
      set(null);
    };
  }, [host]);
}

export function readoutGlideOffset(
  previousLeft: number,
  currentLeft: number,
  drawnOffset = 0,
): number | null {
  const offset = previousLeft - currentLeft + drawnOffset;
  return Math.abs(offset) < 0.5 ? null : offset;
}

export type ReadoutLabelShift = { kind: 'glide'; offset: number } | { kind: 'place' };

export function readoutLabelShift(
  previousLeft: number,
  currentLeft: number,
  drawnOffset: number,
  layoutDriven = false,
): ReadoutLabelShift | null {
  if (Math.abs(previousLeft - currentLeft) < 0.5) return null;
  const offset = readoutGlideOffset(previousLeft, currentLeft, drawnOffset);
  if (offset === null) return null;
  if (layoutDriven) return { kind: 'place' };
  return offset > 0 ? { kind: 'glide', offset } : { kind: 'place' };
}

export type ReadoutLabelResize = 'grow' | 'collapse';

export function readoutLabelResize(state: {
  appeared: boolean;
  closing: boolean;
  wasClosing: boolean;
  labelToTheRight: boolean;
}): ReadoutLabelResize | null {
  if (!state.labelToTheRight) return null;
  if (state.closing) return state.wasClosing ? null : 'collapse';
  if (state.appeared || state.wasClosing) return 'grow';
  return null;
}

export function readoutResizeDuration(from: number, to: number, fullDuration: number): number {
  return Math.round(fullDuration * Math.min(1, Math.abs(to - from)));
}

export const readoutGlideAnimationId = 'rmside-readout-glide';
export const readoutResizeAnimationId = 'rmside-readout-resize';

function drawnTranslateX(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform;
  if (!transform || transform === 'none') return 0;
  return new DOMMatrixReadOnly(transform).m41;
}

function drawnReveal(element: HTMLElement): number {
  if (!element.dataset.readoutResize) return 1;
  const value = Number.parseFloat(getComputedStyle(element).getPropertyValue('--readout-reveal'));
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

function resizeAnimations(element: HTMLElement): Animation[] {
  return element.getAnimations().filter((animation) => animation.id === readoutResizeAnimationId);
}

function recordNaturalWidth(segment: HTMLElement): void {
  const readout = segment.parentElement;
  const scale =
    readout && readout.offsetWidth > 0
      ? readout.getBoundingClientRect().width / readout.offsetWidth
      : 1;
  const children = [...segment.children];
  const content = children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0);
  const gap = Number.parseFloat(getComputedStyle(segment).columnGap) || 0;
  const width = content / (scale > 0 ? scale : 1) + gap * Math.max(0, children.length - 1);
  segment.style.setProperty('--readout-natural-width', `${width.toFixed(3)}px`);
}

function startReadoutResize(segment: HTMLElement, resize: ReadoutLabelResize): void {
  const target = resize === 'grow' ? 1 : 0;
  const from = segment.dataset.readoutResize ? drawnReveal(segment) : resize === 'grow' ? 0 : 1;
  for (const animation of resizeAnimations(segment)) animation.cancel();
  segment.dataset.readoutResize = resize;
  recordNaturalWidth(segment);
  const duration = readoutResizeDuration(
    from,
    target,
    motionDuration('--motion-duration-readout-resize', 200),
  );
  const animation = segment.animate(
    [{ '--readout-reveal': String(from) }, { '--readout-reveal': String(target) }],
    {
      duration,
      easing: motionEasing('--motion-ease-move', 'cubic-bezier(0.2, 0, 0, 1)'),
      fill: resize === 'collapse' ? 'forwards' : 'none',
    },
  );
  animation.id = readoutResizeAnimationId;
  if (resize === 'grow') {
    animation.onfinish = () => {
      if (segment.dataset.readoutResize === 'grow') {
        delete segment.dataset.readoutResize;
        segment.style.removeProperty('--readout-natural-width');
      }
    };
  }
}

function stopReadoutResize(segment: HTMLElement): void {
  for (const animation of resizeAnimations(segment)) animation.cancel();
  delete segment.dataset.readoutResize;
  segment.style.removeProperty('--readout-natural-width');
}

export function useReadoutLabelGlide(host: RefObject<HTMLElement | null>): void {
  const previous = useRef({
    positions: new Map<string, number>(),
    closing: new Set<string>(),
    resizing: false,
  });
  useLayoutEffect(() => {
    const segments = [
      ...(host.current?.querySelectorAll<HTMLElement>(
        '.preview-map-readout > .preview-map-readout-segment',
      ) ?? []),
    ];
    const before = previous.current;
    const positions = new Map<string, number>();
    const closingKinds = new Set<string>();
    const reduceMotion = prefersReducedMotion();
    const isClosing = (segment: HTMLElement) => segment.hasAttribute('data-ending-style');
    const kindOf = (segment: HTMLElement) => segment.dataset.kind ?? '';
    let layoutDriven = before.resizing;
    let resizing = false;
    segments.forEach((segment, index) => {
      const kind = kindOf(segment);
      const closing = isClosing(segment);
      if (closing) closingKinds.add(kind);
      if (reduceMotion) {
        if (segment.dataset.readoutResize) stopReadoutResize(segment);
      } else {
        const resize = readoutLabelResize({
          appeared: !before.positions.has(kind),
          closing,
          wasClosing: before.closing.has(kind),
          labelToTheRight: segments
            .slice(index + 1)
            .some((label) => !isClosing(label) && before.positions.has(kindOf(label))),
        });
        if (resize) startReadoutResize(segment, resize);
        if (segment.dataset.readoutResize) {
          recordNaturalWidth(segment);
          resizing = true;
        }
      }
      const left = segment.offsetLeft;
      positions.set(kind, left);
      const previousLeft = before.positions.get(kind);
      const drivenHere = layoutDriven;
      if (segment.dataset.readoutResize) layoutDriven = true;
      if (previousLeft === undefined || reduceMotion) return;
      const running = segment
        .getAnimations()
        .filter((animation) => animation.id === readoutGlideAnimationId);
      const shift = readoutLabelShift(
        previousLeft,
        left,
        running.length ? drawnTranslateX(segment) : 0,
        drivenHere,
      );
      if (shift === null) return;
      for (const animation of running) animation.cancel();
      if (shift.kind !== 'glide') return;
      const animation = segment.animate(
        [{ transform: `translateX(${shift.offset}px)` }, { transform: 'translateX(0)' }],
        {
          duration: motionDuration('--motion-duration-tab-move', 160),
          easing: motionEasing('--motion-ease-move', 'cubic-bezier(0.2, 0, 0, 1)'),
        },
      );
      animation.id = readoutGlideAnimationId;
    });
    previous.current = { positions, closing: closingKinds, resizing };
  });
}

export type CanvasFocusSource = 'keyboard' | 'pointer';

export function canvasFocusSource(pointerPressed: boolean): CanvasFocusSource {
  return pointerPressed ? 'pointer' : 'keyboard';
}

const quietCanvasFocusFlag = 'canvasQuietFocus';

export function focusPreviewCanvasQuietly(canvas: HTMLCanvasElement): void {
  const host = canvas.parentElement;
  if (host) host.dataset[quietCanvasFocusFlag] = 'true';
  try {
    canvas.focus({ focusVisible: false, preventScroll: true });
  } finally {
    if (host) delete host.dataset[quietCanvasFocusFlag];
  }
}

export function useCanvasKeyboardFocus(host: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const container = host.current;
    if (!container) return undefined;
    let pointerPressed = false;
    const isCanvas = (target: EventTarget | null) =>
      target instanceof HTMLCanvasElement && target.parentElement === container;
    const press = (event: PointerEvent) => {
      pointerPressed = isCanvas(event.target);
      if (pointerPressed && event.target === document.activeElement) {
        container.dataset.canvasFocus = canvasFocusSource(true);
      }
    };
    const release = () => {
      window.setTimeout(() => {
        pointerPressed = false;
      }, 0);
    };
    const focusIn = (event: FocusEvent) => {
      if (!isCanvas(event.target)) return;
      container.dataset.canvasFocus = canvasFocusSource(
        pointerPressed || container.dataset[quietCanvasFocusFlag] === 'true',
      );
      pointerPressed = false;
    };
    const focusOut = (event: FocusEvent) => {
      if (isCanvas(event.target)) delete container.dataset.canvasFocus;
    };
    container.addEventListener('pointerdown', press, true);
    container.addEventListener('pointerup', release, true);
    container.addEventListener('focusin', focusIn);
    container.addEventListener('focusout', focusOut);
    return () => {
      container.removeEventListener('pointerdown', press, true);
      container.removeEventListener('pointerup', release, true);
      container.removeEventListener('focusin', focusIn);
      container.removeEventListener('focusout', focusOut);
      delete container.dataset.canvasFocus;
    };
  }, [host]);
}

export interface PreviewLegendCatalog {
  objectNames: readonly { objectId: number; name: string }[];
  terrainNames: readonly { terrainId: number; name: string }[];
}

export interface PreviewLegendWidths {
  panel: number;
  readout: number;
}

export function usePreviewLegendWidth(
  objectNames: PreviewLegendCatalog['objectNames'] | undefined,
  terrainNames: PreviewLegendCatalog['terrainNames'] | undefined,
): PreviewLegendWidths | null {
  const [fontRevision, setFontRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const update = () => {
      if (active) setFontRevision((current) => current + 1);
    };
    document.fonts.addEventListener('loadingdone', update);
    void document.fonts.ready.then(update);
    const stopLocale = window.rmside.onLocaleChanged(update);
    return () => {
      active = false;
      document.fonts.removeEventListener('loadingdone', update);
      stopLocale();
    };
  }, []);
  return useMemo(() => {
    void fontRevision;
    if (!objectNames || !terrainNames) return null;
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return null;
    const family = getComputedStyle(document.body).fontFamily;
    const measure = (font: string, tabular = false) => {
      return (text: string) => {
        context.font = font;
        return context.measureText(tabular ? text.replace(/\d/gu, '0') : text).width;
      };
    };
    const metrics: PreviewLegendTextMetrics = {
      name: measure(`650 12px ${family}`),
      muted: measure(`600 11px ${family}`, true),
      count: measure(`650 12px ${family}`, true),
      readout: measure(`600 10px ${family}`, true),
    };
    return {
      panel: previewLegendPanelWidth({ objectNames, terrainNames }, metrics),
      readout: previewReadoutWidth(metrics),
    };
  }, [fontRevision, objectNames, terrainNames]);
}

export function previewLegendMaxHeight(
  previewHeight: number,
  layout: { narrow: boolean; readoutStacked: boolean; keyboardCueRise: number },
): number {
  const top = (layout.narrow ? 56 : 22) + 22 + 6 + (layout.readoutStacked ? 20 : 0);
  const bottom = Math.max(22 + 26 + 20, layout.keyboardCueRise + 6);
  return Math.max(26, previewHeight - top - bottom);
}

export function useKeyboardCueRise(): [(toolbar: HTMLElement | null) => void, number] {
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  const [rise, setRise] = useState(0);
  useEffect(() => {
    if (!toolbar) {
      setRise(0);
      return undefined;
    }
    const update = () => {
      const cue = toolbar.querySelector<HTMLElement>('.preview-keyboard-focus-cue');
      const host = toolbar.parentElement;
      const next =
        cue && host && cue.getClientRects().length > 0
          ? Math.max(
              0,
              Math.ceil(host.getBoundingClientRect().bottom - cue.getBoundingClientRect().top),
            )
          : 0;
      setRise((current) => (current === next ? current : next));
    };
    update();
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(toolbar);
    return () => resizeObserver.disconnect();
  }, [toolbar]);
  return [setToolbar, rise];
}
