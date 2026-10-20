import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  nextOverflowPosition,
  overflowForwardSeconds,
  overflowReturnSeconds,
  type OverflowEvent,
  type OverflowPosition,
} from './overflow-label-state';

export { overflowLabelScrollPixelsPerSecond } from './overflow-label-state';

function currentOffset(text: HTMLElement | null): number {
  if (!text) return 0;
  const transform = getComputedStyle(text).transform;
  return transform === 'none' ? 0 : Math.abs(new DOMMatrixReadOnly(transform).m41);
}

export function OverflowingLabel({
  children,
  className,
  measure = 'observe',
  focusable = false,
  revealOnParentFocus = false,
  hoverArea,
  hoverAreaExcept,
  name,
  slideWhenHoverOverflows = false,
  textClassName,
}: {
  children?: ReactNode;
  className: string;
  measure?: 'observe' | 'hover';
  focusable?: boolean;
  revealOnParentFocus?: boolean;
  hoverArea?: string;
  hoverAreaExcept?: string;
  name: string;
  slideWhenHoverOverflows?: boolean;
  textClassName: string;
}) {
  const effectiveMeasure = focusable || revealOnParentFocus ? 'observe' : measure;
  const label = useRef<HTMLSpanElement>(null);
  const labelText = useRef<HTMLSpanElement>(null);
  const parentButton = useRef<HTMLButtonElement | null>(null);
  const [distance, setDistance] = useState<number | null>(
    effectiveMeasure === 'observe' ? 0 : null,
  );
  const [position, setPosition] = useState<OverflowPosition>('start');
  const [forwardSeconds, setForwardSeconds] = useState(0);
  const [returnSeconds, setReturnSeconds] = useState(overflowReturnSeconds(0));
  const dispatch = useCallback(
    (event: OverflowEvent) => setPosition((current) => nextOverflowPosition(current, event)),
    [],
  );

  const revealing = useRef(false);
  const measureDistance = useCallback(() => {
    const element = label.current;
    const text = labelText.current;
    if (!element || !text) return 0;
    const overflow = Number.parseFloat(getComputedStyle(text).width) - element.clientWidth;
    const next = overflow > 1 ? Math.ceil(overflow) : 0;
    setDistance(next);
    const slides = slideWhenHoverOverflows && revealing.current;
    if (slides && next > 0) {
      setForwardSeconds(overflowForwardSeconds(next, currentOffset(text)));
    }
    dispatch({ type: 'measured', distance: next, revealing: slides });
    return next;
  }, [dispatch, slideWhenHoverOverflows]);

  useEffect(() => {
    setPosition('start');
    if (effectiveMeasure !== 'observe') {
      setDistance(null);
      return undefined;
    }
    const element = label.current;
    const text = labelText.current;
    if (!element || !text) return undefined;
    const observer = new ResizeObserver(() => measureDistance());
    observer.observe(element);
    observer.observe(text);
    measureDistance();
    return () => observer.disconnect();
  }, [effectiveMeasure, measureDistance, name]);

  const overflow = distance ?? 0;
  const style = {
    '--overflow-label-duration': `${forwardSeconds}s`,
    '--overflow-label-return-duration': `${returnSeconds}s`,
    '--overflow-label-shift': `${-overflow}px`,
  } as CSSProperties;

  const reveal = useCallback(() => {
    revealing.current = true;
    const current = effectiveMeasure === 'hover' ? measureDistance() : overflow;
    if (current <= 0) return;
    setForwardSeconds(overflowForwardSeconds(current, currentOffset(labelText.current)));
    dispatch({ type: 'enter', distance: current });
  }, [dispatch, effectiveMeasure, measureDistance, overflow]);
  const restore = useCallback(() => {
    revealing.current = false;
    const offset = currentOffset(labelText.current);
    setReturnSeconds(overflowReturnSeconds(offset));
    dispatch({ type: 'leave', offset });
  }, [dispatch]);

  const areaHovered = useRef(false);
  const hovered = useCallback(
    (element: HTMLElement) => (hoverArea ? areaHovered.current : element.matches(':hover')),
    [hoverArea],
  );
  const keyboardFocused = useCallback(
    (element: HTMLElement) =>
      (focusable && element.matches(':focus')) ||
      (revealOnParentFocus && parentButton.current === element.ownerDocument.activeElement),
    [focusable, revealOnParentFocus],
  );

  useEffect(() => {
    const element = label.current;
    const area = hoverArea ? element?.closest<HTMLElement>(hoverArea) : null;
    if (!element || !area) return undefined;
    const update = (next: boolean) => {
      if (areaHovered.current === next) return;
      areaHovered.current = next;
      if (next) reveal();
      else if (!keyboardFocused(element)) restore();
    };
    const over = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const excepted = hoverAreaExcept ? target?.closest(hoverAreaExcept) : null;
      update(!(excepted && area.contains(excepted)));
    };
    const out = (event: PointerEvent) => {
      const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (next && area.contains(next)) return;
      update(false);
    };
    area.addEventListener('pointerover', over);
    area.addEventListener('pointerout', out);
    return () => {
      area.removeEventListener('pointerover', over);
      area.removeEventListener('pointerout', out);
    };
  }, [hoverArea, hoverAreaExcept, keyboardFocused, restore, reveal]);

  useEffect(() => {
    if (!revealOnParentFocus) return undefined;
    const element = label.current;
    const button = element?.closest('button');
    if (!element || !button) return undefined;
    parentButton.current = button;
    const blur = () => {
      if (!hovered(element)) restore();
    };
    button.addEventListener('focus', reveal);
    button.addEventListener('blur', blur);
    if (button === element.ownerDocument.activeElement) reveal();
    return () => {
      button.removeEventListener('focus', reveal);
      button.removeEventListener('blur', blur);
      parentButton.current = null;
    };
  }, [hovered, revealOnParentFocus, reveal, restore]);

  return (
    <span
      className={`overflow-label ${className}`}
      data-overflow-distance={distance ?? undefined}
      data-overflow-position={overflow > 0 ? position : distance === null ? 'start' : undefined}
      data-overflowing={distance === null ? undefined : overflow > 0}
      onBlur={
        focusable
          ? (event) => {
              if (!hovered(event.currentTarget)) restore();
            }
          : undefined
      }
      onFocus={focusable ? reveal : undefined}
      onKeyDown={
        focusable
          ? (event) => {
              if (event.key !== 'Escape') return;
              event.stopPropagation();
              restore();
            }
          : undefined
      }
      onPointerEnter={hoverArea ? undefined : reveal}
      onPointerLeave={
        hoverArea
          ? undefined
          : (event) => {
              if (!keyboardFocused(event.currentTarget)) restore();
            }
      }
      ref={label}
      style={style}
      tabIndex={focusable && overflow > 0 ? 0 : undefined}
    >
      <span
        className={`overflow-label-text ${textClassName}`}
        onTransitionEnd={(event) => {
          if (event.target !== event.currentTarget || event.propertyName !== 'transform') return;
          dispatch({ type: position === 'returning' ? 'returned' : 'arrived' });
        }}
        ref={labelText}
      >
        {children ?? name}
      </span>
    </span>
  );
}
