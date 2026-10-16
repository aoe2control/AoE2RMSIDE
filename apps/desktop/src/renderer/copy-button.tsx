import { CheckIcon as AnimatedCheckIcon } from '@animateicons/react/lucide';
import { Copy } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type Ref,
} from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { playIconAnimation, type AnimatedIconHandle } from './animated-icon';
import { CopyFeedback } from './copy-feedback';

export interface CopyFeedbackState {
  copied: boolean;
  checkRef: Ref<AnimatedIconHandle>;
  run(copy: () => Promise<void>, onFailure?: (error: unknown) => void): Promise<boolean>;
  reset(): void;
}

export function useCopyFeedback(resetKey?: unknown): CopyFeedbackState {
  const [copied, setCopied] = useState(false);
  const checkRef = useRef<AnimatedIconHandle>(null);
  const feedback = useRef<CopyFeedback | null>(null);
  feedback.current ??= new CopyFeedback(setCopied);
  useEffect(() => () => feedback.current?.dispose(), []);
  useEffect(() => feedback.current?.reset(), [resetKey]);
  useLayoutEffect(() => {
    if (copied) playIconAnimation(checkRef.current);
  }, [copied]);
  const run = useCallback(
    (copy: () => Promise<void>, onFailure?: (error: unknown) => void) =>
      feedback.current!.run(copy, onFailure),
    [],
  );
  const reset = useCallback(() => feedback.current!.reset(), []);
  return { copied, checkRef, run, reset };
}

export function CopyFeedbackIcon({
  checkRef,
  copied,
  size = 14,
}: {
  checkRef: Ref<AnimatedIconHandle>;
  copied: boolean;
  size?: number;
}) {
  return copied ? (
    <AnimatedCheckIcon aria-hidden="true" ref={checkRef} size={size} />
  ) : (
    <Copy aria-hidden="true" size={size} />
  );
}

export function CopyButton({
  className,
  copiedLabel,
  disabled = false,
  label,
  onCopy,
  onFailure,
  resetKey,
  size,
  testId,
  tooltipClassName,
  variant,
}: {
  className?: string;
  copiedLabel: string;
  disabled?: boolean;
  label: string;
  onCopy(): Promise<void>;
  onFailure?(error: unknown): void;
  resetKey?: unknown;
  size: 'icon-sm' | 'icon-compact';
  testId?: string;
  tooltipClassName?: string;
  variant: 'ghost' | 'secondary';
}) {
  const { checkRef, copied, run } = useCopyFeedback(resetKey);
  const busy = useRef(false);
  const copy = async (event: MouseEvent) => {
    event.stopPropagation();
    if (busy.current) return;
    busy.current = true;
    try {
      await run(onCopy, onFailure);
    } finally {
      busy.current = false;
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={copied ? copiedLabel : label}
            className={className}
            data-copied={copied || undefined}
            data-testid={testId}
            disabled={disabled}
            onClick={(event: MouseEvent) => void copy(event)}
            size={size}
            type="button"
            variant={variant}
          />
        }
      >
        <CopyFeedbackIcon checkRef={checkRef} copied={copied} />
      </TooltipTrigger>
      <TooltipContent className={tooltipClassName}>{label}</TooltipContent>
    </Tooltip>
  );
}
