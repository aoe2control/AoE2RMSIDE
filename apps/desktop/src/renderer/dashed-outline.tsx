import { useLayoutEffect, useRef, useState } from 'react';

export const dashedOutlineStroke = 2;
export const dashedOutlineDash = 4;

export type DashedOutlineGeometry = {
  inset: number;
  width: number;
  height: number;
  radius: number;
  dashes: number;
};

export function dashedOutlineGeometry(
  width: number,
  height: number,
  radius: number,
  stroke = dashedOutlineStroke,
  dash = dashedOutlineDash,
): DashedOutlineGeometry | null {
  const inset = stroke / 2;
  const innerWidth = width - stroke;
  const innerHeight = height - stroke;
  if (!(innerWidth > 0 && innerHeight > 0 && dash > 0)) return null;
  const innerRadius = Math.max(0, Math.min(radius - inset, innerWidth / 2, innerHeight / 2));
  const perimeter =
    2 * (innerWidth - 2 * innerRadius) +
    2 * (innerHeight - 2 * innerRadius) +
    2 * Math.PI * innerRadius;
  const dashes = Math.max(4, Math.round(perimeter / (2 * dash)));
  return { inset, width: innerWidth, height: innerHeight, radius: innerRadius, dashes };
}

export function DashedOutline() {
  const ref = useRef<SVGSVGElement>(null);
  const [geometry, setGeometry] = useState<DashedOutlineGeometry | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number }>();

  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const measure = () => {
      const style = getComputedStyle(parent);
      const width = Number.parseFloat(style.width) || parent.offsetWidth;
      const height = Number.parseFloat(style.height) || parent.offsetHeight;
      const next = dashedOutlineGeometry(
        width,
        height,
        Number.parseFloat(style.borderTopLeftRadius) || 0,
      );
      const left = -(Number.parseFloat(style.borderLeftWidth) || 0);
      const top = -(Number.parseFloat(style.borderTopWidth) || 0);
      setBox((current) =>
        current &&
        current.left === left &&
        current.top === top &&
        current.width === width &&
        current.height === height
          ? current
          : { left, top, width, height },
      );
      setGeometry((current) =>
        current &&
        next &&
        current.width === next.width &&
        current.height === next.height &&
        current.radius === next.radius
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  return (
    <svg
      aria-hidden="true"
      className="dashed-outline"
      data-slot="dashed-outline"
      ref={ref}
      style={box}
    >
      {geometry ? (
        <rect
          fill="none"
          height={geometry.height}
          pathLength={geometry.dashes * 2}
          rx={geometry.radius}
          strokeDasharray="1 1"
          strokeWidth={dashedOutlineStroke}
          width={geometry.width}
          x={geometry.inset}
          y={geometry.inset}
        />
      ) : null}
    </svg>
  );
}
