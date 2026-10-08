import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Gauge } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type {
  ExecutionCostSummary,
  ExecutionGroupId,
  ExecutionStepId,
} from '../shared/execution-cost';
import { ExecutionProgressBar, useExecutionProgressBar } from './execution-progress-bar';
import { useKeyboardNavigationFocus } from './keyboard-focus';
import { layoutScrollHeight, ListMotion } from './list-motion';
import { presenceProps, usePrefersReducedMotion, usePresence } from './motion';
import { OverflowingLabel } from './overflow-label';
import {
  type ChartMotion,
  describeStepCounters,
  drawnSegmentFractions,
  type ExecutionProfilerStore,
  formatDuration,
  formatPercent,
  formatSeconds,
  groupLabel,
  isCachedPreview,
  isScrolledToBottom,
  nextChartMotion,
  nextDisplayedDurationUs,
  pendingRowKeyFor,
  pendingRowLabel,
  phaseElapsedText,
  profilerAccessibleStatus,
  profilerBarKey,
  profilerBarPercent,
  profilerBarPhase,
  profilerChartKey,
  profilerDisplay,
  profilerListIdentity,
  profilerPanelDescription,
  profilerRowName,
  profilerSegments,
  profilerTimeText,
  profilerTooltip,
  type ProfilerRow,
  provisionalDurationUs,
  rankedProfilerRows,
  stepLabel,
} from './execution-profiler';
import { useI18n } from './i18n';

const tooltipDelay = 0;

export function ExecutionProfiler({
  expanded,
  navbarHost,
  onExpandPreview,
  onOpenChange,
  open,
  store,
}: {
  expanded: boolean;
  navbarHost: HTMLElement | null;
  onExpandPreview(): void;
  onOpenChange(open: boolean): void;
  open: boolean;
  store: ExecutionProfilerStore;
}) {
  useI18n();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const run = snapshot.run;
  const reducedMotion = usePrefersReducedMotion();
  const display = profilerDisplay(
    run,
    snapshot.committed,
    isCachedPreview(snapshot.committed),
    performance.now(),
  );
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const focusAfterMove = useRef(false);

  const displayedDuration = useRef<{ key: string; value: number | null } | null>(null);
  useLayoutEffect(() => {
    if (!run || (run.anchorMs === null && run.startedMs === null)) return undefined;
    if (displayedDuration.current?.key !== run.key) {
      displayedDuration.current = { key: run.key, value: null };
    }
    const shown = displayedDuration.current;
    let frame = 0;
    const tick = () => {
      const live = run.status === 'running';
      shown.value = nextDisplayedDurationUs(
        shown.value,
        provisionalDurationUs(run, performance.now()),
        live,
      );
      const text = timeRef.current?.firstChild;
      if (text instanceof Text && shown.value !== null) text.nodeValue = formatSeconds(shown.value);
      if (live) frame = window.requestAnimationFrame(tick);
    };
    tick();
    return () => window.cancelAnimationFrame(frame);
  }, [run]);

  const bar = useExecutionProgressBar(profilerBarPhase(display.phase), reducedMotion);

  const keyboardFocus = useKeyboardNavigationFocus();
  useEffect(() => {
    if (!expanded || !focusAfterMove.current) return;
    focusAfterMove.current = false;
    buttonRef.current?.focus({ focusVisible: false });
  }, [expanded]);

  const toggle = useCallback(
    (event: { detail: number }) => {
      if (expanded) {
        onOpenChange(!open);
        return;
      }
      focusAfterMove.current = event.detail === 0;
      onOpenChange(true);
      onExpandPreview();
    },
    [expanded, onExpandPreview, onOpenChange, open],
  );

  const panelOpen = expanded && open;
  const panelPresence = usePresence(panelOpen && display.visible);

  if (!display.visible) return null;
  const running = display.phase === 'running';
  const barShown = bar.shown && expanded;
  const button = (
    <Tooltip>
      <TooltipTrigger
        delay={tooltipDelay}
        ref={buttonRef}
        render={
          <Button
            aria-controls={panelOpen ? panelId : undefined}
            aria-expanded={expanded ? open : false}
            aria-label={profilerAccessibleStatus(display)}
            className="preview-profiler-button"
            data-host={expanded ? 'preview' : 'navbar'}
            data-phase={display.phase ?? 'hidden'}
            data-testid="execution-profiler-button"
            onBlur={keyboardFocus.onBlur}
            onClick={toggle}
            onFocus={keyboardFocus.onFocus}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape' && panelOpen) {
                event.preventDefault();
                onOpenChange(false);
              }
            }}
            size="sm"
            type="button"
            variant="secondary"
          />
        }
      >
        {barShown ? (
          <ExecutionProgressBar
            fading={bar.fading}
            identity={profilerBarKey(run)}
            onFadeEnd={bar.onFadeEnd}
            percent={profilerBarPercent(display)}
          />
        ) : null}
        <span
          className="preview-profiler-time"
          data-testid="execution-profiler-time"
          key={running ? 'live' : 'final'}
          ref={timeRef}
        >
          {profilerTimeText(display)}
        </span>
        <Gauge
          aria-hidden="true"
          className="preview-profiler-icon"
          data-testid="execution-profiler-gauge"
        />
      </TooltipTrigger>
      <TooltipContent side={expanded ? 'left' : 'top'}>{profilerTooltip(display)}</TooltipContent>
    </Tooltip>
  );
  if (!expanded) {
    return navbarHost ? createPortal(button, navbarHost) : null;
  }
  return (
    <>
      <div className="preview-profiler-host">{button}</div>
      {panelPresence.mounted ? (
        <ExecutionProfilerPanel
          chartKey={profilerChartKey(snapshot)}
          closing={panelPresence.closing}
          id={panelId}
          onClose={() => {
            onOpenChange(false);
            buttonRef.current?.focus({ focusVisible: false });
          }}
          pending={display.pending}
          pendingGroup={display.pendingGroup}
          pendingStartMs={display.pendingStartMs}
          pendingStep={display.pendingStep}
          phase={display.phase}
          reducedMotion={reducedMotion}
          summary={display.summary}
          surfaceRef={panelPresence.ref}
        />
      ) : null}
    </>
  );
}

