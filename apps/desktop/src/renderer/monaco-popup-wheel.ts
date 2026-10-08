export const editorPopupWheelSelector = [
  '.quick-input-widget',
  '.suggest-widget',
  '.suggest-details',
  '.monaco-resizable-hover',
  '.monaco-hover',
  '.parameter-hints-widget',
  '.rename-box',
  '.reference-zone-widget .ref-tree',
].join(', ');

const popupListSelector = '.monaco-list > .monaco-scrollable-element';

const forwardedWheels = new WeakSet<Event>();

function isVisible(element: Element): boolean {
  return element.getClientRects().length > 0;
}

export function popupWheelForwardTarget(
  popup: Element,
  target: EventTarget | null,
): Element | null {
  const list = [...popup.querySelectorAll(popupListSelector)].find(isVisible);
  if (!list) return null;
  if (target instanceof Node && list.contains(target)) return null;
  return list;
}

function containPopupWheel(this: Element, event: Event): void {
  event.stopPropagation();
  if (forwardedWheels.has(event) || !(event instanceof WheelEvent)) return;
  const list = popupWheelForwardTarget(this, event.target);
  if (!list) return;
  const legacy = event as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number };
  const forwarded = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: event.clientX,
    clientY: event.clientY,
    deltaMode: event.deltaMode,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaZ: event.deltaZ,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    view: event.view,
    ...(legacy.wheelDeltaX === undefined
      ? {}
      : { wheelDeltaX: legacy.wheelDeltaX, wheelDeltaY: legacy.wheelDeltaY }),
  } as WheelEventInit);
  forwardedWheels.add(forwarded);
  event.preventDefault();
  list.dispatchEvent(forwarded);
}

export function containEditorPopupWheel(host: HTMLElement): () => void {
  const onWheel = (event: WheelEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const popup = target.closest(editorPopupWheelSelector);
    if (!popup || !host.contains(popup)) return;
    popup.addEventListener('wheel', containPopupWheel);
  };
  host.addEventListener('wheel', onWheel, { capture: true, passive: true });
  return () => host.removeEventListener('wheel', onWheel, { capture: true });
}
