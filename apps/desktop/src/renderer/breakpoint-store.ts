import type { PreviewBreakpoint, PreviewBreakpointStop } from '../shared/breakpoints';
import {
  breakpointRequestRanges,
  snapBreakpointLines,
  type BreakpointSite,
} from './breakpoint-model';

export interface BreakpointPausedLocation {
  documentKey: string;
  line: number;
}

export interface BreakpointRun {
  breakpoints: PreviewBreakpoint[];
  places: Map<number, { documentKey: string; line: number }>;
}

export interface BreakpointActiveRun extends BreakpointRun {
  executionId: string;
  content: string;
}

export interface BreakpointRunEnd {
  executionId: string;
  committed: boolean;
}

type Listener = () => void;

export class BreakpointStore {
  private readonly lines = new Map<string, number[]>();
  private readonly sites = new Map<string, BreakpointSite[]>();
  private readonly unreached = new Map<string, Set<number>>();
  private paused: BreakpointPausedLocation | null = null;
  private run: BreakpointActiveRun | null = null;
  private pause: PreviewBreakpointStop | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly runEndListeners = new Set<(end: BreakpointRunEnd) => void>();
  private revision = 0;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginRun(run: BreakpointActiveRun): void {
    this.run = run;
    this.pause = null;
    this.paused = null;
    this.changed();
  }

  activeRun(): BreakpointActiveRun | null {
    return this.run;
  }

  currentPause(): PreviewBreakpointStop | null {
    return this.pause;
  }

  pauseRun(stop: PreviewBreakpointStop, location: BreakpointPausedLocation | null): boolean {
    if (this.run?.executionId !== stop.executionId) return false;
    this.pause = stop;
    this.paused = location;
    this.changed();
    return true;
  }

  resumeRun(): void {
    if (!this.pause && !this.paused) return;
    this.pause = null;
    this.paused = null;
    this.changed();
  }

  endRun(executionId: string, committed: boolean, reachedIds?: readonly number[]): void {
    const run = this.run;
    if (run?.executionId !== executionId) return;
    this.run = null;
    this.pause = null;
    this.paused = null;
    if (committed && reachedIds) this.settleRun(run, reachedIds);
    else this.changed();
    for (const listener of [...this.runEndListeners]) listener({ executionId, committed });
  }

  onRunEnded(listener: (end: BreakpointRunEnd) => void): () => void {
    this.runEndListeners.add(listener);
    return () => this.runEndListeners.delete(listener);
  }

  currentRevision(): number {
    return this.revision;
  }

  linesOf(documentKey: string): readonly number[] {
    return this.lines.get(documentKey) ?? [];
  }

  sitesOf(documentKey: string): readonly BreakpointSite[] | null {
    return this.sites.get(documentKey) ?? null;
  }

  isUnreached(documentKey: string, line: number): boolean {
    return this.unreached.get(documentKey)?.has(line) ?? false;
  }

  pausedLocation(): BreakpointPausedLocation | null {
    return this.paused;
  }

  documentKeys(): string[] {
    return [...this.lines.keys()];
  }

  setLines(documentKey: string, lines: readonly number[]): void {
    const next = [...new Set(lines)]
      .filter((line) => line >= 0)
      .sort((left, right) => left - right);
    const current = this.lines.get(documentKey) ?? [];
    if (next.length === current.length && next.every((line, index) => line === current[index])) {
      return;
    }
    if (next.length === 0) this.lines.delete(documentKey);
    else this.lines.set(documentKey, next);
    const unreached = this.unreached.get(documentKey);
    if (unreached) {
      for (const line of [...unreached]) if (!next.includes(line)) unreached.delete(line);
    }
    this.changed();
  }

  toggle(documentKey: string, line: number): void {
    const current = this.lines.get(documentKey) ?? [];
    this.setLines(
      documentKey,
      current.includes(line) ? current.filter((entry) => entry !== line) : [...current, line],
    );
  }

  setSites(documentKey: string, sites: readonly BreakpointSite[]): void {
    this.sites.set(documentKey, [...sites]);
    const lines = this.lines.get(documentKey);
    if (lines) {
      const snapped = snapBreakpointLines(lines, sites);
      if (snapped.length !== lines.length || snapped.some((line, index) => line !== lines[index])) {
        this.setLines(documentKey, snapped);
        return;
      }
    }
    this.changed();
  }

  forgetSites(documentKey: string): void {
    if (this.sites.delete(documentKey)) this.changed();
  }

  clearAll(): void {
    this.lines.clear();
    this.unreached.clear();
    this.changed();
  }

  setPaused(location: BreakpointPausedLocation | null): void {
    if (
      this.paused?.documentKey === location?.documentKey &&
      this.paused?.line === location?.line
    ) {
      return;
    }
    this.paused = location;
    this.changed();
  }

  runBreakpoints(textOf: (documentKey: string) => { lineStarts: number[] } | null): BreakpointRun {
    const breakpoints: PreviewBreakpoint[] = [];
    const places = new Map<number, { documentKey: string; line: number }>();
    for (const [documentKey, lines] of this.lines) {
      const sites = this.sites.get(documentKey);
      const text = textOf(documentKey);
      if (!sites || !text) continue;
      const ranges = breakpointRequestRanges(
        lines,
        sites,
        text.lineStarts,
        documentKey,
        breakpoints.length + 1,
      );
      breakpoints.push(...ranges.breakpoints);
      for (const [id, line] of ranges.lineOfId) places.set(id, { documentKey, line });
    }
    return { breakpoints, places };
  }

  settleRun(run: BreakpointRun, reachedIds: readonly number[]): void {
    this.unreached.clear();
    const reached = new Set(reachedIds);
    for (const [id, place] of run.places) {
      if (reached.has(id)) continue;
      const lines = this.unreached.get(place.documentKey) ?? new Set<number>();
      lines.add(place.line);
      this.unreached.set(place.documentKey, lines);
    }
    this.changed();
  }

  snapshot(isSaved: (documentKey: string) => boolean): Array<{ uri: string; lines: number[] }> {
    return [...this.lines]
      .filter(([documentKey]) => isSaved(documentKey))
      .map(([uri, lines]) => ({ uri, lines: [...lines] }));
  }

  restore(saved: readonly { uri: string; lines: readonly number[] }[]): void {
    this.lines.clear();
    for (const entry of saved) this.setLinesQuietly(entry.uri, entry.lines);
    this.changed();
  }

  private setLinesQuietly(documentKey: string, lines: readonly number[]): void {
    const next = [...new Set(lines)]
      .filter((line) => line >= 0)
      .sort((left, right) => left - right);
    if (next.length > 0) this.lines.set(documentKey, next);
  }

  private changed(): void {
    this.revision += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

export const breakpointStore = new BreakpointStore();
