import { useCallback, useEffect, useRef, useState, type Ref, type RefCallback } from 'react';
import { holdsQuietFocus } from './quiet-focus';

export const reducedMotionQuery = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(reducedMotionQuery).matches;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const query = window.matchMedia(reducedMotionQuery);
    const update = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function parseCssTime(value: string): number | null {
  const match = /^\s*(-?\d*\.?\d+)(ms|s)\s*$/u.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  return match[2] === 's' ? amount * 1_000 : amount;
}

export function motionDuration(token: `--motion-${string}`, fallback: number): number {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(token);
  return parseCssTime(value) ?? fallback;
}

export function motionNumber(token: `--motion-${string}`, fallback: number): number {
  if (typeof document === 'undefined') return fallback;
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(token),
  );
  return Number.isFinite(value) ? value : fallback;
}

export function motionEasing(token: `--motion-ease-${string}`, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value || fallback;
}

export function finiteAnimations(element: Element): Animation[] {
  return element
    .getAnimations()
    .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity);
}

const presenceExitCeilingMs = 600;

export interface Presence {
  mounted: boolean;
  closing: boolean;
  ref(element: HTMLElement | null): void;
}

export function usePresence(present: boolean): Presence {
  const [mounted, setMounted] = useState(present);
  const element = useRef<HTMLElement | null>(null);
  if (present && !mounted) setMounted(true);
  const closing = mounted && !present;
  useEffect(() => {
    if (!closing) return undefined;
    let active = true;
    const finish = () => {
      if (!active) return;
      active = false;
      setMounted(false);
    };
    const node = element.current;
    const animations = node ? finiteAnimations(node) : [];
    if (animations.length === 0) {
      finish();
      return undefined;
    }
    const ceiling = window.setTimeout(finish, presenceExitCeilingMs);
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(finish);
    return () => {
      active = false;
      window.clearTimeout(ceiling);
    };
  }, [closing]);
  const ref = useCallback((node: HTMLElement | null) => {
    element.current = node;
  }, []);
  return { closing, mounted: mounted || present, ref };
}

export function presenceProps(closing: boolean): {
  'aria-hidden'?: true;
  'data-ending-style'?: '';
  inert?: boolean;
} {
  return closing ? { 'aria-hidden': true, 'data-ending-style': '', inert: true } : {};
}

export function useHeld<T>(value: T, closing: boolean): T {
  const held = useRef(value);
  if (!closing) held.current = value;
  return closing ? held.current : value;
}

export function useLeavingSurface<T extends HTMLElement>(forwarded?: Ref<T>): RefCallback<T> {
  const forwardedRef = useRef(forwarded);
  forwardedRef.current = forwarded;
  return useCallback((node: T | null) => {
    assignRef(forwardedRef.current, node);
    if (!node) return undefined;
    const document = node.ownerDocument;
    const active = document.activeElement;
    const returnTarget =
      active instanceof HTMLElement && active !== document.body && !node.contains(active)
        ? active
        : null;
    const returnQuietly =
      returnTarget !== null &&
      (holdsQuietFocus(returnTarget) || !returnTarget.matches(':focus-visible'));
    let retired = false;
    let movedFocus: { from: HTMLElement; to: Element | null } | null = null;
    const observer = new MutationObserver(() => {
      const leaving = node.hasAttribute('data-ending-style');
      if (leaving === retired) return;
      retired = leaving;
      if (!leaving) {
        node.removeAttribute('aria-hidden');
        node.inert = false;
        const moved = movedFocus;
        movedFocus = null;
        const active = document.activeElement;
        if (moved && moved.from.isConnected && (active === moved.to || active === document.body)) {
          moved.from.focus({ preventScroll: true });
        }
        return;
      }
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && node.contains(focused)) {
        if (returnTarget?.isConnected) {
          returnTarget.focus(
            returnQuietly ? { focusVisible: false, preventScroll: true } : { preventScroll: true },
          );
        } else focused.blur();
        movedFocus = { from: focused, to: document.activeElement };
      }
      node.setAttribute('aria-hidden', 'true');
      node.inert = true;
    });
    observer.observe(node, { attributeFilter: ['data-ending-style'], attributes: true });
    return () => {
      observer.disconnect();
      assignRef(forwardedRef.current, null);
    };
  }, []);
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}
