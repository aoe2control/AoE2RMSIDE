import {
  executionGroupIds,
  executionStepGroup,
  executionStepIds,
  type ExecutionCostCounter,
  type ExecutionCostGroup,
  type ExecutionCostStep,
  type ExecutionCostSummary,
  type ExecutionCounterId,
  type ExecutionGroupId,
  type ExecutionProgressEvent,
  type ExecutionStepId,
} from '../shared/execution-cost';
import type { PreviewGenerationResult } from '../shared/api';
import { activeTranslator, t, type MessageId } from '../shared/i18n/translator';

const groupLabelIds: Readonly<Record<ExecutionGroupId, MessageId>> = {
  parse: 'profiler.group.parse',
  setup: 'profiler.group.setup',
  land: 'profiler.group.land',
  elevation: 'profiler.group.elevation',
  cliffs: 'profiler.group.cliffs',
  terrain: 'profiler.group.terrain',
  connections: 'profiler.group.connections',
  objects: 'profiler.group.objects',
  finalize: 'profiler.group.finalize',
};

const stepLabelIds: Readonly<Record<ExecutionStepId, MessageId>> = {
  'parse.script': 'profiler.step.parse-script',
  'setup.players': 'profiler.step.setup-players',
  'land.generate': 'profiler.step.land-generate',
  'elevation.generate': 'profiler.step.elevation-generate',
  'cliffs.generate': 'profiler.step.cliffs-generate',
  'terrain.generate': 'profiler.step.terrain-generate',
  'connections.generate': 'profiler.step.connections-generate',
  'objects.generate': 'profiler.step.objects-generate',
  'finalize.game-mode': 'profiler.step.finalize-game-mode',
  'finalize.object-order': 'profiler.step.finalize-object-order',
  'finalize.composite-terrain': 'profiler.step.finalize-composite-terrain',
};

export function groupLabel(group: ExecutionGroupId): string {
  return t(groupLabelIds[group]);
}

export function stepLabel(step: ExecutionStepId): string {
  return t(stepLabelIds[step]);
}

export type CounterNoun = MessageId;

export const counterNouns: Readonly<Record<ExecutionCounterId, CounterNoun>> = {
  operations: 'profiler.counter.operations',
  'rng-draws': 'profiler.counter.rng-draws',
  'candidates-examined': 'profiler.counter.candidates-examined',
  'tiles-accepted': 'profiler.counter.tiles-accepted',
  'path-searches': 'profiler.counter.path-searches',
  'path-work': 'profiler.counter.path-work',
  'placement-rejections': 'profiler.counter.placement-rejections',
  'objects-placed': 'profiler.counter.objects-placed',
};

export interface StepCounterWording {
  counters: readonly { counter: ExecutionCounterId; noun: CounterNoun }[];
  explanation: MessageId;
}

export const stepCounterWording: Readonly<Partial<Record<ExecutionStepId, StepCounterWording>>> = {
  'land.generate': {
    counters: [
      { counter: 'candidates-examined', noun: 'profiler.counter.land.candidates-examined' },
      { counter: 'tiles-accepted', noun: 'profiler.counter.land.tiles-accepted' },
    ],
    explanation: 'profiler.counter.land.explanation',
  },
  'elevation.generate': {
    counters: [
      { counter: 'candidates-examined', noun: 'profiler.counter.elevation.candidates-examined' },
      { counter: 'tiles-accepted', noun: 'profiler.counter.elevation.tiles-accepted' },
    ],
    explanation: 'profiler.counter.elevation.explanation',
  },
  'cliffs.generate': {
    counters: [
      { counter: 'candidates-examined', noun: 'profiler.counter.cliffs.candidates-examined' },
    ],
    explanation: 'profiler.counter.cliffs.explanation',
  },
  'connections.generate': {
    counters: [
      { counter: 'path-searches', noun: 'profiler.counter.connections.path-searches' },
      { counter: 'path-work', noun: 'profiler.counter.connections.path-work' },
      { counter: 'tiles-accepted', noun: 'profiler.counter.connections.tiles-accepted' },
    ],
    explanation: 'profiler.counter.connections.explanation',
  },
  'objects.generate': {
    counters: [
      { counter: 'candidates-examined', noun: 'profiler.counter.objects.candidates-examined' },
      { counter: 'placement-rejections', noun: 'profiler.counter.objects.placement-rejections' },
      { counter: 'objects-placed', noun: 'profiler.counter.objects.objects-placed' },
    ],
    explanation: 'profiler.counter.objects.explanation',
  },
};

