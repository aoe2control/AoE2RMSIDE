import { Check } from 'lucide-react';
import type { ComponentProps } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type OwnedButtonProps = Omit<
  ComponentProps<typeof Button>,
  'aria-checked' | 'aria-pressed' | 'role' | 'variant'
>;

type ToggleDensity = 'default' | 'compact';

function toggleButtonProps({
  checked,
  className,
  density = 'default',
  onKeyDown,
}: {
  checked: boolean;
  className?: string;
  density?: ToggleDensity;
  onKeyDown?: OwnedButtonProps['onKeyDown'];
}) {
  const handleKeyDown: NonNullable<OwnedButtonProps['onKeyDown']> = (event) => {
    onKeyDown?.(event);
    if (event.key === ' ') event.stopPropagation();
  };
  return {
    'aria-checked': checked,
    className: cn('toggle-button toggle-button-wide', className),
    'data-density': density,
    onKeyDown: handleKeyDown,
    role: 'checkbox',
    size: density === 'compact' ? 'sm' : 'default',
    type: 'button',
    variant: 'ghost',
  } as const;
}

function ToggleButtonCheck({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden="true" className="toggle-button-check">
      {checked ? <Check /> : null}
    </span>
  );
}

function ToggleButton({
  check = true,
  checked,
  children,
  className,
  density,
  onKeyDown,
  ...props
}: Omit<OwnedButtonProps, 'className' | 'size'> & {
  check?: boolean;
  checked: boolean;
  className?: string;
  density?: ToggleDensity;
}) {
  return (
    <Button {...toggleButtonProps({ checked, className, density, onKeyDown })} {...props}>
      {children}
      {check ? <ToggleButtonCheck checked={checked} /> : null}
    </Button>
  );
}

function IconToggleButton({
  className,
  pressed,
  ...props
}: OwnedButtonProps & {
  pressed: boolean;
}) {
  return (
    <Button
      aria-pressed={pressed}
      className={cn('toggle-button', className)}
      type="button"
      variant="ghost"
      {...props}
    />
  );
}

export { IconToggleButton, ToggleButton, ToggleButtonCheck, toggleButtonProps };
