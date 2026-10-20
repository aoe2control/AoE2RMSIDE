import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface ListSurfaceBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export type ListSurfaceTone = 'overlay' | 'gap';

export type ListSurfaceLayout = 'side-by-side' | 'behind-editor' | null;

export interface ListSurfaceJoin {
  readonly edge: number;
  readonly top: number;
  readonly bottom: number;
  readonly overhang: number;
}

export interface ListSurfaceGeometry {
  readonly left: number;
  readonly overhang: number;
  readonly right: number;
  readonly top: number;
  readonly rowsTop: number;
  readonly bottom: number;
  readonly bridged: boolean;
  readonly radius: number;
}

export const listSurfaceMaximumGap = 48;

export function listSurfaceMode(options: {
  readonly listsCode: boolean;
  readonly leaving: boolean;
  readonly layout: ListSurfaceLayout;
}): { readonly shown: boolean; readonly tone: ListSurfaceTone } {
  const { layout, leaving, listsCode } = options;
  return {
    shown: listsCode && !leaving && layout !== null,
    tone: layout === 'side-by-side' ? 'gap' : 'overlay',
  };
}

export function listSurfaceGeometry(options: {
  readonly list: ListSurfaceBox;
  readonly rowsTop: number;
  readonly join: ListSurfaceJoin | null;
  readonly radius: number;
}): ListSurfaceGeometry {
  const { join, list, radius } = options;
  const rowsTop = Math.min(Math.max(options.rowsTop, list.top), list.bottom);
  const gap = join ? list.left - join.edge : Number.NaN;
  const bridged =
    join !== null &&
    gap >= radius &&
    gap <= listSurfaceMaximumGap &&
    list.top - radius >= join.top &&
    list.bottom + radius <= join.bottom;
  return {
    left: bridged ? join.edge - join.overhang : list.left,
    overhang: bridged ? join.overhang : 0,
    right: list.right,
    top: list.top,
    rowsTop,
    bottom: list.bottom,
    bridged,
    radius,
  };
}

export function sameListSurfaceGeometry(
  a: ListSurfaceGeometry | null,
  b: ListSurfaceGeometry | null,
): boolean {
  if (a === null || b === null) return a === b;
  const same = (x: number, y: number) => Math.abs(x - y) < 1 / 128;
  return (
    a.bridged === b.bridged &&
    same(a.left, b.left) &&
    same(a.overhang, b.overhang) &&
    same(a.right, b.right) &&
    same(a.top, b.top) &&
    same(a.rowsTop, b.rowsTop) &&
    same(a.bottom, b.bottom) &&
    same(a.radius, b.radius)
  );
}

export function listSurfaceStyle(geometry: ListSurfaceGeometry | null): Record<string, string> {
  if (geometry === null) return { display: 'none' };
  return {
    '--list-surface-left': `${geometry.left}px`,
    '--list-surface-overhang': `${geometry.overhang}px`,
    '--list-surface-width': `${geometry.right - geometry.left}px`,
    '--list-surface-top': `${geometry.top}px`,
    '--list-surface-rows-top': `${geometry.rowsTop}px`,
    '--list-surface-bottom': `${geometry.bottom}px`,
    '--list-surface-radius': `${geometry.radius}px`,
  };
}

function applyListSurface(element: HTMLElement, geometry: ListSurfaceGeometry | null): void {
  const style = listSurfaceStyle(geometry);
  element.style.display = style.display ?? '';
  for (const [name, value] of Object.entries(style)) {
    if (name.startsWith('--')) element.style.setProperty(name, value);
  }
  element.dataset.bridged = String(geometry?.bridged ?? false);
}

export function codeEndSnap(right: number, devicePixelRatio: number): number {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return right - Math.round(right * ratio) / ratio;
}

function snapCodeEnd(host: HTMLElement): boolean {
  const current = Number.parseFloat(host.style.getPropertyValue('--code-end-snap')) || 0;
  const unsnapped = host.getBoundingClientRect().right + current;
  const next = codeEndSnap(unsnapped, window.devicePixelRatio);
  if (host.hasAttribute('data-code-end-snap') && Math.abs(next - current) < 1 / 128) return false;
  host.dataset.codeEndSnap = '';
  host.style.setProperty('--code-end-snap', `${next}px`);
  return true;
}

function unsnapCodeEnd(host: HTMLElement): void {
  delete host.dataset.codeEndSnap;
  host.style.removeProperty('--code-end-snap');
}

export function listSurfaceLayout(canvas: Element): ListSurfaceLayout {
  const layout = canvas.closest<HTMLElement>('.workspace-preview-region')?.dataset.layout;
  return layout === 'side-by-side' || layout === 'behind-editor' ? layout : null;
}

