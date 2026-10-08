import { useCallback, useEffect, useRef, useState } from 'react';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { type ExecutionBarPhase, nextExecutionBarFade } from './execution-profiler';

export const executionBarFadeMs = 420;
const fadeAnimation = 'execution-progress-fade-out';
const fadeFallbackMs = executionBarFadeMs + 200;

export function useExecutionProgressBar(
  phase: ExecutionBarPhase,
  reducedMotion: boolean,
): { shown: boolean; fading: boolean; onFadeEnd(): void } {
  const [fading, setFading] = useState(false);
  const previous = useRef(phase);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const was = previous.current;
    previous.current = phase;
    const change = nextExecutionBarFade(was, phase, reducedMotion);
    if (change === 'keep') return;
    window.clearTimeout(timer.current);
    setFading(change === 'fade');
    if (change === 'fade') {
      timer.current = window.setTimeout(() => setFading(false), fadeFallbackMs);
    }
  }, [phase, reducedMotion]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onFadeEnd = useCallback(() => {
    window.clearTimeout(timer.current);
    setFading(false);
  }, []);
  return { shown: phase === 'running' || fading, fading, onFadeEnd };
}

export function ExecutionProgressBar({
  className,
  fading,
  identity,
  onFadeEnd,
  percent,
}: {
  className?: string;
  fading: boolean;
  identity: string;
  onFadeEnd(): void;
  percent: number;
}) {
  return (
    <Progress
      aria-hidden="true"
      className={cn('execution-progress-bar', className)}
      data-fading={fading}
      key={identity}
      onAnimationEnd={(event) => {
        if (
          fading &&
          event.target === event.currentTarget &&
          event.animationName === fadeAnimation
        ) {
          onFadeEnd();
        }
      }}
      value={percent}
    />
  );
}
