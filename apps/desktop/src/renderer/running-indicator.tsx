import type { Ref } from 'react';
import { LoaderIcon } from '@animateicons/react/lucide';
import { cn } from '@/lib/utils';
import type { AnimatedIconHandle } from './animated-icon';

export function RunningIndicator({
  className,
  ref,
  size,
  testId,
}: {
  className?: string;
  ref?: Ref<AnimatedIconHandle>;
  size: number;
  testId?: string;
}) {
  return (
    <LoaderIcon
      aria-hidden="true"
      className={cn('running-indicator', className)}
      data-testid={testId}
      ref={ref}
      size={size}
    />
  );
}
