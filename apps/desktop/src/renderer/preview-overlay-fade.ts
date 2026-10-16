import type { Graphics } from 'pixi.js';
import { useEffect, useState, type RefObject } from 'react';
import { motionDuration } from './motion';
import type { ShownRaisedHighlight } from './preview-raised-terrain';
import { requestPreviewRender } from './preview-render-scheduler';

export interface OverlayFadeTarget {
  setOpacity(opacity: number): void;
  clear(): void;
}

export interface OverlayFadeOptions {
  durations(): { in: number; out: number };
  requestRender(): void;
  maxStepMilliseconds?: number;
  now?: () => number;
  frames?: {
    request(callback: (time: number) => void): number;
    cancel(handle: number): void;
  };
}

export type OverlayFadeState = 'hidden' | 'in' | 'shown' | 'out';

export const overlayFadeMaxStepMilliseconds = 34;

interface OverlayCrossFade<T> {
  partner: OverlayFade<T>;
  equals(first: T, second: T): boolean;
}

export class OverlayFade<T> {
  private shown: T | null = null;
  private shownScope: string | undefined;
  private present = false;
  private opacity = 0;
  private from = 0;
  private elapsed = 0;
  private lastStep = 0;
  private duration = 0;
  private frame: number | null = null;
  private target: OverlayFadeTarget | null = null;
  private crossFade: OverlayCrossFade<T> | null = null;

  constructor(private readonly options: OverlayFadeOptions) {}

  get state(): OverlayFadeState {
    if (this.frame !== null) return this.present ? 'in' : 'out';
    return this.present ? 'shown' : 'hidden';
  }

  get currentOpacity(): number {
    return this.opacity;
  }

  attach(target: OverlayFadeTarget): void {
    this.target = target;
    target.setOpacity(this.opacity);
  }

  detach(target: OverlayFadeTarget): void {
    if (this.target === target) this.target = null;
  }

  crossFadeWith(partner: OverlayFade<T>, equals: (first: T, second: T) => boolean): void {
    this.crossFade = { partner, equals };
  }

  show(next: T | null, scope?: string): T | null {
    if (next !== null) {
      const replaced = this.present || this.frame !== null ? this.shown : null;
      const replacedScope = this.shownScope;
      this.shown = next;
      this.shownScope = scope;
      if (this.crossFade && replaced !== null && !this.crossFade.equals(replaced, next)) {
        const { partner, equals } = this.crossFade;
        const resumed = partner.takeLeaving(replaced, this.opacity, replacedScope, next, equals);
        this.opacity = resumed;
        this.present = true;
        this.start(1);
      } else if (!this.present) {
        this.present = true;
        this.start(1);
      }
      return next;
    }
    if (this.present) {
      this.present = false;
      this.start(0);
    }
    if (this.frame !== null && scope !== this.shownScope) this.finish();
    return this.frame !== null ? this.shown : null;
  }

  private takeLeaving(
    leaving: T,
    opacity: number,
    scope: string | undefined,
    incoming: T,
    equals: (first: T, second: T) => boolean,
  ): number {
    const fading = this.frame !== null && this.shown !== null;
    const returning = fading && equals(this.shown as T, incoming);
    if (fading && !returning && scope === this.shownScope && this.opacity > opacity) {
      return 0;
    }
    const resumed = returning ? this.opacity : 0;
    this.shown = leaving;
    this.shownScope = scope;
    this.present = false;
    this.opacity = opacity;
    this.start(0);
    return resumed;
  }

  finish(): void {
    if (this.frame === null) return;
    this.cancelFrame();
    this.settle();
  }

  destroy(): void {
    this.cancelFrame();
    this.target = null;
  }

  private start(goal: 0 | 1): void {
    const durations = this.options.durations();
    this.duration = Math.max(0, goal === 1 ? durations.in : durations.out);
    this.from = this.opacity;
    this.elapsed = 0;
    this.lastStep = this.now();
    if (this.duration === 0 || this.from === goal) {
      this.cancelFrame();
      this.settle();
      return;
    }
    this.frame ??= this.requestFrame();
    this.setOpacity(this.from);
  }

  private step = (): void => {
    this.frame = null;
    const goal = this.present ? 1 : 0;
    const now = this.now();
    const maximum = this.options.maxStepMilliseconds ?? overlayFadeMaxStepMilliseconds;
    this.elapsed += Math.min(Math.max(0, now - this.lastStep), maximum);
    this.lastStep = now;
    const progress = Math.min(1, this.elapsed / this.duration);
    if (progress >= 1) {
      this.settle();
      return;
    }
    this.frame = this.requestFrame();
    this.setOpacity(this.from + (goal - this.from) * overlayFadeEase(progress));
  };

  private settle(): void {
    this.setOpacity(this.present ? 1 : 0);
    if (!this.present) {
      this.shown = null;
      this.target?.clear();
    }
  }

  private setOpacity(opacity: number): void {
    this.opacity = opacity;
    this.target?.setOpacity(opacity);
    this.options.requestRender();
  }

  private requestFrame(): number {
    return this.options.frames
      ? this.options.frames.request(this.step)
      : requestAnimationFrame(this.step);
  }

