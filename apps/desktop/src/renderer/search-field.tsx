import {
  useLayoutEffect,
  useRef,
  useState,
  type AriaAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
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
  actions,
  className,
  clearLabel,
  combobox,
  disabled = false,
  inputRef,
  label,
  maxLength,
  onFocusWithinChange,
  onKeyDown,
  onValueChange,
  placeholder,
  selectOnFocusClick = false,
  value,
  variant = 'chrome',
}: {
  actions?: ReactNode;
  className?: string;
  clearLabel: string;
  combobox?: {
    controls: string;
    activeDescendant: string | undefined;
    autocomplete?: AriaAttributes['aria-autocomplete'];
  };
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  label: string;
  maxLength?: number;
  onFocusWithinChange?(focused: boolean): void;
  onKeyDown?(event: KeyboardEvent<HTMLInputElement>): void;
  onValueChange(value: string): void;
  placeholder?: string;
  selectOnFocusClick?: boolean;
  value: string;
  variant?: 'chrome' | 'overlay';
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const focusWithin = useRef(false);
  const reportFocusWithin = (focused: boolean) => {
    if (focusWithin.current === focused) return;
    focusWithin.current = focused;
    onFocusWithinChange?.(focused);
  };
  useLayoutEffect(() => {
    const element = root.current;
    if (focusWithin.current && !element?.contains(element.ownerDocument.activeElement)) {
      reportFocusWithin(false);
    }
  });
  const focusingPress = useRef(false);
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
  const field = (
    <>
      <Input
        aria-activedescendant={combobox?.activeDescendant}
        aria-autocomplete={combobox ? (combobox.autocomplete ?? 'list') : undefined}
        aria-controls={combobox?.controls}
        aria-expanded={combobox ? true : undefined}
        aria-label={label}
        autoComplete="off"
        disabled={disabled}
        maxLength={maxLength}
        onBlur={(event) => {
          event.currentTarget.scrollLeft = 0;
        }}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={onKeyDown}
        onMouseDown={
          selectOnFocusClick
            ? (event) => {
                focusingPress.current =
                  event.button === 0 &&
                  event.currentTarget.ownerDocument.activeElement !== event.currentTarget;
              }
            : undefined
        }
        onMouseUp={
          selectOnFocusClick
            ? (event) => {
                const element = event.currentTarget;
                const focusing = focusingPress.current;
                focusingPress.current = false;
                if (focusing && element.selectionStart === element.selectionEnd) element.select();
              }
            : undefined
        }
        placeholder={placeholder}
        role={combobox ? 'combobox' : undefined}
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
    </>
  );
  return (
    <div
      className={cn('search-field', className)}
      data-clearable={clearable || undefined}
      data-disabled={disabled || undefined}
      data-has-actions={actions ? true : undefined}
      data-has-value={value.length > 0 || undefined}
      data-variant={variant}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          reportFocusWithin(false);
        }
      }}
      onFocus={() => reportFocusWithin(true)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      ref={root}
    >
      <Search aria-hidden="true" className="search-field-icon" />
      {actions ? (
        <>
          <div className="search-field-text">{field}</div>
          <div className="search-field-actions">{actions}</div>
        </>
      ) : (
        field
      )}
    </div>
  );
}
