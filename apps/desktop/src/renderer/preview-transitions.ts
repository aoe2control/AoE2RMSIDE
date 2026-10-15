import type { PreviewLook } from '../shared/game-art';
import { previewCandidateStages, type PreviewCandidateStage } from '../shared/preview-candidate';
import type { ElevationDisplayMode } from './preview-terrain-mesh';

export const mapTransitionDurations = {
  morph: 390,
  rise: 360,
  flatten: 315,
  crossFade: 150,
  objects: 120,
} as const;

export const morphFieldWaitMilliseconds = 120;

export type MapTransitionKind = 'morph' | 'rise' | 'flatten' | 'cross-fade';

export function easeOutCubic(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return 1 - (1 - clamped) ** 3;
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function transitionProgress(startedAt: number, now: number, duration: number): number {
  if (duration <= 0) return 1;
  return Math.min(1, Math.max(0, (now - startedAt) / duration));
}

export function objectsFadeAlpha(progress: number, duration: number): number {
  const start = Math.max(0, 1 - mapTransitionDurations.objects / Math.max(duration, 1));
  return smoothstep(start, 1, progress);
}

export interface TransitionPicture {
  map: string;
  look: PreviewLook;
  relief: ElevationDisplayMode;
  gameTextures: boolean;
  view: string;
  liveStageView: boolean;
}

export interface MapTransitionContext {
  enabled: boolean;
  reducedMotion: boolean;
  liveStageShown?: boolean;
  afterLiveStage?: boolean;
  transitionRunning?: boolean;
}

export interface MapTransitionPlan {
  kind: MapTransitionKind | null;
  crossFade: boolean;
  objectsFadeIn: boolean;
  skipped: 'setting' | 'reduced-motion' | null;
  newMap: boolean;
  heights: boolean;
}

const noTransition: MapTransitionPlan = {
  kind: null,
  crossFade: false,
  objectsFadeIn: false,
  skipped: null,
  newMap: false,
  heights: false,
};

const crossFade: MapTransitionPlan = {
  kind: 'cross-fade',
  crossFade: true,
  objectsFadeIn: false,
  skipped: null,
  newMap: false,
  heights: false,
};

const reliefRise: MapTransitionPlan = {
  kind: 'rise',
  crossFade: true,
  objectsFadeIn: true,
  skipped: null,
  newMap: false,
  heights: false,
};

const newMapRise: MapTransitionPlan = {
  kind: 'rise',
  crossFade: false,
  objectsFadeIn: true,
  skipped: null,
  newMap: true,
  heights: false,
};

function newMapMorph(heights: boolean): MapTransitionPlan {
  return {
    kind: 'morph',
    crossFade: false,
    objectsFadeIn: true,
    skipped: null,
    newMap: true,
    heights,
  };
}

function colourPicture(picture: TransitionPicture): boolean {
  return !picture.gameTextures;
}

export function planMapTransition(
  previous: TransitionPicture | null,
  next: TransitionPicture,
  context: MapTransitionContext,
): MapTransitionPlan {
  const wanted = wantedTransition(previous, next, context);
  if (wanted.kind === null) return wanted;
  if (!context.enabled) return { ...noTransition, skipped: 'setting', newMap: wanted.newMap };
  if (context.reducedMotion) {
    return { ...noTransition, skipped: 'reduced-motion', newMap: wanted.newMap };
  }
  return wanted;
}

function wantedTransition(
  previous: TransitionPicture | null,
  next: TransitionPicture,
  context: MapTransitionContext,
): MapTransitionPlan {
  const raised = next.relief === 'raised';
  if (!previous) {
    return raised && !next.gameTextures ? newMapRise : noTransition;
  }
  if (context.liveStageShown || context.afterLiveStage || previous.view !== next.view) {
    return noTransition;
  }
  if (next.liveStageView && previous.map !== next.map) return crossFade;
  if (previous.map !== next.map) {
    if (next.gameTextures) return noTransition;
    if (raised) return colourPicture(previous) ? newMapMorph(true) : newMapRise;
    const flatColours = colourPicture(previous) && previous.relief !== 'raised';
    return flatColours ? newMapMorph(false) : noTransition;
  }
  if (previous.look !== next.look || previous.gameTextures !== next.gameTextures) return crossFade;
  if (previous.relief !== next.relief) {
    if (previous.gameTextures || next.gameTextures) return crossFade;
    if (raised) return reliefRise;
    if (previous.relief === 'raised' && !context.transitionRunning) {
      return {
        kind: 'flatten',
        crossFade: false,
        objectsFadeIn: false,
        skipped: null,
        newMap: false,
        heights: false,
      };
    }
    return crossFade;
  }
  return noTransition;
}

export interface SceneTransitionParts {
  replacing: boolean;
  previousFlat: boolean;
  previousRaised: boolean;
  nextRaised: boolean;
}

export function fitTransitionToScene(
  plan: MapTransitionPlan,
  parts: SceneTransitionParts,
): MapTransitionPlan {
  const rises = parts.replacing && parts.nextRaised;
  const drawable =
    plan.kind === 'morph'
      ? plan.heights
        ? rises && (parts.previousFlat || parts.previousRaised)
        : parts.replacing && parts.previousFlat && !parts.nextRaised
      : plan.kind === 'flatten'
        ? parts.replacing && parts.previousRaised && !parts.nextRaised
        : plan.kind === 'rise'
          ? rises
          : true;
  if (drawable) return plan;
  if (plan.kind === 'morph' && plan.heights && rises) return newMapRise;
  return plan.newMap ? noTransition : crossFade;
}

export const landLayoutStage: PreviewCandidateStage = 'terrain';

export function showsLandLayout(stage: PreviewCandidateStage): boolean {
  return previewCandidateStages.indexOf(stage) >= previewCandidateStages.indexOf(landLayoutStage);
}

export type LiveStageHold = 'none' | 'holding' | 'released' | 'passed';

export interface LiveStageHoldContext {
  candidateActive: boolean;
  enabled: boolean;
  reducedMotion: boolean;
  colourMapShown: boolean;
  stagesShown: boolean;
}

export function nextLiveStageHold(
  current: LiveStageHold,
  context: LiveStageHoldContext,
): LiveStageHold {
  if (!context.candidateActive) return 'none';
  const wanted =
    context.enabled && !context.reducedMotion && context.colourMapShown && context.stagesShown;
  if (current === 'none') return wanted ? 'holding' : 'passed';
  if (current === 'holding' && !wanted) return 'passed';
  return current;
}

export function releasesLiveStageHold(
  current: LiveStageHold,
  stage: PreviewCandidateStage | null,
  raisedPending: boolean,
): boolean {
  return current === 'holding' && stage !== null && showsLandLayout(stage) && !raisedPending;
}

export function planLiveStageMorph(
  previous: TransitionPicture | null,
  stageRaised: boolean,
  context: Pick<MapTransitionContext, 'enabled' | 'reducedMotion'>,
): MapTransitionPlan {
  if (!previous || !colourPicture(previous)) return noTransition;
  if (previous.relief === 'raised' && !stageRaised) return noTransition;
  if (!context.enabled) return { ...noTransition, skipped: 'setting', newMap: true };
  if (context.reducedMotion) return { ...noTransition, skipped: 'reduced-motion', newMap: true };
  return newMapMorph(stageRaised);
}

interface TimelineTrack {
  kind: MapTransitionKind;
  duration: number;
  startedAt: number | null;
  holdUntil: number;
}

export interface TimelineFrame {
  id: string;
  kind: MapTransitionKind;
  progress: number;
  eased: number;
  ended: boolean;
}

export class MapTransitionTimeline {
  private readonly tracks = new Map<string, TimelineTrack>();

  start(
    id: string,
    kind: MapTransitionKind,
    now: number,
    duration: number,
    hold: { holdMilliseconds: number } | null = null,
  ): void {
    this.tracks.set(id, {
      kind,
      duration,
      startedAt: hold ? null : now,
      holdUntil: hold ? now + hold.holdMilliseconds : now,
    });
  }

  release(id: string, now: number): void {
    const track = this.tracks.get(id);
    if (track && track.startedAt === null) track.startedAt = now;
  }

  has(id: string): boolean {
    return this.tracks.has(id);
  }

  held(id: string): boolean {
    return this.tracks.get(id)?.startedAt === null;
  }

  get active(): boolean {
    return this.tracks.size > 0;
  }

  kinds(): MapTransitionKind[] {
    const order: MapTransitionKind[] = ['morph', 'rise', 'flatten', 'cross-fade'];
    const running = new Set([...this.tracks.values()].map((track) => track.kind));
    return order.filter((kind) => running.has(kind));
  }

  advance(now: number): TimelineFrame[] {
    const frames: TimelineFrame[] = [];
    for (const [id, track] of [...this.tracks]) {
      if (track.startedAt === null && now >= track.holdUntil) track.startedAt = track.holdUntil;
      const progress =
        track.startedAt === null ? 0 : transitionProgress(track.startedAt, now, track.duration);
      const ended = progress >= 1;
      if (ended) this.tracks.delete(id);
      frames.push({ id, kind: track.kind, progress, eased: easeOutCubic(progress), ended });
    }
    return frames;
  }

  finish(): TimelineFrame[] {
    const frames = [...this.tracks].map(([id, track]) => ({
      id,
      kind: track.kind,
      progress: 1,
      eased: 1,
      ended: true,
    }));
    this.tracks.clear();
    return frames;
  }

  end(id: string): TimelineFrame | null {
    const track = this.tracks.get(id);
    if (!track) return null;
    this.tracks.delete(id);
    return { id, kind: track.kind, progress: 1, eased: 1, ended: true };
  }
}
