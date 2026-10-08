import { useRef } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ExecutionProgressBar, useExecutionProgressBar } from './execution-progress-bar';
import { useI18n } from './i18n';
import {
  liveTestProgressDetail,
  liveTestProgressPercent,
  liveTestProgressWord,
  type LiveTestProgress,
} from './live-test-progress';
import { usePrefersReducedMotion } from './motion';

export function LiveTestProgressBar({ progress }: { progress: LiveTestProgress }) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  const bar = useExecutionProgressBar(progress.phase, reducedMotion);
  const last = useRef(progress);
  if (progress.phase !== 'idle') last.current = progress;
  if (!bar.shown) return null;
  const shown = last.current;
  const detail = liveTestProgressDetail(shown);
  const percent = liveTestProgressPercent(shown);
  return (
    <Tooltip disableHoverablePopup>
      <TooltipTrigger
        delay={0}
        render={
          <span
            aria-label={t('live-test.progress.label')}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={percent}
            aria-valuetext={detail}
            className="game-art-conversion-progress live-test-progress"
            data-fading={bar.fading || undefined}
            data-step={shown.step}
            data-testid="live-test-progress"
            role="progressbar"
            tabIndex={0}
          />
        }
      >
        <span
          aria-hidden="true"
          className="game-art-conversion-action"
          data-testid="live-test-progress-action"
        >
          {liveTestProgressWord(shown)}
        </span>
        <ExecutionProgressBar
          fading={bar.fading}
          identity={`live-test-${shown.run}`}
          onFadeEnd={bar.onFadeEnd}
          percent={percent}
        />
      </TooltipTrigger>
      <TooltipContent
        className="game-art-conversion-tooltip"
        data-testid="live-test-progress-tooltip"
      >
        {detail}
      </TooltipContent>
    </Tooltip>
  );
}
