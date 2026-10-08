import type { SelectedMinimapPalette, SelectedTexturePalette } from '../shared/api';
import {
  previewCandidateChunkBounds,
  previewCandidateChunkGrid,
  previewCandidateObjectRecordBytes,
  type PreviewCandidate,
  type PreviewCandidateSample,
  type PreviewCandidateStage,
} from '../shared/preview-candidate';
import { t, type MessageId } from '../shared/i18n/translator';

export interface PreviewCandidateView {
  requestId: string;
  revision: number;
  stage: PreviewCandidateStage;
  width: number;
  height: number;
  elapsedUs: number;
  sample: PreviewCandidateSample | null;
}

export interface CandidateObject {
  objectId: number;
  x: number;
  y: number;
  footprintWidth: number;
  footprintHeight: number;
  owner: number;
  presentationKind: 'object' | 'wall';
}

export interface CandidateCliff {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  cliffType: number;
}

export interface CandidateApplyResult {
  accepted: boolean;
  changedChunks: number[];
  reset: boolean;
}

export type PreviewCandidateListener = (
  view: PreviewCandidateView | null,
  change: CandidateApplyResult | null,
) => void;

export interface GenerationActivity {
  key: string;
  requestId: string | null;
  kind: 'preview' | 'map-test';
  progressive: boolean;
  minimapPalette: SelectedMinimapPalette | null;
  texturePalette?: SelectedTexturePalette | null;
}

interface CandidateData {
  view: PreviewCandidateView;
  columns: number;
  rows: number;
  terrainIds: Uint16Array;
  elevations: Int8Array;
  objects: Map<number, CandidateObject[]>;
  cliffs: Map<number, CandidateCliff[]>;
}

export const previewCandidateHoldMilliseconds = 250;

export interface CandidateStoreTiming {
  holdMilliseconds: number;
  now(): number;
  setTimer(callback: () => void, milliseconds: number): unknown;
  clearTimer(timer: unknown): void;
}

const refused: CandidateApplyResult = Object.freeze({
  accepted: false,
  changedChunks: [],
  reset: false,
}) as CandidateApplyResult;

export class PreviewCandidateStore {
  private running: GenerationActivity | null = null;
  private data: CandidateData | null = null;
  private readonly listeners = new Set<PreviewCandidateListener>();
  private readonly activityListeners = new Set<() => void>();
  private readonly timing: CandidateStoreTiming;
  private admittedAt: number | null = null;
  private published = false;
  private held: CandidateApplyResult | null = null;
  private holdTimer: unknown = null;

  constructor(timing: Partial<CandidateStoreTiming> = {}) {
    this.timing = {
      holdMilliseconds: 0,
      now: () => performance.now(),
      setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      ...timing,
    };
  }

  admit(
    key: string,
    kind: GenerationActivity['kind'],
    progressive: boolean,
    minimapPalette: SelectedMinimapPalette | null = null,
    texturePalette: SelectedTexturePalette | null = null,
  ): void {
    this.running = { key, requestId: null, kind, progressive, minimapPalette, texturePalette };
    this.admittedAt = this.timing.now();
    this.clear();
    this.publishActivity();
  }

  begin(
    requestId: string,
    key?: string,
    options: Pick<GenerationActivity, 'kind' | 'progressive'> &
      Partial<Pick<GenerationActivity, 'minimapPalette' | 'texturePalette'>> = {
      kind: 'preview',
      progressive: true,
    },
  ): void {
    const running = this.running;
    const adopted = key !== undefined && running?.key === key;
    if (!adopted) this.admittedAt = this.timing.now();
    this.running = adopted
      ? { ...running, requestId }
      : {
          key: key ?? requestId,
          requestId,
          kind: options.kind,
          progressive: options.progressive,
          minimapPalette: options.minimapPalette ?? null,
          texturePalette: options.texturePalette ?? null,
        };
    this.clear();
    this.publishActivity();
  }

  get scopedRequestId(): string | null {
    return this.running?.requestId ?? null;
  }

  get activity(): GenerationActivity | null {
    return this.running;
  }

  end(identity?: string): void {
    const running = this.running;
    if (
      identity !== undefined &&
      (running === null || (running.key !== identity && running.requestId !== identity))
    ) {
      return;
    }
    this.running = null;
    this.admittedAt = null;
    this.clear();
    if (running !== null) this.publishActivity();
  }

  subscribeActivity = (listener: () => void): (() => void) => {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  };

  getActivity = (): GenerationActivity | null => this.running;

  clear(): void {
    this.release();
    if (!this.data) return;
    this.data = null;
    const shown = this.published;
    this.published = false;
    if (shown) this.publish(null);
  }

  get view(): PreviewCandidateView | null {
    return this.published ? (this.data?.view ?? null) : null;
  }

