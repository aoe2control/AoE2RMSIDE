import { useEffect, useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  gameArtConversionProgress,
  gameArtProgressAction,
  gameArtProgressDetail,
  type GameArtStatus,
} from '../shared/game-art';
import type { ExecutionBarPhase } from './execution-profiler';
import { ExecutionProgressBar, useExecutionProgressBar } from './execution-progress-bar';
import { useI18n } from './i18n';
import { usePrefersReducedMotion } from './motion';

export const gameArtProgressDelayMilliseconds = 300;

export function GameArtConversionProgress({ status }: { status: GameArtStatus }) {
  const { t } = useI18n();
  const progress = gameArtConversionProgress(status);
  const converting = progress !== null;
  const [due, setDue] = useState(false);
  const ran = useRef(false);
  useEffect(() => {
    if (!converting) {
      setDue(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setDue(true), gameArtProgressDelayMilliseconds);
    return () => window.clearTimeout(timer);
  }, [converting]);
  const phase: ExecutionBarPhase =
    converting && due ? 'running' : ran.current && status.state === 'ready' ? 'completed' : 'idle';
  ran.current = phase !== 'idle';
  const reducedMotion = usePrefersReducedMotion();
  const bar = useExecutionProgressBar(phase, reducedMotion);
  const identity = useRef(0);
  const previousPhase = useRef<ExecutionBarPhase>('idle');
  if (phase === 'running' && previousPhase.current !== 'running') identity.current += 1;
  previousPhase.current = phase;
  const last = useRef(progress);
  if (progress) last.current = progress;
  if (!bar.shown || !last.current) return null;
  const action = gameArtProgressAction(last.current);
  const detail = gameArtProgressDetail(last.current);
  const percent = phase === 'running' ? Math.round(last.current.fraction * 100) : 100;
  return (
    <Tooltip disableHoverablePopup>
      <TooltipTrigger
        delay={0}
        render={
          <span
            aria-label={t('game-art.progress.label')}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={percent}
            aria-valuetext={detail}
            className="game-art-conversion-progress"
            data-fading={bar.fading || undefined}
            data-phase={last.current.phase}
            data-testid="game-art-conversion-progress"
            data-what={last.current.what}
            role="progressbar"
            tabIndex={0}
          />
        }
      >
        <span
          aria-hidden="true"
          className="game-art-conversion-action"
          data-testid="game-art-conversion-action"
        >
          {action}
        </span>
        <ExecutionProgressBar
          fading={bar.fading}
          identity={`game-art-${identity.current}`}
          onFadeEnd={bar.onFadeEnd}
          percent={percent}
        />
      </TooltipTrigger>
      <TooltipContent
        className="game-art-conversion-tooltip"
        data-testid="game-art-conversion-tooltip"
      >
        {detail}
      </TooltipContent>
    </Tooltip>
  );
}
