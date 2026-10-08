import { useLayoutEffect, useState } from 'react';
import { shellHeightEase } from './list-motion';
import { motionDuration, motionEasing, prefersReducedMotion } from './motion';

export const easedHeightAnimationId = 'rmside-eased-height';

export function useEasedHeight(): {
  shellRef(element: HTMLElement | null): void;
  contentRef(element: HTMLElement | null): void;
} {
  const [shellElement, shellRef] = useState<HTMLElement | null>(null);
  const [contentElement, contentRef] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!shellElement || !contentElement) return undefined;
    let settled = contentElement.offsetHeight;
    const observer = new ResizeObserver(() => {
      const target = contentElement.offsetHeight;
      if (target === settled) return;
      const running = shellElement
        .getAnimations()
        .filter(
          (animation) =>
            animation.id === easedHeightAnimationId && animation.playState !== 'finished',
        );
      const drawn = running.length ? shellElement.getBoundingClientRect().height : settled;
      settled = target;
      for (const animation of running) animation.cancel();
      const ease = shellHeightEase(drawn, target, prefersReducedMotion());
      if (!ease) return;
      const animation = shellElement.animate(
        ease.map((height) => ({ height: `${height}px` })),
        {
          duration: motionDuration('--motion-duration-list-height', 180),
          easing: motionEasing('--motion-ease-out', 'cubic-bezier(0.16, 1, 0.3, 1)'),
        },
      );
      animation.id = easedHeightAnimationId;
    });
    observer.observe(contentElement);
    return () => observer.disconnect();
  }, [contentElement, shellElement]);
  return { shellRef, contentRef };
}