  apply(candidate: PreviewCandidate): CandidateApplyResult {
    if (this.running === null || candidate.requestId !== this.running.requestId) return refused;
    const current = this.data;
    const reset = candidate.baseRevision === 0;
    if (
      !reset &&
      (!current ||
        current.view.revision !== candidate.baseRevision ||
        current.view.width !== candidate.width ||
        current.view.height !== candidate.height)
    ) {
      return refused;
    }
    const { columns, rows } = previewCandidateChunkGrid(candidate.width, candidate.height);
    const data: CandidateData =
      reset || !current
        ? {
            view: viewOf(candidate),
            columns,
            rows,
            terrainIds: new Uint16Array(candidate.width * candidate.height),
            elevations: new Int8Array(candidate.width * candidate.height),
            objects: new Map(),
            cliffs: new Map(),
          }
        : { ...current, view: viewOf(candidate) };
    const changedChunks: number[] = [];
    for (const chunk of candidate.chunks) {
      const key = chunk.chunkY * columns + chunk.chunkX;
      changedChunks.push(key);
      const bounds = previewCandidateChunkBounds(
        candidate.width,
        candidate.height,
        chunk.chunkX,
        chunk.chunkY,
      );
      const terrain = new DataView(
        chunk.terrainIdsLe.buffer,
        chunk.terrainIdsLe.byteOffset,
        chunk.terrainIdsLe.byteLength,
      );
      let tile = 0;
      for (let y = bounds.minimumY; y <= bounds.maximumY; y += 1) {
        for (let x = bounds.minimumX; x <= bounds.maximumX; x += 1) {
          const index = y * candidate.width + x;
          data.terrainIds[index] = terrain.getUint16(tile * 2, true);
          data.elevations[index] = (chunk.elevations[tile]! << 24) >> 24;
          tile += 1;
        }
      }
      data.objects.set(key, decodeObjects(chunk.objects));
      data.cliffs.set(key, decodeCliffs(chunk.cliffEdges));
    }
    this.data = data;
    const result = { accepted: true, changedChunks, reset: reset || !current };
    const remaining = this.holdRemaining();
    if (remaining > 0 && !this.published) {
      this.held = this.held
        ? {
            accepted: true,
            changedChunks: [...new Set([...this.held.changedChunks, ...changedChunks])],
            reset: this.held.reset || result.reset,
          }
        : result;
      this.holdTimer ??= this.timing.setTimer(() => {
        this.holdTimer = null;
        this.showHeld();
      }, remaining);
      return result;
    }
    this.published = true;
    this.publish(result);
    return result;
  }

  private holdRemaining(): number {
    const hold = this.timing.holdMilliseconds;
    if (hold <= 0 || this.admittedAt === null || this.running?.kind !== 'preview') return 0;
    return Math.max(0, this.admittedAt + hold - this.timing.now());
  }

  private showHeld(): void {
    const change = this.held;
    this.held = null;
    if (!change || !this.data) return;
    this.published = true;
    this.publish(change);
  }

  private release(): void {
    if (this.holdTimer !== null) this.timing.clearTimer(this.holdTimer);
    this.holdTimer = null;
    this.held = null;
  }

  subscribe(listener: PreviewCandidateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terrainIds(): Uint16Array | null {
    return this.data?.terrainIds ?? null;
  }

  elevations(): Int8Array | null {
    return this.data?.elevations ?? null;
  }

  chunkGrid(): { columns: number; rows: number } | null {
    return this.data ? { columns: this.data.columns, rows: this.data.rows } : null;
  }

  chunkObjects(key: number): readonly CandidateObject[] {
    return this.data?.objects.get(key) ?? [];
  }

  chunkCliffs(key: number): readonly CandidateCliff[] {
    return this.data?.cliffs.get(key) ?? [];
  }

  private publish(change: CandidateApplyResult | null): void {
    const view = this.view;
    for (const listener of this.listeners) listener(view, change);
  }

  private publishActivity(): void {
    for (const listener of [...this.activityListeners]) listener();
  }
}

function viewOf(candidate: PreviewCandidate): PreviewCandidateView {
  return {
    requestId: candidate.requestId,
    revision: candidate.revision,
    stage: candidate.stage,
    width: candidate.width,
    height: candidate.height,
    elapsedUs: candidate.elapsedUs,
    sample: candidate.sample ? { ...candidate.sample } : null,
  };
}

function decodeObjects(bytes: Uint8Array): CandidateObject[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const objects: CandidateObject[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += previewCandidateObjectRecordBytes) {
    objects.push({
      objectId: view.getUint32(offset, true),
      x: view.getUint32(offset + 4, true) / 256,
      y: view.getUint32(offset + 8, true) / 256,
      footprintWidth: Math.max(1, view.getUint16(offset + 12, true)) / 256,
      footprintHeight: Math.max(1, view.getUint16(offset + 14, true)) / 256,
      owner: bytes[offset + 16]!,
      presentationKind: bytes[offset + 17] === 1 ? 'wall' : 'object',
    });
  }
  return objects;
}

function decodeCliffs(bytes: Uint8Array): CandidateCliff[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cliffs: CandidateCliff[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 12) {
    cliffs.push({
      fromX: view.getUint16(offset, true),
      fromY: view.getUint16(offset + 2, true),
      toX: view.getUint16(offset + 4, true),
      toY: view.getUint16(offset + 6, true),
      cliffType: view.getUint32(offset + 8, true),
    });
  }
  return cliffs;
}

export function previewCandidateStageLabel(view: PreviewCandidateView): string {
  const stage: Record<PreviewCandidateStage, MessageId> = {
    land: 'preview-panel.candidate.stage.land',
    elevation: 'preview-panel.candidate.stage.elevation',
    cliffs: 'preview-panel.candidate.stage.cliffs',
    terrain: 'preview-panel.candidate.stage.terrain',
    connections: 'preview-panel.candidate.stage.connections',
    objects: 'preview-panel.candidate.stage.objects',
    'sample-complete': 'preview-panel.candidate.stage.finished',
  };
  if (view.sample) {
    const sample = { sample: view.sample.ordinal + 1, seed: view.sample.seed };
    return view.stage === 'sample-complete'
      ? t('preview-panel.candidate.sample-finished', sample)
      : t('preview-panel.candidate.sample-stage', { ...sample, stage: t(stage[view.stage]) });
  }
  return t('preview-panel.candidate.generating', { stage: t(stage[view.stage]) });
}
