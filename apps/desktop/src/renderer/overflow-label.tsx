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
  name,
  textClassName,
}: {
  children?: ReactNode;
  className: string;
  measure?: 'observe' | 'hover';
  focusable?: boolean;
  revealOnParentFocus?: boolean;
  name: string;
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

  const measureDistance = useCallback(() => {
    const element = label.current;
    const text = labelText.current;
    if (!element || !text) return 0;
    const overflow = Number.parseFloat(getComputedStyle(text).width) - element.clientWidth;
    const next = overflow > 1 ? Math.ceil(overflow) : 0;
    setDistance(next);
    dispatch({ type: 'measured', distance: next });
    return next;
  }, [dispatch]);

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
    const current = effectiveMeasure === 'hover' ? measureDistance() : overflow;
    if (current <= 0) return;
    setForwardSeconds(overflowForwardSeconds(current, currentOffset(labelText.current)));
    dispatch({ type: 'enter', distance: current });
  }, [dispatch, effectiveMeasure, measureDistance, overflow]);
  const restore = useCallback(() => {
    const offset = currentOffset(labelText.current);
    setReturnSeconds(overflowReturnSeconds(offset));
    dispatch({ type: 'leave', offset });
  }, [dispatch]);

  useEffect(() => {
    if (!revealOnParentFocus) return undefined;
    const element = label.current;
    const button = element?.closest('button');
    if (!element || !button) return undefined;
    parentButton.current = button;
    const blur = () => {
      if (!element.matches(':hover')) restore();
    };
    button.addEventListener('focus', reveal);
    button.addEventListener('blur', blur);
    if (button === element.ownerDocument.activeElement) reveal();
    return () => {
      button.removeEventListener('focus', reveal);
      button.removeEventListener('blur', blur);
      parentButton.current = null;
    };
  }, [revealOnParentFocus, reveal, restore]);

  return (
    <span
      className={`overflow-label ${className}`}
      data-overflow-distance={distance ?? undefined}
      data-overflow-position={overflow > 0 ? position : distance === null ? 'start' : undefined}
      data-overflowing={distance === null ? undefined : overflow > 0}
      onBlur={
        focusable
          ? (event) => {
              if (!event.currentTarget.matches(':hover')) restore();
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
      onPointerEnter={reveal}
      onPointerLeave={(event) => {
        const element = event.currentTarget;
        const keyboardFocused =
          (focusable && element.matches(':focus')) ||
          (revealOnParentFocus && parentButton.current === element.ownerDocument.activeElement);
        if (!keyboardFocused) restore();
      }}
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
