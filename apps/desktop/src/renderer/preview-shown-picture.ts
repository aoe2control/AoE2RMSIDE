import type { PreviewLook } from '../shared/game-art';
import type { GenerationActivity } from './preview-candidate-store';
import type { ElevationSurface } from './preview-elevation';
import type { RaisedTerrainUniforms } from './preview-raised-terrain';

export interface ShownRaisedPicture {
  surface: ElevationSurface;
  uniforms: RaisedTerrainUniforms;
  overlayBias(): number;
}

export type ShownPictureSource =
  'live-stage' | 'kept-live-stage' | 'previous-picture' | 'map' | 'none';

export interface ShownPicture {
  source: ShownPictureSource;
  raised: ShownRaisedPicture | null;
}

interface PictureState {
  raised: ShownRaisedPicture | null;
}

export function shownPicture(layers: {
  live: PictureState | null;
  kept: PictureState | null;
  standIn: PictureState | null;
  map: PictureState | null;
}): ShownPicture {
  if (layers.live) return { source: 'live-stage', raised: layers.live.raised };
  if (layers.kept) return { source: 'kept-live-stage', raised: layers.kept.raised };
  if (layers.standIn) return { source: 'previous-picture', raised: layers.standIn.raised };
  if (layers.map) return { source: 'map', raised: layers.map.raised };
  return { source: 'none', raised: null };
}

export function gameTexturesLiveStages(
  gameTexturesExpected: boolean,
  activity: Pick<GenerationActivity, 'kind' | 'progressive'> | null,
): boolean {
  return gameTexturesExpected && activity?.kind === 'preview' && activity.progressive;
}

export function liveStageLook(flatLook: PreviewLook, liveInGameTextures: boolean): PreviewLook {
  return liveInGameTextures ? 'texture-colors' : flatLook;
}

export function keepLastLiveStage(state: {
  committed: boolean;
  stageShown: boolean;
  finalInGameTextures: boolean;
  sameDimensions: boolean;
}): boolean {
  return state.committed && state.stageShown && state.finalInGameTextures && state.sameDimensions;
}

export function finalPictureReady(state: {
  gameTexturesExpected: boolean;
  presented: boolean;
}): boolean {
  return !state.gameTexturesExpected || state.presented;
}

export function generationBlurShown(state: {
  activity: Pick<GenerationActivity, 'kind' | 'progressive'> | null;
  gameTexturesExpected: boolean;
  liveInGameTextures: boolean;
  candidateActive: boolean;
  lookPending: boolean;
  lastStageKept: boolean;
}): boolean {
  const activity = state.activity;
  const outdated =
    activity !== null &&
    activity.kind === 'preview' &&
    ((state.gameTexturesExpected && !state.liveInGameTextures) ||
      (!activity.progressive && !state.candidateActive));
  return outdated || (state.lookPending && !state.lastStageKept);
}
