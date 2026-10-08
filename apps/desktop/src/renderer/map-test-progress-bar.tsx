import { useRef } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { presentMapTestProgress } from '../shared/message-catalog';
import { ExecutionProgressBar, useExecutionProgressBar } from './execution-progress-bar';
import { useI18n } from './i18n';
import {
  mapTestProgressPercent,
  useMapTestProgress,
  type MapTestProgressStore,
} from './map-test-progress';
import { usePrefersReducedMotion } from './motion';

export function MapTestProgressBar({ store }: { store: MapTestProgressStore }) {
  const { t } = useI18n();
  const progress = useMapTestProgress(store);
  const reducedMotion = usePrefersReducedMotion();
  const bar = useExecutionProgressBar(progress.phase, reducedMotion);
  const last = useRef(progress);
  if (progress.phase !== 'idle') last.current = progress;
  if (!bar.shown) return null;
  const shown = last.current;
  const percent = mapTestProgressPercent(shown);
  const { word, detail } = presentMapTestProgress({ ...shown, percent });
  return (
    <Tooltip disableHoverablePopup>
      <TooltipTrigger
        delay={0}
        render={
          <span
            aria-label={t('run-menu.map-test-progress.label')}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={percent}
            aria-valuetext={detail}
            className="game-art-conversion-progress map-test-progress"
            data-completed={shown.completed}
            data-fading={bar.fading || undefined}
            data-requested={shown.requested}
            data-testid="map-test-progress"
            role="progressbar"
            tabIndex={0}
          />
        }
      >
        <span
          aria-hidden="true"
          className="game-art-conversion-action"
          data-testid="map-test-progress-action"
        >
          {word}
        </span>
        <ExecutionProgressBar
          fading={bar.fading}
          identity={`map-test-${shown.run}`}
          onFadeEnd={bar.onFadeEnd}
          percent={percent}
        />
      </TooltipTrigger>
      <TooltipContent
        className="game-art-conversion-tooltip"
        data-testid="map-test-progress-tooltip"
      >
        {detail}
      </TooltipContent>
    </Tooltip>
  );
}