export interface ProfilerRun {
  key: string;
  requestId: string | null;
  startedMs: number | null;
  plan: readonly ExecutionStepId[] | null;
  steps: readonly ExecutionCostStep[];
  measuredTotalUs: number;
  anchorMs: number | null;
  status: 'running' | 'completed';
  final: ExecutionCostSummary | null;
}

export interface ProfilerSnapshot {
  run: ProfilerRun | null;
  committed: PreviewGenerationResult | null;
  continuedRunId: string | null;
}

export class ExecutionProfilerStore {
  private snapshot: ProfilerSnapshot = { run: null, committed: null, continuedRunId: null };
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ProfilerSnapshot => this.snapshot;

  anticipate(key: string, nowMs: number): void {
    this.publish({
      ...this.snapshot,
      run: newRun(key, null, nowMs),
      continuedRunId: null,
    });
  }

  begin(requestId: string, key?: string, nowMs?: number): void {
    const run = this.snapshot.run;
    if (key !== undefined && run?.key === key && run.requestId === null) {
      this.publish({ ...this.snapshot, run: { ...run, requestId } });
      return;
    }
    this.publish({
      ...this.snapshot,
      run: newRun(key ?? requestId, requestId, nowMs ?? null),
      continuedRunId: null,
    });
  }

  progress(event: ExecutionProgressEvent, nowMs: number): void {
    const run = this.snapshot.run;
    if (!run || run.requestId !== event.requestId || run.status !== 'running') return;
    if (event.kind === 'started') {
      if (run.plan !== null) return;
      this.publish({ ...this.snapshot, run: { ...run, plan: event.plan, anchorMs: nowMs } });
      return;
    }
    if (
      run.plan === null ||
      event.completedSteps !== run.steps.length + 1 ||
      run.plan[run.steps.length] !== event.step.step ||
      event.measuredTotalUs < run.measuredTotalUs
    ) {
      return;
    }
    this.publish({
      ...this.snapshot,
      run: {
        ...run,
        steps: [...run.steps, event.step],
        measuredTotalUs: event.measuredTotalUs,
        anchorMs: nowMs,
      },
    });
  }

  complete(requestId: string, summary: ExecutionCostSummary | null = null): void {
    const run = this.snapshot.run;
    if (!run || run.requestId !== requestId || run.status !== 'running') return;
    this.publish({ ...this.snapshot, run: { ...run, status: 'completed', final: summary } });
  }

  settle(result: PreviewGenerationResult | null): void {
    const run = this.snapshot.run;
    const continued =
      run !== null &&
      run.status === 'completed' &&
      result !== null &&
      (result.executionCost ?? null) === run.final;
    this.publish({
      run: null,
      committed: result,
      continuedRunId: continued ? run.key : null,
    });
  }

  end(identity?: string): void {
    const run = this.snapshot.run;
    if (!run || (identity !== undefined && run.key !== identity && run.requestId !== identity)) {
      return;
    }
    this.publish({ ...this.snapshot, run: null, continuedRunId: null });
  }

