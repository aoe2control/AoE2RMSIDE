import {
  BoxesIcon as LibraryBoxesIcon,
  BoxIcon as LibraryBoxIcon,
  ChartNoAxesColumnIcon as LibraryChartNoAxesColumnIcon,
  CodeXmlIcon as LibraryCodeXmlIcon,
  DropletIcon as LibraryDropletIcon,
  EyeOffIcon as LibraryEyeOffIcon,
  FolderOpenIcon as LibraryFolderOpenIcon,
  FootprintsIcon as LibraryFootprintsIcon,
  ImageIcon as LibraryImageIcon,
  LayersIcon as LibraryLayersIcon,
  LayoutGridIcon as LibraryLayoutGridIcon,
  MapIcon as LibraryMapIcon,
  MenuIcon as LibraryMenuIcon,
  MonitorIcon as LibraryMonitorIcon,
  MountainIcon as LibraryMountainIcon,
  MoveDiagonal2Icon as LibraryMoveDiagonal2Icon,
  RouteIcon as LibraryRouteIcon,
  SunDimIcon as LibrarySunDimIcon,
} from '@animateicons/react/lucide';
import {
  useEffect,
  useImperativeHandle,
  useRef,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
  type Ref,
} from 'react';
import { cn } from '@/lib/utils';
import type { AnimatedIconHandle } from './animated-icon';
import {
  createIconHoverMotion,
  iconScaleHoverVariants,
  iconScaleTransform,
  type IconHoverMotion,
} from './icon-hover-motion';
import { prefersReducedMotion } from './motion';

export function HoverScaleIcon({
  children,
  className,
  ref,
}: {
  children: ReactNode;
  className?: string;
  ref?: Ref<AnimatedIconHandle>;
}) {
  const layer = useRef<HTMLSpanElement>(null);
  const motion = useRef<IconHoverMotion | null>(null);

  useEffect(() => {
    const controller = createIconHoverMotion({
      reducedMotion: prefersReducedMotion,
      render(pose) {
        const element = layer.current;
        if (!element) return;
        if (pose) element.style.transform = iconScaleTransform(pose);
        else element.style.removeProperty('transform');
      },
      variants: iconScaleHoverVariants,
    });
    motion.current = controller;
    const element = layer.current;
    return () => {
      controller.dispose();
      motion.current = null;
      element?.style.removeProperty('transform');
    };
  }, []);

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
      data-slot="hover-scale-icon"
      ref={layer}
      style={{ transformOrigin: '50% 50%' }}
    >
      {children}
    </span>
  );
}

type LibraryIconProps = Omit<
  ComponentProps<typeof LibraryMapIcon>,
  'duration' | 'isAnimated' | 'ref'
>;

function withHoverScale(
  Icon: ComponentType<LibraryIconProps & { isAnimated?: boolean }>,
  name: string,
) {
  function ScaledIcon({ ref, ...props }: LibraryIconProps & { ref?: Ref<AnimatedIconHandle> }) {
    return (
      <HoverScaleIcon ref={ref}>
        <Icon {...props} isAnimated={false} />
      </HoverScaleIcon>
    );
  }
  ScaledIcon.displayName = name;
  return ScaledIcon;
}

export const BoxesIcon = withHoverScale(LibraryBoxesIcon, 'BoxesIcon');
export const BoxIcon = withHoverScale(LibraryBoxIcon, 'BoxIcon');
export const ChartNoAxesColumnIcon = withHoverScale(
  LibraryChartNoAxesColumnIcon,
  'ChartNoAxesColumnIcon',
);
export const CodeXmlIcon = withHoverScale(LibraryCodeXmlIcon, 'CodeXmlIcon');
export const DropletIcon = withHoverScale(LibraryDropletIcon, 'DropletIcon');
export const EyeOffIcon = withHoverScale(LibraryEyeOffIcon, 'EyeOffIcon');
export const FolderOpenIcon = withHoverScale(LibraryFolderOpenIcon, 'FolderOpenIcon');
export const FootprintsIcon = withHoverScale(LibraryFootprintsIcon, 'FootprintsIcon');
export const ImageIcon = withHoverScale(LibraryImageIcon, 'ImageIcon');
export const LayersIcon = withHoverScale(LibraryLayersIcon, 'LayersIcon');
export const LayoutGridIcon = withHoverScale(LibraryLayoutGridIcon, 'LayoutGridIcon');
export const MapIcon = withHoverScale(LibraryMapIcon, 'MapIcon');
export const MenuIcon = withHoverScale(LibraryMenuIcon, 'MenuIcon');
export const MonitorIcon = withHoverScale(LibraryMonitorIcon, 'MonitorIcon');
export const MountainIcon = withHoverScale(LibraryMountainIcon, 'MountainIcon');
export const MoveDiagonal2Icon = withHoverScale(LibraryMoveDiagonal2Icon, 'MoveDiagonal2Icon');
export const RouteIcon = withHoverScale(LibraryRouteIcon, 'RouteIcon');
export const SunDimIcon = withHoverScale(LibrarySunDimIcon, 'SunDimIcon');
