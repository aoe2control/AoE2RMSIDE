import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import type { CSSProperties, ReactNode } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface SegmentedControlOption<Value extends string> {
  value: Value;
  label: ReactNode;
  tooltip?: ReactNode;
}

function SegmentedControl<Value extends string>({
  backdrop,
  className,
  label,
  onValueChange,
  options,
  value,
  ...props
}: {
  backdrop?: ReactNode;
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
      data-value={value}
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
      {backdrop ? (
        <span aria-hidden="true" className="segmented-control-backdrop">
          {backdrop}
        </span>
      ) : null}
      <span aria-hidden="true" className="segmented-control-indicator" />
      {options.map((option) => {
        const button = <button type="button" />;
        const item = (
          <Radio.Root<Value>
            className="segmented-control-item"
            data-slot="segmented-control-item"
            key={option.value}
            nativeButton
            render={option.tooltip === undefined ? button : <TooltipTrigger render={button} />}
            value={option.value}
          >
            {option.label}
          </Radio.Root>
        );
        if (option.tooltip === undefined) return item;
        return (
          <Tooltip key={option.value}>
            {item}
            <TooltipContent>{option.tooltip}</TooltipContent>
          </Tooltip>
        );
      })}
    </RadioGroup>
  );
}

export { SegmentedControl, type SegmentedControlOption };