  private publish(snapshot: ProfilerSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}

function newRun(key: string, requestId: string | null, startedMs: number | null): ProfilerRun {
  return {
    key,
    requestId,
    startedMs,
    plan: null,
    steps: [],
    measuredTotalUs: 0,
    anchorMs: null,
    status: 'running',
    final: null,
  };
}

const cachedPreviewResults = new WeakSet<PreviewGenerationResult>();

export function markCachedPreview(result: PreviewGenerationResult): PreviewGenerationResult {
  cachedPreviewResults.add(result);
  return result;
}

export function isCachedPreview(result: PreviewGenerationResult | null): boolean {
  return result !== null && cachedPreviewResults.has(result);
}

export type ProfilerPhase = 'running' | 'committed' | 'cached' | 'unsupported';

export interface ProfilerDisplay {
  visible: boolean;
  phase: ProfilerPhase | null;
  fraction: number | null;
  completedSteps: number;
  planLength: number | null;
  durationUs: number | null;
  summary: ExecutionCostSummary | null;
  pending: boolean;
  pendingGroup: ExecutionGroupId | null;
  pendingStep: ExecutionStepId | null;
  pendingStartMs: number | null;
}

export function profilerDisplay(
  run: ProfilerRun | null,
  committed: PreviewGenerationResult | null,
  cached: boolean,
  nowMs: number,
): ProfilerDisplay {
  if (run) {
    const planLength = run.plan?.length ?? null;
    return {
      visible: true,
      phase: 'running',
      fraction: runFraction(run),
      completedSteps: run.steps.length,
      planLength,
      durationUs: provisionalDurationUs(run, nowMs),
      summary: run.final ?? liveSummary(run),
      pending: runPending(run),
      pendingGroup: pendingStepGroup(run),
      pendingStep: pendingStep(run),
      pendingStartMs: runPending(run) ? pendingPhaseStartMs(run) : null,
    };
  }
  if (!committed) {
    return {
      visible: false,
      phase: null,
      fraction: null,
      completedSteps: 0,
      planLength: null,
      durationUs: null,
      summary: null,
      pending: false,
      pendingGroup: null,
      pendingStep: null,
      pendingStartMs: null,
    };
  }
  const summary = committed.executionCost ?? null;
  const stepCount = summary?.groups.reduce((total, group) => total + group.steps.length, 0) ?? 0;
  return {
    visible: true,
    phase: summary ? (cached ? 'cached' : 'committed') : 'unsupported',
    fraction: summary ? 1 : null,
    completedSteps: stepCount,
    planLength: summary ? stepCount : null,
    durationUs: summary?.totalUs ?? null,
    summary,
    pending: false,
    pendingGroup: null,
    pendingStep: null,
    pendingStartMs: null,
  };
}

export function runFraction(run: ProfilerRun): number | null {
  if (run.plan === null) return null;
  if (run.status === 'completed') return 1;
  return Math.min(1, run.steps.length / Math.max(1, run.plan.length));
}

export function runPending(run: ProfilerRun): boolean {
  if (run.status !== 'running') return false;
  return run.plan === null || run.steps.length < run.plan.length;
}

export function pendingPhaseStartMs(run: ProfilerRun): number | null {
  if (run.status !== 'running') return null;
  if (run.steps.length > 0) return run.anchorMs;
  return run.startedMs ?? run.anchorMs;
}

export function phaseElapsedText(startMs: number, nowMs: number): string {
  return formatDuration(Math.max(0, nowMs - startMs) * 1000);
}

export function pendingStep(run: ProfilerRun): ExecutionStepId | null {
  if (run.status !== 'running' || run.plan === null) return null;
  return run.plan[run.steps.length] ?? null;
}

export function pendingStepGroup(run: ProfilerRun): ExecutionGroupId | null {
  const step = pendingStep(run);
  return step === null ? null : executionStepGroup(step);
}

export function pendingRowLabel(group: ExecutionGroupId | null): string {
  return group === null
    ? t('profiler.pending.waiting')
    : t('profiler.pending.group', { group: groupLabel(group) });
}

export const pendingRowKey = 'pending';

export function pendingRowKeyFor(step: ExecutionStepId | null): string {
  return step ?? pendingRowKey;
}

export function profilerListIdentity(
  rows: readonly ProfilerRow[],
  pending: boolean,
  pendingGroup: ExecutionGroupId | null,
  pendingStep: ExecutionStepId | null,
): string {
  const listed = rows.map(
    (row) => `${row.step}:${formatDuration(row.durationUs)}:${formatPercent(row.percent)}`,
  );
  if (pending) listed.push(`${pendingRowKey}:${pendingGroup ?? ''}:${pendingStep ?? ''}`);
  return listed.join('|');
}

export function profilerChartKey(snapshot: ProfilerSnapshot): string {
  const identity = snapshot.run?.key ?? snapshot.continuedRunId;
  return identity === null ? 'settled' : `run:${identity}`;
}

export type ChartMotion = 'live' | 'continuing' | 'rest';

export function nextChartMotion(current: ChartMotion, live: boolean): ChartMotion {
  if (live) return 'live';
  return current === 'live' ? 'continuing' : current;
}

export function provisionalDurationUs(run: ProfilerRun, nowMs: number): number | null {
  if (run.status === 'completed') {
    return run.final?.totalUs ?? (run.anchorMs === null ? null : run.measuredTotalUs);
  }
  if (run.anchorMs === null) {
    return run.startedMs === null ? null : Math.max(0, nowMs - run.startedMs) * 1000;
  }
  return run.measuredTotalUs + Math.max(0, nowMs - run.anchorMs) * 1000;
}

export function liveSummary(run: ProfilerRun): ExecutionCostSummary | null {
  if (run.steps.length === 0) return null;
  const groups: ExecutionCostGroup[] = [];
  for (const step of run.steps) {
    const group = executionStepGroup(step.step);
    const last = groups.at(-1);
    if (last?.group === group) {
      last.durationUs += step.durationUs;
      last.steps.push(step);
    } else {
      groups.push({ group, durationUs: step.durationUs, steps: [step] });
    }
  }
  return {
    contractMajor: 1,
    contractMinor: 0,
    totalUs: run.measuredTotalUs,
    groups,
    context: 'isolated',
  };
}

export function nextDisplayedDurationUs(
  displayedUs: number | null,
  targetUs: number | null,
  live: boolean,
): number | null {
  if (!live || targetUs === null || displayedUs === null) return targetUs ?? displayedUs;
  return Math.max(displayedUs, targetUs);
}

export interface ProfilerRow {
  step: ExecutionStepId;
  group: ExecutionGroupId;
  durationUs: number;
  percent: number;
  counters: readonly ExecutionCostCounter[];
}

export function rankedProfilerRows(summary: ExecutionCostSummary): ProfilerRow[] {
  const total = summary.totalUs;
  return summary.groups
    .flatMap((entry) =>
      entry.steps.map((step) => ({
        step: step.step,
        group: entry.group,
        durationUs: step.durationUs,
        percent: total > 0 ? (step.durationUs / total) * 100 : 0,
        counters: step.counters,
      })),
    )
    .sort(
      (left, right) =>
        left.durationUs - right.durationUs ||
        executionStepIds.indexOf(left.step) - executionStepIds.indexOf(right.step),
    );
}

export interface ProfilerSegment {
  group: ExecutionGroupId;
  durationUs: number;
  fraction: number;
  percent: number;
}

export function profilerSegments(summary: ExecutionCostSummary): ProfilerSegment[] {
  return summary.groups
    .map((group) => {
      const fraction = summary.totalUs > 0 ? group.durationUs / summary.totalUs : 0;
      return {
        group: group.group,
        durationUs: group.durationUs,
        fraction,
        percent: fraction * 100,
      };
    })
    .sort(
      (left, right) =>
        executionGroupIds.indexOf(left.group) - executionGroupIds.indexOf(right.group),
    );
}

export const highlightedSegmentFloor = 0.02;

export function drawnSegmentFractions(
  segments: readonly ProfilerSegment[],
  highlighted: ExecutionGroupId | null,
  floor: number = highlightedSegmentFloor,
): number[] {
  const index = segments.findIndex((segment) => segment.group === highlighted);
  const fractions = segments.map((segment) => segment.fraction);
  if (index < 0 || fractions[index]! >= floor) return fractions;
  const others = 1 - fractions[index]!;
  if (others <= 0) return fractions;
  const scale = (1 - floor) / others;
  return fractions.map((fraction, position) => (position === index ? floor : fraction * scale));
}

function fixed(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

export function formatSeconds(durationUs: number): string {
  return t('profiler.duration.seconds', { seconds: fixed(durationUs / 1_000_000, 2) });
}

export function formatDuration(durationUs: number): string {
  if (durationUs >= 1_000_000) return formatSeconds(durationUs);
  const milliseconds = durationUs / 1000;
  return milliseconds < 10
    ? t('profiler.duration.milliseconds.hundredths', { milliseconds: fixed(milliseconds, 2) })
    : milliseconds < 100
      ? t('profiler.duration.milliseconds.tenths', { milliseconds: fixed(milliseconds, 1) })
      : t('profiler.duration.milliseconds.whole', { milliseconds: fixed(milliseconds, 0) });
}

export function formatPercent(percent: number): string {
  if (percent > 0 && percent < 0.1) return t('profiler.percent.below-tenth');
  return percent >= 10
    ? t('profiler.percent.whole', { percent: fixed(percent, 0) })
    : t('profiler.percent.tenths', { percent: fixed(percent, 1) });
}

export function spokenPercent(percent: number): string {
  if (percent > 0 && percent < 0.1) return t('profiler.percent.spoken.below-tenth');
  return percent >= 10
    ? t('profiler.percent.spoken.whole', { percent: fixed(percent, 0) })
    : t('profiler.percent.spoken.tenths', { percent: fixed(percent, 1) });
}

export function profilerRowName(row: ProfilerRow): string {
  return t('profiler.row.name', {
    step: stepLabel(row.step),
    group: groupLabel(row.group),
    duration: formatDuration(row.durationUs),
    percent: spokenPercent(row.percent),
  });
}

export function profilerTimeText(display: ProfilerDisplay): string {
  if (display.durationUs !== null) return formatSeconds(display.durationUs);
  return display.phase === 'running' ? formatSeconds(0) : '—';
}

export function profilerBarPercent(display: ProfilerDisplay): number {
  if (display.phase !== 'running') return 100;
  return barPercent(display.fraction);
}

function barPercent(fraction: number | null): number {
  return Math.round((fraction ?? 0) * 1000) / 10;
}

export function profilerBarKey(run: ProfilerRun | null): string {
  return run === null ? 'settled' : `run:${run.key}`;
}

export type ExecutionBarPhase = 'running' | 'completed' | 'idle';

export function profilerBarPhase(phase: ProfilerPhase | null): ExecutionBarPhase {
  if (phase === 'running') return 'running';
  return phase === 'committed' || phase === 'cached' ? 'completed' : 'idle';
}

export function runBarPhase(snapshot: ProfilerSnapshot): ExecutionBarPhase {
  if (snapshot.run) return 'running';
  return snapshot.continuedRunId !== null ? 'completed' : 'idle';
}

export function runBarPercent(run: ProfilerRun | null): number {
  return run === null ? 100 : barPercent(runFraction(run));
}

export function nextExecutionBarFade(
  previous: ExecutionBarPhase,
  next: ExecutionBarPhase,
  reducedMotion: boolean,
): 'fade' | 'hide' | 'keep' {
  if (next === 'running') return 'hide';
  if (previous === 'running' && next === 'completed') return reducedMotion ? 'hide' : 'fade';
  return 'keep';
}

export function formatCounterValue(value: number, noun: CounterNoun): string {
  return t(noun, { count: value });
}

export function formatCounters(counters: readonly ExecutionCostCounter[]): string {
  return counters
    .map(({ counter, value }) => formatCounterValue(value, counterNouns[counter]))
    .reduce((first, second) => t('profiler.counters.separated', { first, second }));
}

export interface StepCounterDescription {
  specific: string | null;
  generic: string | null;
  explanation: string | null;
}

export function describeStepCounters(
  step: ExecutionStepId,
  counters: readonly ExecutionCostCounter[],
): StepCounterDescription {
  const wording = stepCounterWording[step];
  const values = new Map(counters.map(({ counter, value }) => [counter, value]));
  const specific =
    wording?.counters.flatMap((entry) => {
      const value = values.get(entry.counter);
      return value === undefined ? [] : [formatCounterValue(value, entry.noun)];
    }) ?? [];
  const worded = new Set(
    specific.length > 0 ? wording!.counters.map((entry) => entry.counter) : [],
  );
  const generic = counters.filter(({ counter }) => !worded.has(counter));
  return {
    specific: specific.length > 0 ? activeTranslator().formatList(specific, 'unit') : null,
    generic: generic.length > 0 ? formatCounters(generic) : null,
    explanation: specific.length > 0 ? t(wording!.explanation) : null,
  };
}

export function isScrolledToBottom(element: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  return element.scrollHeight - element.clientHeight - element.scrollTop <= 2;
}

export function profilerAccessibleStatus(display: ProfilerDisplay): string {
  const seconds = display.durationUs === null ? null : fixed(display.durationUs / 1_000_000, 2);
  switch (display.phase) {
    case 'running': {
      if (display.planLength === null) {
        return seconds === null
          ? t('profiler.status.running.waiting')
          : t('profiler.status.running.waiting-time', { seconds });
      }
      const steps = { completed: display.completedSteps, total: display.planLength };
      return seconds === null
        ? t('profiler.status.running.steps', steps)
        : t('profiler.status.running.steps-time', { ...steps, seconds });
    }
    case 'cached':
      return t('profiler.status.cached', { seconds: seconds ?? 0 });
    case 'committed':
      return t('profiler.status.committed', { seconds: seconds ?? 0 });
    case 'unsupported':
      return t('profiler.status.unsupported');
    default:
      return t('profiler.status.idle');
  }
}

export function profilerTooltip(display: ProfilerDisplay): string {
  switch (display.phase) {
    case 'running':
      return display.planLength === null
        ? t('profiler.tooltip.running.waiting')
        : t('profiler.tooltip.running.steps', {
            completed: display.completedSteps,
            total: display.planLength,
          });
    case 'cached':
      return t('profiler.tooltip.cached');
    case 'committed':
      return t('profiler.tooltip.committed');
    case 'unsupported':
      return t('profiler.tooltip.unsupported');
    default:
      return t('profiler.status.idle');
  }
}

export function profilerPanelDescription(
  phase: ProfilerPhase | null,
  context: ExecutionCostSummary['context'] | null,
): string {
  return phase === 'cached'
    ? t('profiler.description.cached')
    : context === 'map-test'
      ? t('profiler.description.map-test')
      : t('profiler.description');
}
