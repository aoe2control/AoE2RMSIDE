import type { PreviewLook } from '../shared/game-art';
import type { GenerationActivity } from './preview-candidate-store';

export type PreviewMapOrigin = 'generation' | 'map-test';

export const mapTestProgressivePreview = false;

export interface MapTestPreviewState {
  mapOrigin: PreviewMapOrigin | null;
  activityKind: GenerationActivity['kind'] | null;
}

export function mapTestPreviewShown(state: MapTestPreviewState): boolean {
  if (state.activityKind === 'map-test') return true;
  if (state.activityKind === 'preview') return false;
  return state.mapOrigin === 'map-test';
}

export function mapTestPreviewLook(look: PreviewLook, shown: boolean): PreviewLook {
  return shown ? 'minimap' : look;
}

export function gameArtPreviewMap<T>(map: T | null, mapOrigin: PreviewMapOrigin | null): T | null {
  return mapOrigin === 'map-test' ? null : map;
}
