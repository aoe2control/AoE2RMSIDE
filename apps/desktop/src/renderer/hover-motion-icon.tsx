import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AnimatedIconHandle } from './animated-icon';
import {
  createIconHoverMotion,
  iconLayerTransforms,
  type IconGeometryCenter,
  type IconHoverMotion,
} from './icon-hover-motion';
import { prefersReducedMotion } from './motion';

const boxCenter: IconGeometryCenter = { x: 50, y: 50 };

function geometryCenter(svg: SVGSVGElement): IconGeometryCenter {
  const viewBox = svg.viewBox.baseVal;
  if (!viewBox || viewBox.width <= 0 || viewBox.height <= 0) return boxCenter;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const shape of svg.children) {
    if (!(shape instanceof SVGGraphicsElement)) continue;
    const bounds = shape.getBBox();
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }
  if (!Number.isFinite(left) || !Number.isFinite(top)) return boxCenter;
  return {
    x: (((left + right) / 2 - viewBox.x) / viewBox.width) * 100,
    y: (((top + bottom) / 2 - viewBox.y) / viewBox.height) * 100,
  };
}

export function HoverMotionIcon({
  className,
  duration = 1,
  icon: Icon,
  ref,
  ...props
}: Omit<LucideProps, 'ref'> & {
  icon: LucideIcon;
  duration?: number;
  ref?: Ref<AnimatedIconHandle>;
}) {
  const layer = useRef<HTMLSpanElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const motion = useRef<IconHoverMotion | null>(null);

  useEffect(() => {
    let center = boxCenter;
    const controller = createIconHoverMotion({
      duration,
      reducedMotion: prefersReducedMotion,
      render(pose) {
        const outer = layer.current;
        const inner = svg.current;
        if (!outer || !inner) return;
        if (!pose) {
          outer.style.removeProperty('transform');
          inner.style.removeProperty('transform');
          inner.style.removeProperty('transform-origin');
          return;
        }
        const transforms = iconLayerTransforms(pose, center, inner.viewBox.baseVal?.height || 24);
        outer.style.transform = transforms.outer;
        inner.style.transformOrigin = transforms.innerOrigin;
        inner.style.transform = transforms.inner;
      },
    });
    motion.current = {
      start() {
        if (svg.current) center = geometryCenter(svg.current);
        controller.start();
      },
      stop: () => controller.stop(),
      dispose: () => controller.dispose(),
    };
    return () => {
      controller.dispose();
      motion.current = null;
      layer.current?.style.removeProperty('transform');
      svg.current?.style.removeProperty('transform');
      svg.current?.style.removeProperty('transform-origin');
    };
  }, [duration]);

  useImperativeHandle(
    ref,
    () => ({
      startAnimation: () => motion.current?.start(),
      stopAnimation: () => motion.current?.stop(),
    }),
    [],
  );

  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center', className)}
      data-slot="hover-motion-icon"
      ref={layer}
      style={{ transformOrigin: '50% 50%' }}
    >
      <Icon ref={svg} {...props} />
    </span>
  );
}
