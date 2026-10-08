import { useCallback, useMemo, useRef } from 'react';
import { prefersReducedMotion } from './motion';

export interface AnimatedIconHandle {
  startAnimation(): void;
  stopAnimation(): void;
}

export function playIconAnimation(icon: AnimatedIconHandle | null | undefined): void {
  if (!icon || prefersReducedMotion()) return;
  icon.startAnimation();
}

export function useAnimatedIconHover<T extends AnimatedIconHandle = AnimatedIconHandle>() {
  const iconRef = useRef<T | null>(null);
  const startAnimation = useCallback(() => playIconAnimation(iconRef.current), []);
  const stopAnimation = useCallback(() => iconRef.current?.stopAnimation(), []);
  const animationHandlers = useMemo(
    () => ({
      onMouseEnter: startAnimation,
      onMouseLeave: stopAnimation,
    }),
    [startAnimation, stopAnimation],
  );
  return { animationHandlers, iconRef };
}
