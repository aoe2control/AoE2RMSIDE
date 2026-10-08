import * as latencyProbe from './latency-probe';
import type { PreviewCache, PreviewCacheDiagnostics } from './preview-cache';
import type { PreviewProvenanceOperation } from '../shared/api';
import type { RunOutcome, RunTrigger } from './run-outcome';

export type LivePreviewPhase =
  'editing' | 'analyzing' | 'unchanged' | 'invalid' | 'generating' | 'current' | 'failed';

export interface LivePreviewDocument {
  id: string;
  uri: string;
  content: string;
  revision: number;
}

export interface LivePreviewAnalysis {
  documentRevision: string;
  profileId: string;
  semanticHash: string;
  operations: PreviewProvenanceOperation[];
  sourceCatalogProof?: string;
}

export interface LivePreviewStatus {
  phase: LivePreviewPhase;
  requestId: number;
  documentRevision: number;
  semanticHash?: string;
  generationMs?: number;
  message?: string;
}

export interface LivePreviewJob<TConfiguration> {
  backendIdentity: string;
  trigger: RunTrigger;
  configuration: TConfiguration;
  configurationKey: string;
  document: LivePreviewDocument;
}

export interface LivePreviewAdapter<TResult, TConfiguration> {
  analyze(job: LivePreviewJob<TConfiguration>): Promise<LivePreviewAnalysis>;
  validateAnalysis?(
    job: LivePreviewJob<TConfiguration>,
    analysis: LivePreviewAnalysis,
  ): Promise<void>;
  generate(
    job: LivePreviewJob<TConfiguration>,
    analysis: Promise<LivePreviewAnalysis>,
    signal: AbortSignal,
    requestId: number,
    responded?: () => void,
  ): Promise<TResult>;
  speculate?(job: LivePreviewJob<TConfiguration>): boolean;
  reuse(result: TResult, analysis: LivePreviewAnalysis, document: LivePreviewDocument): TResult;
  historical?(result: TResult, document: LivePreviewDocument): TResult;
  commit(
    result: TResult,
    job: LivePreviewJob<TConfiguration>,
    kind: 'generated' | 'reused' | 'historical',
  ): void;
  reject(outcome: RunOutcome, job: LivePreviewJob<TConfiguration>): void;
  status(status: LivePreviewStatus): void;
}

export class LivePreviewCancellationError extends Error {
  constructor(message = 'preview generation was cancelled') {
    super(message);
    this.name = 'LivePreviewCancellationError';
  }
}

export class LivePreviewSourceChangedError extends Error {
  constructor(message = 'the source changed while the preview was generating') {
    super(message);
    this.name = 'LivePreviewSourceChangedError';
  }
}

export type LivePreviewRejection = 'superseded' | 'cancelled' | 'source-changed' | 'failed';

export function classifyLivePreviewRejection(
  error: unknown,
  { current, aborted }: { current: boolean; aborted: boolean },
): LivePreviewRejection {
  if (!current || aborted || isAbortError(error)) return 'superseded';
  if (error instanceof LivePreviewCancellationError) return 'cancelled';
  if (error instanceof LivePreviewSourceChangedError) return 'source-changed';
  return 'failed';
}