interface HighlightHandlers {
  hover(group: ExecutionGroupId | null): void;
  focus(group: ExecutionGroupId | null): void;
}

function ExecutionProfilerPanel({
  chartKey,
  closing,
  id,
  onClose,
  pending,
  pendingGroup,
  pendingStartMs,
  pendingStep,
  phase,
  reducedMotion,
  summary,
  surfaceRef,
}: {
  chartKey: string;
  closing: boolean;
  id: string;
  onClose(): void;
  pending: boolean;
  pendingGroup: ExecutionGroupId | null;
  pendingStartMs: number | null;
  pendingStep: ExecutionStepId | null;
  phase: ReturnType<typeof profilerDisplay>['phase'];
  reducedMotion: boolean;
  summary: ExecutionCostSummary | null;
  surfaceRef(element: HTMLElement | null): void;
}) {
  const { t } = useI18n();
  const [hoveredGroup, setHoveredGroup] = useState<ExecutionGroupId | null>(null);
  const [focusedGroup, setFocusedGroup] = useState<ExecutionGroupId | null>(null);
  const descriptionId = useId();
  const shell = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const ghosts = useRef<HTMLDivElement | null>(null);
  const followBottom = useRef(true);
  const rows = useMemo(() => (summary ? rankedProfilerRows(summary) : []), [summary]);
  const highlightedGroup = hoveredGroup ?? focusedGroup;
  const followIfPinned = useCallback(() => {
    const element = scroller.current;
    if (element && followBottom.current) {
      element.scrollTop = Math.max(0, layoutScrollHeight(element) - element.clientHeight);
    }
  }, []);
  const [listMotion] = useState(
    () =>
      new ListMotion({
        anchor: 'bottom',
        beforeMeasure: followIfPinned,
        ghostClassName: 'execution-profiler-ghost',
        ghostLayout: 'table-row',
        ghostOmittedAttributes: ['data-step'],
        keyAttribute: 'rowKey',
        rowSelector: 'tbody > tr[data-row-key]',
        stackByAppearance: true,
        valueSelector: '.execution-profiler-value',
      }),
  );

  const pendingRow = pending;
  const listIdentity = profilerListIdentity(rows, pendingRow, pendingGroup, pendingStep);
  useLayoutEffect(() => {
    followIfPinned();
    const shellElement = shell.current;
    const rowsElement = scroller.current;
    const ghostLayer = ghosts.current;
    if (!shellElement || !rowsElement || !ghostLayer) return;
    listMotion.update({ ghosts: ghostLayer, rows: rowsElement, shell: shellElement });
  }, [followIfPinned, listIdentity, listMotion]);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(followIfPinned);
    observer.observe(element);
    return () => observer.disconnect();
  }, [followIfPinned]);

  const highlightHandlers = useMemo<HighlightHandlers>(
    () => ({ hover: setHoveredGroup, focus: setFocusedGroup }),
    [],
  );
  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onClose();
  };

  return (
    <div
      aria-describedby={descriptionId}
      aria-label={t('profiler.panel.label')}
      className="execution-profiler-panel motion-surface"
      data-phase={phase ?? undefined}
      data-reduced-motion={reducedMotion}
      data-side="top"
      data-testid="execution-profiler-panel"
      id={id}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyDownCapture={onKeyDownCapture}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      ref={surfaceRef}
      role="region"
      tabIndex={-1}
      {...presenceProps(closing)}
    >
      <p className="sr-only" data-testid="execution-profiler-description" id={descriptionId}>
        {profilerPanelDescription(phase, summary?.context ?? null)}
      </p>
      <div
        className="execution-profiler-rows-shell"
        data-testid="execution-profiler-rows-shell"
        ref={shell}
      >
        <div
          aria-label={t('profiler.panel.steps')}
          className="execution-profiler-rows owned-scrollbars"
          data-testid="execution-profiler-rows"
          onScroll={(event) => {
            const list = event.currentTarget;
            const atBottom = isScrolledToBottom({
              clientHeight: list.clientHeight,
              scrollHeight: layoutScrollHeight(list),
              scrollTop: list.scrollTop,
            });
            if (atBottom || shell.current?.dataset.listMotion !== 'running') {
              followBottom.current = atBottom;
            }
          }}
          ref={scroller}
          role="group"
        >
          {rows.length === 0 && !pendingRow ? (
            <p className="execution-profiler-empty">{t('profiler.panel.empty')}</p>
          ) : (
            <Table aria-label={t('profiler.panel.table')} className="execution-profiler-table">
              <TableBody>
                {[
                  ...rows.map((row) => (
                    <StepRow highlightHandlers={highlightHandlers} key={row.step} row={row} />
                  )),
                  ...(pendingRow
                    ? [
                        <StepRow
                          highlightHandlers={highlightHandlers}
                          key={pendingRowKeyFor(pendingStep)}
                          pending={{
                            group: pendingGroup,
                            startMs: pendingStartMs,
                            step: pendingStep,
                          }}
                        />,
                      ]
                    : []),
                ]}
              </TableBody>
            </Table>
          )}
        </div>
        <div aria-hidden="true" className="execution-profiler-ghosts" inert ref={ghosts} />
      </div>
      <ExecutionProfilerChart
        highlightHandlers={highlightHandlers}
        highlightedGroup={highlightedGroup}
        key={chartKey}
        live={phase === 'running'}
        reducedMotion={reducedMotion}
        summary={summary}
      />
    </div>
  );
}

