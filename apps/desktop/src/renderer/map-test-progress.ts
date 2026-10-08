import { useSyncExternalStore } from 'react';

export interface MapTestProgress {
  phase: 'idle' | 'running' | 'completed';
  executionId: string | null;
  completed: number;
  requested: number;
  run: number;
}

export const idleMapTestProgress: MapTestProgress = Object.freeze({
  phase: 'idle',
  executionId: null,
  completed: 0,
  requested: 0,
  run: 0,
});

export type MapTestProgressInput =
  | { kind: 'started'; executionId: string }
  | { kind: 'counts'; executionId: string; completed: number; requested: number }
  | { kind: 'finished'; executionId: string }
  | { kind: 'ended'; executionId: string };

export function nextMapTestProgress(
  state: MapTestProgress,
  input: MapTestProgressInput,
): MapTestProgress {
  switch (input.kind) {
    case 'started':
      return {
        phase: 'running',
        executionId: input.executionId,
        completed: 0,
        requested: 0,
        run: state.run + 1,
      };
    case 'counts': {
      if (state.phase !== 'running' || state.executionId !== input.executionId) return state;
      const completed = Math.max(state.completed, input.completed);
      const requested = Math.max(state.requested, input.requested, completed);
      if (completed === state.completed && requested === state.requested) return state;
      return { ...state, completed, requested };
    }
    case 'finished':
      if (state.phase !== 'running' || state.executionId !== input.executionId) return state;
      return { ...state, phase: 'completed' };
    case 'ended':
      if (state.phase === 'idle' || state.executionId !== input.executionId) return state;
      return { ...state, phase: 'idle' };
  }
}

export function mapTestProgressPercent(state: MapTestProgress): number {
  if (state.phase === 'completed') return 100;
  if (state.requested <= 0) return 0;
  return Math.floor((Math.min(state.completed, state.requested) / state.requested) * 100);
}

export class MapTestProgressStore {
  private snapshot: MapTestProgress = idleMapTestProgress;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): MapTestProgress => this.snapshot;

  advance(input: MapTestProgressInput): void {
    const next = nextMapTestProgress(this.snapshot, input);
    if (next === this.snapshot) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export function useMapTestProgress(store: MapTestProgressStore): MapTestProgress {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