export function livePreviewRejectionOutcome(
  rejection: LivePreviewRejection,
  error: unknown,
): RunOutcome {
  switch (rejection) {
    case 'superseded':
      return { kind: 'superseded', reason: 'newer-run' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'source-changed':
      return { kind: 'superseded', reason: 'source-changed' };
    case 'failed':
      return { kind: 'failed', stage: 'generation', message: errorMessage(error) };
  }
}

export interface LivePreviewScheduleOptions {
  debounceMs?: number;
}

interface ActiveGeneration<TResult> {
  controller: AbortController;
  result: Promise<TResult>;
  startedAt: number;
  validation(): Promise<void> | undefined;
}

export class LivePreviewCoordinator<TResult, TConfiguration> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: AbortController | undefined;
  private generationSettled: Promise<void> = Promise.resolve();
  private epoch = 0;
  private cancelledRequestId = 0;
  private lastCompleted: { key: string; result: TResult } | undefined;
  private lastJob: LivePreviewJob<TConfiguration> | undefined;
  private readonly knownConfigurations = new Set<string>();

  constructor(
    private readonly adapter: LivePreviewAdapter<TResult, TConfiguration>,
    private readonly cache?: PreviewCache<TResult>,
  ) {}

  schedule(
    job: LivePreviewJob<TConfiguration>,
    { debounceMs = 250 }: LivePreviewScheduleOptions = {},
  ): void {
    const requestId = ++this.epoch;
    this.lastJob = job;
    latencyProbe.runScheduled(job);
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.active?.abort();
    this.active = undefined;
    this.adapter.status({
      phase: 'editing',
      requestId,
      documentRevision: job.document.revision,
    });
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.execute(job, requestId);
      },
      Math.max(0, debounceMs),
    );
  }

  cancel(): void {
    this.cancelledRequestId = this.epoch;
    this.epoch += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.active?.abort();
    this.active = undefined;
  }

  sourceInvalidated(): void {
    this.cancel();
    if (this.lastJob)
      this.adapter.status({
        phase: 'editing',
        requestId: this.epoch,
        documentRevision: this.lastJob.document.revision,
      });
  }

  seedCompleted(key: string, result: TResult): void {
    this.lastCompleted = { key, result };
    this.cache?.set(key, result);
    try {
      const { backendIdentity, configurationKey } = JSON.parse(key) as {
        backendIdentity: string;
        configurationKey: string;
      };
      this.knownConfigurations.add(configurationIdentity(backendIdentity, configurationKey));
    } catch {}
  }

  clearCache(): void {
    this.cache?.clear();
    this.lastCompleted = undefined;
    this.knownConfigurations.clear();
  }

  cacheDiagnostics(): PreviewCacheDiagnostics | null {
    return this.cache?.diagnostics() ?? null;
  }

  private staleOutcome(requestId: number): RunOutcome {
    return requestId === this.cancelledRequestId
      ? { kind: 'cancelled' }
      : { kind: 'superseded', reason: 'newer-run' };
  }

  private async startGeneration(
    job: LivePreviewJob<TConfiguration>,
    analysis: Promise<LivePreviewAnalysis>,
    requestId: number,
  ): Promise<ActiveGeneration<TResult> | undefined> {
    latencyProbe.runMark(job, 'settle-wait');
    await this.generationSettled;
    if (requestId !== this.epoch) return undefined;
    const controller = new AbortController();
    this.active = controller;
    const startedAt = performance.now();
    latencyProbe.runMark(job, 'generation-start');
    let validation: Promise<void> | undefined;
    const validateAnalysis = this.adapter.validateAnalysis?.bind(this.adapter);
    const responded = () => {
      if (validation || !validateAnalysis) return;
      validation = analysis.then((resolved) => validateAnalysis(job, resolved));
      validation.catch(() => undefined);
    };
    const generation = this.adapter.generate(
      job,
      analysis,
      controller.signal,
      requestId,
      responded,
    );
    this.generationSettled = generation.then(
      () => undefined,
      () => undefined,
    );
    const result = abortable(generation, controller.signal);
    result.catch(() => undefined);
    return { controller, result, startedAt, validation: () => validation };
  }

  private async execute(job: LivePreviewJob<TConfiguration>, requestId: number): Promise<void> {
    if (requestId !== this.epoch) {
      this.adapter.reject(this.staleOutcome(requestId), job);
      return;
    }
    latencyProbe.runMark(job, 'execute');
    this.adapter.status({
      phase: 'analyzing',
      requestId,
      documentRevision: job.document.revision,
    });
    latencyProbe.runMark(job, 'analysis-start');
    const pendingAnalysis = this.adapter.analyze(job);
    pendingAnalysis.then(
      () => latencyProbe.runMark(job, 'analysis-end'),
      () => undefined,
    );
    let generation: ActiveGeneration<TResult> | undefined;
    if (
      !this.knownConfigurations.has(
        configurationIdentity(job.backendIdentity, job.configurationKey),
      ) &&
      (this.adapter.speculate?.(job) ?? true)
    ) {
      generation = await this.startGeneration(job, pendingAnalysis, requestId);
      if (!generation) {
        this.adapter.reject(this.staleOutcome(requestId), job);
        return;
      }
    }
    let analysis: LivePreviewAnalysis;
    try {
      analysis = await pendingAnalysis;
      await this.adapter.validateAnalysis?.(job, analysis);
    } catch (error) {
      this.abandon(generation);
      if (requestId !== this.epoch) {
        this.adapter.reject(this.staleOutcome(requestId), job);
        return;
      }
      if (this.lastCompleted && this.adapter.historical) {
        this.adapter.commit(
          this.adapter.historical(this.lastCompleted.result, job.document),
          job,
          'historical',
        );
      }
      this.adapter.status({
        phase: 'invalid',
        requestId,
        documentRevision: job.document.revision,
        message: errorMessage(error),
      });
      this.adapter.reject({ kind: 'failed', stage: 'analysis', message: errorMessage(error) }, job);
      return;
    }
    if (requestId !== this.epoch) {
      this.abandon(generation);
      this.adapter.reject(this.staleOutcome(requestId), job);
      return;
    }
    const key = livePreviewGenerationKey(
      job.backendIdentity,
      analysis.semanticHash,
      job.configurationKey,
    );
    const cached = generation
      ? undefined
      : (this.cache?.get(key) ??
        (this.lastCompleted?.key === key ? this.lastCompleted.result : undefined));
    if (cached) {
      latencyProbe.runMark(job, 'reuse');
      this.adapter.status({
        phase: 'unchanged',
        requestId,
        documentRevision: job.document.revision,
        semanticHash: analysis.semanticHash,
      });
      const reused = this.adapter.reuse(cached, analysis, job.document);
      this.remember(key, job, reused);
      latencyProbe.runCommitted(job);
      this.adapter.commit(reused, job, 'reused');
      this.adapter.status({
        phase: 'current',
        requestId,
        documentRevision: job.document.revision,
        semanticHash: analysis.semanticHash,
        generationMs: 0,
        message: 'Semantic no-op; reused the completed map.',
      });
      return;
    }

    generation ??= await this.startGeneration(job, pendingAnalysis, requestId);
    if (!generation) {
      this.adapter.reject(this.staleOutcome(requestId), job);
      return;
    }
    const { controller, startedAt } = generation;
    this.adapter.status({
      phase: 'generating',
      requestId,
      documentRevision: job.document.revision,
      semanticHash: analysis.semanticHash,
    });
    try {
      const result = await generation.result;
      await (generation.validation() ?? this.adapter.validateAnalysis?.(job, analysis));
      if (requestId !== this.epoch || controller.signal.aborted) {
        this.adapter.reject(this.staleOutcome(requestId), job);
        return;
      }
      const generationMs = Math.max(0, performance.now() - startedAt);
      latencyProbe.runMark(job, 'generation-end');
      this.remember(key, job, result);
      latencyProbe.runCommitted(job);
      this.adapter.commit(result, job, 'generated');
      this.adapter.status({
        phase: 'current',
        requestId,
        documentRevision: job.document.revision,
        semanticHash: analysis.semanticHash,
        generationMs,
      });
    } catch (error) {
      const rejection = classifyLivePreviewRejection(error, {
        current: requestId === this.epoch,
        aborted: controller.signal.aborted,
      });
      const outcome =
        rejection === 'superseded'
          ? this.staleOutcome(requestId)
          : livePreviewRejectionOutcome(rejection, error);
      if (rejection === 'source-changed') {
        this.adapter.status({
          phase: 'editing',
          requestId,
          documentRevision: job.document.revision,
          semanticHash: analysis.semanticHash,
          generationMs: Math.max(0, performance.now() - startedAt),
          message: errorMessage(error),
        });
      } else if (rejection === 'failed') {
        this.lastCompleted = undefined;
      }
      this.adapter.reject(outcome, job);
      if (rejection !== 'failed') return;
      this.adapter.status({
        phase: 'failed',
        requestId,
        documentRevision: job.document.revision,
        semanticHash: analysis.semanticHash,
        generationMs: Math.max(0, performance.now() - startedAt),
        message: errorMessage(error),
      });
    } finally {
      if (this.active === controller) this.active = undefined;
    }
  }

  private abandon(generation: ActiveGeneration<TResult> | undefined): void {
    if (!generation) return;
    generation.controller.abort();
    if (this.active === generation.controller) this.active = undefined;
  }

  private remember(key: string, job: LivePreviewJob<TConfiguration>, result: TResult): void {
    this.lastCompleted = { key, result };
    this.cache?.set(key, result);
    this.knownConfigurations.add(configurationIdentity(job.backendIdentity, job.configurationKey));
  }
}

function configurationIdentity(backendIdentity: string, configurationKey: string): string {
  return JSON.stringify({ backendIdentity, configurationKey });
}

export function livePreviewGenerationKey(
  backendIdentity: string,
  semanticHash: string,
  configurationKey: string,
): string {
  return JSON.stringify({ backendIdentity, semanticHash, configurationKey });
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function abortError(): Error {
  const error = new Error('preview generation was superseded');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