  private cancelFrame(): void {
    if (this.frame === null) return;
    if (this.options.frames) this.options.frames.cancel(this.frame);
    else cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private now(): number {
    return this.options.now?.() ?? performance.now();
  }
}

export function overlayFadeEase(progress: number): number {
  return 1 - (1 - progress) ** 3;
}

const boundFades = new WeakMap<object, OverlayFade<unknown>>();

export function bindOverlayFade<T>(
  owner: object,
  fade: OverlayFade<T>,
  target: OverlayFadeTarget,
): void {
  boundFades.set(owner, fade as OverlayFade<unknown>);
  fade.attach(target);
}

export function overlayFadeOf<T>(owner: object): OverlayFade<T> | undefined {
  return boundFades.get(owner) as OverlayFade<T> | undefined;
}

export function sameTileIndices(first: readonly number[], second: readonly number[]): boolean {
  if (first === second) return true;
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false;
  }
  return true;
}

export interface CrossFadingHighlight {
  fill: OverlayFade<readonly number[]>;
  leaving: OverlayFade<readonly number[]>;
}

export function crossFadingHighlight(options: OverlayFadeOptions): CrossFadingHighlight {
  const fill = new OverlayFade<readonly number[]>(options);
  const leaving = new OverlayFade<readonly number[]>(options);
  fill.crossFadeWith(leaving, sameTileIndices);
  return { fill, leaving };
}

export interface PreviewOverlayFades {
  selection: OverlayFade<unknown>;
  source: OverlayFade<readonly number[]>;
  sourceLeaving: OverlayFade<readonly number[]>;
  legend: OverlayFade<readonly number[]>;
  legendLeaving: OverlayFade<readonly number[]>;
  tileGrid: OverlayFade<true>;
}

export function usePreviewOverlayFades(
  scheduler: RefObject<{ request(): void } | null>,
  host: RefObject<HTMLElement | null>,
): PreviewOverlayFades {
  const [fades] = useState(() => {
    const created: Partial<PreviewOverlayFades> = {};
    const options: OverlayFadeOptions = {
      durations: () => ({
        in: motionDuration('--motion-duration-map-highlight-in', 160),
        out: motionDuration('--motion-duration-map-highlight-out', 120),
      }),
      requestRender: () => {
        scheduler.current?.request();
        const container = host.current;
        const { selection, source, sourceLeaving, legend, legendLeaving, tileGrid } = created;
        if (
          !container ||
          !selection ||
          !source ||
          !sourceLeaving ||
          !legend ||
          !legendLeaving ||
          !tileGrid
        ) {
          return;
        }
        container.dataset.selectionFade = selection.state;
        container.dataset.sourceHighlightFade = source.state;
        container.dataset.sourceHighlightLeavingFade = sourceLeaving.state;
        container.dataset.sourceHighlightOpacities = `${source.currentOpacity.toFixed(3)} ${sourceLeaving.currentOpacity.toFixed(3)}`;
        container.dataset.legendHoverFade = legend.state;
        container.dataset.legendHoverLeavingFade = legendLeaving.state;
        container.dataset.tileGridFade = tileGrid.state;
      },
    };
    created.selection = new OverlayFade(options);
    const source = crossFadingHighlight(options);
    created.source = source.fill;
    created.sourceLeaving = source.leaving;
    const legend = crossFadingHighlight(options);
    created.legend = legend.fill;
    created.legendLeaving = legend.leaving;
    created.tileGrid = new OverlayFade<true>(options);
    return created as PreviewOverlayFades;
  });
  useEffect(
    () => () => {
      fades.selection.destroy();
      fades.source.destroy();
      fades.sourceLeaving.destroy();
      fades.legend.destroy();
      fades.legendLeaving.destroy();
      fades.tileGrid.destroy();
    },
    [fades],
  );
  return fades;
}

export function graphicsFadeTarget(
  graphics: Graphics,
  raised: { setOpacity(opacity: number): void; clear(): void } | null,
): OverlayFadeTarget {
  return {
    setOpacity: (opacity) => {
      if (graphics.destroyed) return;
      graphics.alpha = opacity;
      raised?.setOpacity(opacity);
      requestPreviewRender(graphics);
    },
    clear: () => {
      if (graphics.destroyed) return;
      graphics.clear();
      raised?.clear();
      requestPreviewRender(graphics);
    },
  };
}

export function bindPreviewOverlayFades(
  fades: PreviewOverlayFades,
  overlays: {
    selection: Graphics;
    source: [Graphics, ShownRaisedHighlight | null];
    sourceLeaving: [Graphics, ShownRaisedHighlight | null];
    legend: [Graphics, ShownRaisedHighlight | null];
    legendLeaving: [Graphics, ShownRaisedHighlight | null];
  },
): () => void {
  const bound = [
    [fades.selection, overlays.selection, null],
    [fades.source, ...overlays.source],
    [fades.sourceLeaving, ...overlays.sourceLeaving],
    [fades.legend, ...overlays.legend],
    [fades.legendLeaving, ...overlays.legendLeaving],
  ] as const;
  const releases = bound.map(([fade, graphics, raised]) => {
    const target = graphicsFadeTarget(graphics, raised);
    bindOverlayFade(graphics, fade, target);
    return () => fade.detach(target);
  });
  return () => {
    for (const release of releases) release();
  };
}
