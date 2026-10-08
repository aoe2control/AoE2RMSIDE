import {
  maximumPreviewCandidateBytes,
  previewCandidateBytes,
  previewCandidateChunkGrid,
  type PreviewCandidate,
  type PreviewCandidateAcknowledgement,
  type PreviewCandidateChunk,
  type PreviewCandidateSample,
  type PreviewCandidateStage,
} from '../shared/preview-candidate';
import { LatestValuePublisher } from './latest-value-publisher';

export interface PresentationSink<TFinal> {
  candidate(candidate: PreviewCandidate): boolean;
  final(value: TFinal): void;
}

export interface PresentationArbiterStatistics {
  offered: number;
  sent: number;
  coalesced: number;
  rejected: number;
  maximumHeldBytes: number;
  outstanding: number;
}

class CandidateLane {
  readonly chunks = new Map<number, PreviewCandidateChunk>();
  readonly dirty = new Set<number>();
  width = 0;
  height = 0;
  stage: PreviewCandidateStage = 'land';
  elapsedUs = 0;
  sample: PreviewCandidateSample | undefined;
  revision = 0;
  acknowledged = 0;
  outstanding: number | null = null;
  keyframe = true;
  broken = false;

  constructor(readonly requestId: string) {}
}

export class PreviewPresentationArbiter<TFinal> {
  private lane: CandidateLane | null = null;
  private readonly finals: LatestValuePublisher<TFinal>;
  private readonly counters: PresentationArbiterStatistics = {
    offered: 0,
    sent: 0,
    coalesced: 0,
    rejected: 0,
    maximumHeldBytes: 0,
    outstanding: 0,
  };

  constructor(
    private readonly sink: PresentationSink<TFinal>,
    finalIntervalMilliseconds = 33,
  ) {
    this.finals = new LatestValuePublisher(
      (value) => this.sink.final(value),
      finalIntervalMilliseconds,
    );
  }

  beginCandidates(requestId: string): void {
    this.revokeCandidates();
    this.lane = new CandidateLane(requestId);
  }

  holdsLease(requestId: string): boolean {
    return this.lane?.requestId === requestId;
  }

  offerCandidate(candidate: PreviewCandidate): void {
    const lane = this.lane;
    if (!lane || lane.requestId !== candidate.requestId) {
      this.counters.rejected += 1;
      return;
    }
    this.counters.offered += 1;
    if (candidate.baseRevision === 0) {
      lane.chunks.clear();
      lane.dirty.clear();
      lane.keyframe = true;
      lane.broken = false;
      lane.width = candidate.width;
      lane.height = candidate.height;
    } else if (
      lane.broken ||
      candidate.baseRevision !== lane.revision ||
      candidate.width !== lane.width ||
      candidate.height !== lane.height
    ) {
      lane.broken = true;
      this.counters.rejected += 1;
      return;
    }
    const { columns } = previewCandidateChunkGrid(candidate.width, candidate.height);
    for (const chunk of candidate.chunks) {
      const key = chunk.chunkY * columns + chunk.chunkX;
      lane.chunks.set(key, chunk);
      lane.dirty.add(key);
    }
    lane.revision = candidate.revision;
    lane.stage = candidate.stage;
    lane.elapsedUs = candidate.elapsedUs;
    lane.sample = candidate.sample;
    const held = previewCandidateBytes({ chunks: [...lane.chunks.values()] });
    this.counters.maximumHeldBytes = Math.max(this.counters.maximumHeldBytes, held);
    if (held > maximumPreviewCandidateBytes) {
      this.revokeCandidates();
      return;
    }
    if (lane.outstanding !== null) this.counters.coalesced += 1;
    this.flush(lane);
  }

  acknowledge(acknowledgement: PreviewCandidateAcknowledgement): void {
    const lane = this.lane;
    if (
      !lane ||
      lane.requestId !== acknowledgement.requestId ||
      lane.outstanding !== acknowledgement.revision
    ) {
      return;
    }
    lane.outstanding = null;
    this.counters.outstanding = 0;
    if (acknowledgement.accepted) {
      lane.acknowledged = acknowledgement.revision;
    } else {
      lane.acknowledged = 0;
      lane.keyframe = true;
    }
    this.flush(lane);
  }

  revokeCandidates(requestId?: string): void {
    const lane = this.lane;
    if (!lane || (requestId !== undefined && lane.requestId !== requestId)) return;
    if (lane.revision > lane.acknowledged && lane.outstanding === null)
      this.counters.coalesced += 1;
    this.lane = null;
    this.counters.outstanding = 0;
  }

  offerFinal(value: TFinal): void {
    this.revokeCandidates();
    this.finals.offer(value);
  }

  flushFinals(): void {
    this.finals.flush();
  }

  statistics(): PresentationArbiterStatistics {
    return { ...this.counters };
  }

  dispose(): void {
    this.revokeCandidates();
    this.finals.dispose();
  }

  private flush(lane: CandidateLane): void {
    if (this.lane !== lane || lane.outstanding !== null || lane.broken) return;
    if (lane.revision === 0 || (lane.revision === lane.acknowledged && !lane.keyframe)) return;
    const whole = lane.keyframe || lane.acknowledged === 0;
    const keys = whole ? [...lane.chunks.keys()] : [...lane.dirty];
    keys.sort((left, right) => left - right);
    const candidate: PreviewCandidate = {
      requestId: lane.requestId,
      revision: lane.revision,
      baseRevision: whole ? 0 : lane.acknowledged,
      stage: lane.stage,
      width: lane.width,
      height: lane.height,
      elapsedUs: lane.elapsedUs,
      ...(lane.sample ? { sample: lane.sample } : {}),
      chunks: keys.map((key) => lane.chunks.get(key)!),
    };
    lane.dirty.clear();
    lane.keyframe = false;
    lane.outstanding = lane.revision;
    this.counters.outstanding = 1;
    if (this.sink.candidate(candidate)) {
      this.counters.sent += 1;
    } else {
      this.revokeCandidates(lane.requestId);
    }
  }
}
