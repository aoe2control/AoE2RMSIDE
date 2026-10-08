import { previewCandidateChunkBounds } from '../shared/preview-candidate';
import type { PresentedPreviewResult } from './presentation-names';
import type { PreviewCandidateStore } from './preview-candidate-store';
import {
  objectMaterial,
  terrainMaterial,
  type AggregatedSelectionLayer,
  type PreviewObjectVisibility,
} from './preview-materials';
import type { PreviewSelection } from './top-down-preview';

export interface ProvisionalLegendEntry {
  key: string;
  kind: 'terrain' | 'object' | 'wall';
  id: number;
  owner: number;
  count: number;
}

export class ProvisionalLegendCounts {
  private readonly perChunk = new Map<number, Map<string, ProvisionalLegendEntry>>();
  lastExaminedTiles = 0;

  constructor(readonly selection: PreviewSelection) {}

  update(store: PreviewCandidateStore, changedChunks: readonly number[], reset: boolean): void {
    const view = store.view;
    const grid = store.chunkGrid();
    const terrain = store.terrainIds();
    this.lastExaminedTiles = 0;
    if (reset) this.perChunk.clear();
    if (!view || !grid || !terrain) {
      this.perChunk.clear();
      return;
    }
    const { selection } = this;
    for (const key of changedChunks) {
      const chunkX = key % grid.columns;
      const chunkY = Math.floor(key / grid.columns);
      const bounds = previewCandidateChunkBounds(view.width, view.height, chunkX, chunkY);
      const minimumX = Math.max(bounds.minimumX, selection.minimumX);
      const maximumX = Math.min(bounds.maximumX, selection.maximumX);
      const minimumY = Math.max(bounds.minimumY, selection.minimumY);
      const maximumY = Math.min(bounds.maximumY, selection.maximumY);
      if (minimumX > maximumX || minimumY > maximumY) {
        this.perChunk.delete(key);
        continue;
      }
      const counts = new Map<string, ProvisionalLegendEntry>();
      const add = (entry: Omit<ProvisionalLegendEntry, 'count'>) => {
        const current = counts.get(entry.key);
        if (current) current.count += 1;
        else counts.set(entry.key, { ...entry, count: 1 });
      };
      for (let y = minimumY; y <= maximumY; y += 1) {
        for (let x = minimumX; x <= maximumX; x += 1) {
          const id = terrain[y * view.width + x]!;
          add({ key: `terrain:${id}`, kind: 'terrain', id, owner: 0 });
          this.lastExaminedTiles += 1;
        }
      }
      for (const object of store.chunkObjects(key)) {
        const x = Math.floor(object.x);
        const y = Math.floor(object.y);
        if (x < minimumX || x > maximumX || y < minimumY || y > maximumY) continue;
        const kind = object.presentationKind === 'wall' ? 'wall' : 'object';
        add({
          key: `${kind}:${object.objectId}:${object.owner}`,
          kind,
          id: object.objectId,
          owner: object.owner,
        });
      }
      this.perChunk.set(key, counts);
    }
  }

  entries(): ProvisionalLegendEntry[] {
    const totals = new Map<string, ProvisionalLegendEntry>();
    for (const counts of this.perChunk.values()) {
      for (const entry of counts.values()) {
        const current = totals.get(entry.key);
        if (current) current.count += entry.count;
        else totals.set(entry.key, { ...entry });
      }
    }
    const order = { terrain: 0, object: 1, wall: 2 } as const;
    return [...totals.values()].sort(
      (left, right) =>
        order[left.kind] - order[right.kind] ||
        right.count - left.count ||
        left.id - right.id ||
        left.owner - right.owner,
    );
  }
}

export type PreviewLegendContent = 'selection' | 'source-highlight' | 'provisional';

export function previewLegendContent(state: {
  generationActive: boolean;
  candidateActive: boolean;
  selection: boolean;
  sourceHighlight: boolean;
}): PreviewLegendContent | null {
  if (state.candidateActive) return state.selection ? 'provisional' : null;
  if (state.generationActive) return null;
  if (state.sourceHighlight) return 'source-highlight';
  return state.selection ? 'selection' : null;
}

export function selectionKeptForView(
  selectionDimensions: string | null,
  dimensions: string | null,
): boolean {
  return selectionDimensions === null || selectionDimensions === dimensions;
}

export function selectionFitsCandidate(
  selection: PreviewSelection | null,
  width: number,
  height: number,
): selection is PreviewSelection {
  return (
    selection !== null &&
    selection.minimumX >= 0 &&
    selection.minimumY >= 0 &&
    selection.maximumX < width &&
    selection.maximumY < height
  );
}

export function provisionalLegendLayers(
  entries: readonly ProvisionalLegendEntry[],
  map: PresentedPreviewResult | null,
  visibility: PreviewObjectVisibility,
  candidate: Pick<
    PresentedPreviewResult,
    'minimapPalette' | 'terrainNames' | 'localTerrainColors'
  > | null = null,
): AggregatedSelectionLayer[] {
  const palette = candidate ? candidate.minimapPalette : (map?.minimapPalette ?? null);
  return entries
    .filter(
      (entry) =>
        entry.kind === 'terrain' ||
        (visibility.objects && (visibility.helpers || !visibility.helperObjectIds.has(entry.id))),
    )
    .map((entry) => ({
      count: entry.count,
      ids: [entry.id],
      instances: [],
      key: `provisional:${entry.key}`,
      kind: entry.kind,
      material:
        entry.kind === 'terrain'
          ? terrainMaterial(
              entry.id,
              'exact',
              palette,
              candidate?.terrainNames ?? map?.terrainNames ?? [],
              map?.presentationNameSources?.localTerrainIds,
              candidate ? candidate.localTerrainColors : map?.localTerrainColors,
            )
          : objectMaterial(
              {
                objectId: entry.id,
                owner: entry.owner,
                presentationKind: entry.kind === 'wall' ? 'wall' : 'object',
              },
              map?.playerColorIds ?? [],
              map?.objectNames ?? [],
              palette,
              map?.presentationNameSources?.localObjectIds,
              visibility.helperObjectIds,
            ),
      renderOrder: entry.kind === 'terrain' ? 0 : entry.kind === 'object' ? 3 : 4,
    }));
}