function ExecutionProfilerChart({
  highlightHandlers,
  highlightedGroup,
  live,
  reducedMotion,
  summary,
}: {
  highlightHandlers: HighlightHandlers;
  highlightedGroup: ExecutionGroupId | null;
  live: boolean;
  reducedMotion: boolean;
  summary: ExecutionCostSummary | null;
}) {
  const { t } = useI18n();
  const segments = useMemo(() => (summary ? profilerSegments(summary) : []), [summary]);
  const widths = useMemo(
    () => drawnSegmentFractions(segments, highlightedGroup),
    [highlightedGroup, segments],
  );
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setArmed(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const [motion, setMotion] = useState<ChartMotion>(live ? 'live' : 'rest');
  const nextMotion = nextChartMotion(motion, live);
  if (nextMotion !== motion) setMotion(nextMotion);
  const chartRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (motion !== 'continuing') return undefined;
    let active = true;
    const frame = window.requestAnimationFrame(() => {
      const animations = chartRef.current?.getAnimations({ subtree: true }) ?? [];
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        if (active) setMotion((current) => (current === 'continuing' ? 'rest' : current));
      });
    });
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
    };
  }, [motion]);
  return (
    <div
      aria-label={t('profiler.chart.label')}
      className="execution-profiler-chart"
      data-animate={armed && nextMotion !== 'rest' && !reducedMotion}
      data-motion={nextMotion}
      data-highlight={highlightedGroup ?? undefined}
      data-testid="execution-profiler-chart"
      ref={chartRef}
      role="group"
    >
      {segments.map((segment, index) => {
        const label = t('profiler.chart.segment', {
          group: groupLabel(segment.group),
          duration: formatDuration(segment.durationUs),
          percent: formatPercent(segment.percent),
        });
        return (
          <Tooltip key={segment.group}>
            <TooltipTrigger
              delay={tooltipDelay}
              render={
                <span
                  aria-label={label}
                  className="execution-profiler-segment"
                  data-group={segment.group}
                  data-highlighted={highlightedGroup === segment.group}
                  onBlur={() => highlightHandlers.focus(null)}
                  onFocus={(event) => {
                    if (event.currentTarget.matches(':focus-visible')) {
                      highlightHandlers.focus(segment.group);
                    }
                  }}
                  onPointerEnter={() => highlightHandlers.hover(segment.group)}
                  onPointerLeave={() => highlightHandlers.hover(null)}
                  role="img"
                  style={{ '--segment-width': `${widths[index]! * 100}%` } as CSSProperties}
                  tabIndex={segment.fraction < 0.01 ? -1 : 0}
                />
              }
            />
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function LiveDuration({ startMs }: { startMs: number }) {
  useI18n();
  const ref = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    const tick = () => {
      const text = ref.current?.firstChild;
      if (text instanceof Text) text.nodeValue = phaseElapsedText(startMs, performance.now());
      frame = window.requestAnimationFrame(tick);
    };
    tick();
    return () => window.cancelAnimationFrame(frame);
  }, [startMs]);
  return (
    <span
      className="execution-profiler-live-time"
      data-testid="execution-profiler-live-time"
      ref={ref}
    >
      {phaseElapsedText(startMs, performance.now())}
    </span>
  );
}

function StepRow({
  highlightHandlers,
  pending,
  row,
}: {
  highlightHandlers: HighlightHandlers;
  pending?: {
    group: ExecutionGroupId | null;
    startMs: number | null;
    step: ExecutionStepId | null;
  };
  row?: ProfilerRow;
}) {
  const { t } = useI18n();
  const workId = useId();
  const work = row && row.counters.length > 0 ? describeStepCounters(row.step, row.counters) : null;
  const workLines = work
    ? [work.specific, work.generic, work.explanation].filter(
        (line): line is string => line !== null,
      )
    : [];
  const group = row?.group ?? pending?.group ?? null;
  const step = row?.step ?? pending?.step ?? null;
  const value = (text: string | null) => (
    <span className="execution-profiler-value">
      {text ?? <span aria-hidden="true" className="execution-profiler-placeholder-bar" />}
    </span>
  );
  const cells = (
    <>
      <TableCell>
        <span
          aria-hidden="true"
          className="execution-profiler-swatch"
          data-group={group ?? undefined}
        />
      </TableCell>
      <TableCell className="execution-profiler-step">
        {step === null ? (
          <>
            <span aria-hidden="true" className="execution-profiler-placeholder-bar" />
            <span className="sr-only">{pendingRowLabel(group)}</span>
          </>
        ) : (
          <span aria-hidden={row ? undefined : 'true'} className="contents">
            <OverflowingLabel
              className="execution-profiler-step-label"
              name={stepLabel(step)}
              textClassName="execution-profiler-step-label-text"
            />
          </span>
        )}
        {row ? (
          workLines.length > 0 ? (
            <span className="sr-only" id={workId}>
              {t('message.format.sentence', {
                text: workLines.reduce((first, second) =>
                  t('profiler.row.work-join', { first, second }),
                ),
              })}
            </span>
          ) : null
        ) : step !== null ? (
          <span className="sr-only">{t('profiler.pending.step', { step: stepLabel(step) })}</span>
        ) : null}
      </TableCell>
      <TableCell className="execution-profiler-numeric">
        {row ? (
          value(formatDuration(row.durationUs))
        ) : pending?.startMs != null ? (
          <span className="execution-profiler-value" data-provisional="">
            <LiveDuration startMs={pending.startMs} />
          </span>
        ) : (
          value(null)
        )}
      </TableCell>
      <TableCell className="execution-profiler-numeric">
        {value(row ? formatPercent(row.percent) : null)}
      </TableCell>
    </>
  );
  const rowProps = row
    ? ({
        'aria-describedby': work ? workId : undefined,
        'aria-label': profilerRowName(row),
        className: 'execution-profiler-row',
        'data-group': row.group,
        'data-row-key': row.step,
        'data-step': row.step,
        onBlur: () => highlightHandlers.focus(null),
        onFocus: (event: ReactFocusEvent<HTMLTableRowElement>) => {
          if (event.currentTarget.matches(':focus-visible')) highlightHandlers.focus(row.group);
        },
        onPointerEnter: () => highlightHandlers.hover(row.group),
        onPointerLeave: () => highlightHandlers.hover(null),
        tabIndex: 0,
      } as const)
    : ({
        className: 'execution-profiler-row execution-profiler-placeholder',
        'data-group': group ?? undefined,
        'data-pending-step': step ?? undefined,
        'data-row-key': pendingRowKeyFor(step),
        'data-testid': 'execution-profiler-placeholder',
      } as const);
  return (
    <Tooltip>
      <TooltipTrigger delay={tooltipDelay} render={<TableRow {...rowProps} />}>
        {cells}
      </TooltipTrigger>
      <TooltipContent side="left">
        <div className="execution-profiler-work" data-testid="execution-profiler-work">
          <span className="execution-profiler-work-group">
            {group === null ? pendingRowLabel(null) : groupLabel(group)}
          </span>
          {work?.specific ? <span>{work.specific}</span> : null}
          {work?.generic ? <span>{work.generic}</span> : null}
          {work?.explanation ? (
            <span className="execution-profiler-work-note">{work.explanation}</span>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
