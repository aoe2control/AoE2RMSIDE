import type { MapIconSourceRequest, PreviewGenerationResult } from '../shared/api';
import { isPreviewGenerationCancellation } from '../shared/preview-generation-settlement';
import type { ExecutionProfilerStore } from './execution-profiler';
import { randomSeed } from './run-configuration';

export type MapIconSeedSettled =
  { phase: 'editor' } | { phase: 'seeded'; seed: number; result: PreviewGenerationResult };

export type MapIconSeedState =
  | MapIconSeedSettled
  | {
      phase: 'generating';
      requestId: string;
      seed: number;
      previous: MapIconSeedSettled;
    };

export type MapIconSeedEvent =
  | { type: 'generate'; requestId: string; seed: number }
  | { type: 'completed'; requestId: string; result: PreviewGenerationResult }
  | { type: 'failed'; requestId: string }
  | { type: 'cancelled'; requestId: string }
  | { type: 'use-editor' }
  | { type: 'reset' };

export const initialMapIconSeedState: MapIconSeedState = Object.freeze({ phase: 'editor' });

export function mapIconSeedReducer(
  state: MapIconSeedState,
  event: MapIconSeedEvent,
): MapIconSeedState {
  switch (event.type) {
    case 'generate':
      return {
        phase: 'generating',
        requestId: event.requestId,
        seed: event.seed,
        previous: settledMapIconSeed(state),
      };
    case 'completed':
      if (state.phase !== 'generating' || state.requestId !== event.requestId) return state;
      return { phase: 'seeded', seed: state.seed, result: event.result };
    case 'failed':
    case 'cancelled':
      if (state.phase !== 'generating' || state.requestId !== event.requestId) return state;
      return state.previous;
    case 'use-editor':
    case 'reset':
      return initialMapIconSeedState;
  }
}

export function settledMapIconSeed(state: MapIconSeedState): MapIconSeedSettled {
  return state.phase === 'generating' ? state.previous : state;
}

export function mapIconSourceResult(
  state: MapIconSeedState,
  boundResult: PreviewGenerationResult | null,
): PreviewGenerationResult | null {
  if (!boundResult) return null;
  const settled = settledMapIconSeed(state);
  return settled.phase === 'seeded' ? settled.result : boundResult;
}

export const mapIconMaximumSeed = 0xffff_ffff;

export interface MapIconSeedDisplay {
  seed: number | null;
  editor: boolean;
}

export function mapIconSeedDisplay(
  state: MapIconSeedState,
  editorSeed: number | null,
): MapIconSeedDisplay {
  if (state.phase === 'generating' || state.phase === 'seeded') {
    return { seed: state.seed, editor: false };
  }
  return { seed: editorSeed, editor: editorSeed !== null };
}

export function parseMapIconSeed(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,10}$/u.test(trimmed)) return null;
  const seed = Number(trimmed);
  return Number.isSafeInteger(seed) && seed <= mapIconMaximumSeed ? seed : null;
}

export type MapIconSeedEntry =
  | { type: 'generate'; seed: number }
  | { type: 'use-editor' }
  | { type: 'unchanged' }
  | { type: 'revert' };

export function mapIconSeedEntry(
  text: string,
  shown: MapIconSeedDisplay,
  editorSeed: number | null,
): MapIconSeedEntry {
  const seed = parseMapIconSeed(text);
  if (seed === null) return { type: 'revert' };
  if (seed === shown.seed) return { type: 'unchanged' };
  if (seed === editorSeed) return { type: 'use-editor' };
  return { type: 'generate', seed };
}

export function randomMapIconSeed(
  avoid: readonly (number | null)[],
  next: () => number = randomSeed,
): number {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const seed = next();
    if (!avoid.includes(seed)) return seed;
  }
  let seed = next();
  while (avoid.includes(seed)) seed = (seed + 1) >>> 0;
  return seed;
}

export type MapIconSeedOutcome =
  | { status: 'completed'; result: PreviewGenerationResult }
  | { status: 'cancelled' }
  | { status: 'superseded' }
  | { status: 'failed'; message: string };

export interface MapIconSeedBridge {
  generateMapIconSource(request: MapIconSourceRequest): Promise<PreviewGenerationResult>;
  cancelMapIconSource(clientRequestId: string): Promise<boolean>;
}

export class MapIconSeedRunner {
  private active: string | null = null;

  constructor(
    private readonly bridge: MapIconSeedBridge,
    private readonly createRequestId: () => string = () => `map-icon-${crypto.randomUUID()}`,
  ) {}

  get activeRequestId(): string | null {
    return this.active;
  }

  start(
    identity: Omit<MapIconSourceRequest, 'clientRequestId' | 'seed'>,
    seed: number,
  ): { requestId: string; outcome: Promise<MapIconSeedOutcome> } {
    this.cancel();
    const requestId = this.createRequestId();
    this.active = requestId;
    const outcome = this.bridge
      .generateMapIconSource({ ...identity, clientRequestId: requestId, seed })
      .then(
        (result): MapIconSeedOutcome =>
          this.active === requestId ? { status: 'completed', result } : { status: 'superseded' },
        (error: unknown): MapIconSeedOutcome => {
          if (this.active !== requestId) return { status: 'superseded' };
          if (isPreviewGenerationCancellation(error)) return { status: 'cancelled' };
          return {
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
          };
        },
      )
      .finally(() => {
        if (this.active === requestId) this.active = null;
      });
    return { requestId, outcome };
  }

  cancel(): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    void this.bridge.cancelMapIconSource(active).catch(() => false);
  }
}

export function beginMapIconProgress(
  store: ExecutionProfilerStore,
  requestId: string,
  nowMs: number,
): void {
  store.begin(requestId, requestId, nowMs);
}

export function settleMapIconProgress(
  store: ExecutionProfilerStore,
  requestId: string,
  outcome: MapIconSeedOutcome,
): void {
  if (store.getSnapshot().run?.requestId !== requestId) return;
  if (outcome.status !== 'completed') {
    store.end(requestId);
    return;
  }
  const summary = outcome.result.executionCost ?? null;
  store.complete(requestId, summary);
  store.settle(outcome.result);
}