function offsetWithin(element: HTMLElement, ancestor: HTMLElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let current: HTMLElement | null = element;
  while (current && current !== ancestor) {
    x += current.offsetLeft;
    y += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return { x, y };
}

function measureJoin(canvas: HTMLElement, layout: ListSurfaceLayout): ListSurfaceJoin | null {
  const canvasBox = canvas.getBoundingClientRect();
  if (layout === 'side-by-side') {
    const radius = Number.parseFloat(getComputedStyle(canvas).borderTopLeftRadius) || 0;
    return { edge: 0, top: radius, bottom: canvas.clientHeight - radius, overhang: 2 };
  }
  if (layout !== 'behind-editor') return null;
  const workspace = canvas.closest<HTMLElement>('.fixed-workspace');
  if (!workspace || workspace.dataset.editorShown === 'false') return null;
  const host = workspace.querySelector<HTMLElement>('.editor-panel .monaco-host');
  if (!host) return null;
  const hostBox = host.getBoundingClientRect();
  if (hostBox.width <= 0 || hostBox.height <= 0) return null;
  const radius = Number.parseFloat(getComputedStyle(host).borderTopRightRadius) || 0;
  let bottom = hostBox.bottom - radius;
  const outline = workspace.querySelector<HTMLElement>(
    '.editor-panel[data-outline-row="true"] .editor-outline-row',
  );
  const outlineBox = outline?.getBoundingClientRect();
  if (outlineBox && outlineBox.height > 0) bottom = Math.min(bottom, outlineBox.top);
  return {
    edge: hostBox.right - canvasBox.left,
    top: hostBox.top + radius - canvasBox.top,
    bottom: bottom - canvasBox.top,
    overhang: 0,
  };
}

export function measureListSurface(surface: HTMLElement): ListSurfaceGeometry | null {
  const canvas = surface.parentElement;
  if (!canvas) return null;
  const information = canvas.querySelector<HTMLElement>(':scope > .preview-map-information');
  const legend =
    information?.querySelector<HTMLElement>('.preview-map-legend:not([data-ending-style])') ??
    information?.querySelector<HTMLElement>('.preview-map-legend');
  if (!information || !legend || legend.offsetWidth <= 0 || legend.offsetHeight <= 0) return null;
  const origin = offsetWithin(legend, canvas);
  const list = {
    left: origin.x,
    top: origin.y,
    right: origin.x + legend.offsetWidth,
    bottom: origin.y + legend.offsetHeight,
  };
  const filter = legend.querySelector<HTMLElement>(':scope > .preview-legend-filter');
  const rowsTop = filter ? origin.y + filter.offsetTop + filter.offsetHeight : origin.y;
  const radius = Number.parseFloat(getComputedStyle(legend).borderTopRightRadius) || 0;
  return listSurfaceGeometry({
    list,
    rowsTop,
    join: measureJoin(canvas, listSurfaceLayout(canvas)),
    radius,
  });
}

export function useListSurfaceGeometry(
  active: boolean,
  watch: unknown,
): (element: HTMLElement | null) => void {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const shown = useRef<ListSurfaceGeometry | null>(null);
  const ref = useCallback((node: HTMLElement | null) => {
    shown.current = null;
    if (node) applyListSurface(node, null);
    setElement(node);
  }, []);
  useLayoutEffect(() => {
    if (!active || !element) return undefined;
    const canvas = element.parentElement;
    const workspace = canvas?.closest('.fixed-workspace');
    const host = workspace?.querySelector<HTMLElement>('.editor-panel .monaco-host') ?? null;
    const measure = () => {
      if (host && canvas) {
        if (listSurfaceLayout(canvas) === 'behind-editor') snapCodeEnd(host);
        else unsnapCodeEnd(host);
      }
      const next = measureListSurface(element);
      if (next === null || sameListSurfaceGeometry(shown.current, next)) return;
      shown.current = next;
      applyListSurface(element, next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    const observe = (target: Element | null | undefined) => {
      if (target) observer.observe(target);
    };
    observe(canvas);
    const information = canvas?.querySelector(':scope > .preview-map-information');
    observe(information);
    information?.querySelectorAll('.preview-map-legend').forEach(observe);
    observe(host);
    observe(workspace?.querySelector('.editor-panel .editor-outline-row'));
    const children = new MutationObserver(() => {
      information?.querySelectorAll('.preview-map-legend').forEach(observe);
      measure();
    });
    if (information) children.observe(information, { childList: true });
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      children.disconnect();
      window.removeEventListener('resize', measure);
      if (host) unsnapCodeEnd(host);
    };
  }, [active, element, watch]);
  return ref;
}
