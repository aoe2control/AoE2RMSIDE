import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface SegmentedControlOption<Value extends string> {
  value: Value;
  label: ReactNode;
}

function SegmentedControl<Value extends string>({
  className,
  label,
  onValueChange,
  options,
  value,
  ...props
}: {
  className?: string;
  label?: string;
  'aria-labelledby'?: string;
  onValueChange(value: Value): void;
  options: readonly SegmentedControlOption<Value>[];
  value: Value;
  'data-testid'?: string;
}) {
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  return (
    <RadioGroup<Value>
      aria-label={label}
      className={cn('segmented-control', className)}
      data-slot="segmented-control"
      onValueChange={(next) => onValueChange(next)}
      style={
        {
          '--segmented-control-count': options.length,
          '--segmented-control-index': index,
        } as CSSProperties
      }
      value={value}
      {...props}
    >
      <span aria-hidden="true" className="segmented-control-indicator" />
      {options.map((option) => (
        <Radio.Root<Value>
          className="segmented-control-item"
          data-slot="segmented-control-item"
          key={option.value}
          nativeButton
          render={<button type="button" />}
          value={option.value}
        >
          {option.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

export { SegmentedControl, type SegmentedControlOption };
