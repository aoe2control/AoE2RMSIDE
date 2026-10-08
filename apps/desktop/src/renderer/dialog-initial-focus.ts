import { useCallback, useRef, type Ref, type RefObject } from 'react';

export type DialogOpenType = 'mouse' | 'touch' | 'pen' | 'keyboard' | '';

export type DialogInitialFocus =
  | boolean
  | RefObject<HTMLElement | null>
  | ((openType: DialogOpenType) => boolean | HTMLElement | null | void)
  | undefined;

export type DialogInitialFocusFunction = (openType: DialogOpenType) => boolean | HTMLElement;

export interface DialogFocusEnvironment {
  firstTabbable(popup: HTMLElement): HTMLElement | null;
  activeElement(popup: HTMLElement): Element | null;
  nextFrame(callback: () => void): void;
}

const tabbableCandidates =
  'a[href],button,input:not([type="hidden"]),select,textarea,[tabindex],[contenteditable]:not([contenteditable="false"])';

function firstTabbable(popup: HTMLElement): HTMLElement | null {
  for (const element of popup.querySelectorAll<HTMLElement>(tabbableCandidates)) {
    if (element.tabIndex < 0 || element.matches(':disabled')) continue;
    if (element.closest('[inert], [hidden]')) continue;
    if (element.getClientRects().length === 0) continue;
    return element;
  }
  return null;
}

const browserEnvironment: DialogFocusEnvironment = {
  firstTabbable,
  activeElement: (popup) => popup.ownerDocument.activeElement,
  nextFrame: (callback) => {
    requestAnimationFrame(callback);
  },
};

export function resolveDialogInitialFocus(
  initialFocus: DialogInitialFocus,
  openType: DialogOpenType,
  popup: HTMLElement | null,
  environment: Pick<DialogFocusEnvironment, 'firstTabbable'> = browserEnvironment,
): HTMLElement | null | false {
  const fallback = () => (popup ? (environment.firstTabbable(popup) ?? popup) : null);
  if (initialFocus === undefined) return openType === 'touch' ? popup : fallback();
  if (initialFocus === false) return false;
  if (initialFocus === true) return fallback();
  if (typeof initialFocus === 'function') {
    const resolved = initialFocus(openType);
    if (resolved === undefined || resolved === false) return false;
    if (resolved === true || resolved === null) return fallback();
    return resolved;
  }
  return initialFocus.current ?? fallback();
}

export function applyDialogInitialFocus(
  initialFocus: DialogInitialFocus,
  openType: DialogOpenType,
  popup: HTMLElement | null,
  environment: DialogFocusEnvironment = browserEnvironment,
): boolean | HTMLElement {
  const target = resolveDialogInitialFocus(initialFocus, openType, popup, environment);
  if (target === false) return false;
  if (!popup || !target) return true;
  if (target === popup || popup.contains(environment.activeElement(popup))) return target;
  environment.nextFrame(() => {
    if (!target.isConnected || popup.hasAttribute('data-ending-style')) return;
    const active = environment.activeElement(popup);
    if (active !== target && popup.contains(active)) return;
    target.focus({ focusVisible: false, preventScroll: true });
  });
  return target;
}

export function useDialogInitialFocus<T extends HTMLElement>(
  initialFocus: DialogInitialFocus,
  forwarded?: Ref<T>,
): { initialFocus: DialogInitialFocusFunction; ref: (node: T | null) => void } {
  const popup = useRef<T | null>(null);
  const forwardedRef = useRef(forwarded);
  forwardedRef.current = forwarded;
  const ref = useCallback((node: T | null) => {
    popup.current = node;
    const target = forwardedRef.current;
    if (typeof target === 'function') target(node);
    else if (target) target.current = node;
  }, []);
  const resolvedInitialFocus = useCallback(
    (openType: DialogOpenType) => applyDialogInitialFocus(initialFocus, openType, popup.current),
    [initialFocus],
  );
  return { initialFocus: resolvedInitialFocus, ref };
}

export function isRepeatedActivation(event: {
  key: string;
  repeat: boolean;
  target: EventTarget | null;
}): boolean {
  if (!event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return false;
  const target = event.target as { closest?: (selector: string) => Element | null } | null;
  return typeof target?.closest === 'function' && target.closest('button') !== null;
}
