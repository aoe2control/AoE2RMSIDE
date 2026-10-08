import { useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { XIcon } from '@animateicons/react/lucide';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { type AnimatedIconHandle, playIconAnimation } from './animated-icon';

export function searchFieldClearShown(state: {
  clearable: boolean;
  hovered: boolean;
  clearFocused: boolean;
}): boolean {
  return state.clearable && (state.hovered || state.clearFocused);
}

export function SearchField({
  className,
  clearLabel,
  disabled = false,
  inputRef,
  label,
  maxLength,
  onKeyDown,
  onValueChange,
  placeholder,
  value,
  variant = 'chrome',
}: {
  className?: string;
  clearLabel: string;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  label: string;
  maxLength?: number;
  onKeyDown?(event: KeyboardEvent<HTMLInputElement>): void;
  onValueChange(value: string): void;
  placeholder?: string;
  value: string;
  variant?: 'chrome' | 'overlay';
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const clearIcon = useRef<AnimatedIconHandle>(null);
  const [hovered, setHovered] = useState(false);
  const [clearFocused, setClearFocused] = useState(false);
  const clearable = value.length > 0 && !disabled;
  const clearShown = searchFieldClearShown({ clearable, hovered, clearFocused });
  const clearWasShown = useRef(clearShown);
  useLayoutEffect(() => {
    if (clearShown && !clearWasShown.current) playIconAnimation(clearIcon.current);
    if (!clearShown) clearIcon.current?.stopAnimation();
    clearWasShown.current = clearShown;
  }, [clearShown]);
  return (
    <div
      className={cn('search-field', className)}
      data-clearable={clearable || undefined}
      data-disabled={disabled || undefined}
      data-has-value={value.length > 0 || undefined}
      data-variant={variant}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <Search aria-hidden="true" className="search-field-icon" />
      <Input
        aria-label={label}
        autoComplete="off"
        disabled={disabled}
        maxLength={maxLength}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        ref={(element: HTMLInputElement | null) => {
          input.current = element;
          if (typeof inputRef === 'function') inputRef(element);
          else if (inputRef) inputRef.current = element;
        }}
        spellCheck={false}
        value={value}
      />
      {clearable ? (
        <Button
          aria-label={clearLabel}
          className="search-field-clear"
          onBlur={() => setClearFocused(false)}
          onClick={() => {
            onValueChange('');
            input.current?.focus({ preventScroll: true });
          }}
          onFocus={(event) => setClearFocused(event.currentTarget.matches(':focus-visible'))}
          onMouseDown={(event) => event.preventDefault()}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <XIcon aria-hidden="true" duration={0.25} ref={clearIcon} size={10} />
        </Button>
      ) : null}
    </div>
  );
}
