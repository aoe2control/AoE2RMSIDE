import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  validatePictureRequest,
  type PictureRequest,
  type PictureResult,
} from './picture-contract';
import { PictureError } from './picture-error';
import type { PictureWorkerResponse } from './picture-worker-protocol';

export interface PictureService {
  render(request: PictureRequest, signal?: AbortSignal): Promise<PictureResult>;
  dispose(): Promise<void>;
}

export interface PictureWorkerHandle {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export interface PictureServiceOptions {
  createWorker: () => PictureWorkerHandle;
  deadlineMs?: number;
  maximumQueued?: number;
  idleMs?: number;
}

export const pictureServiceDefaults = Object.freeze({
  deadlineMs: 10_000,
  maximumQueued: 4,
  idleMs: 60_000,
  workerHeapMb: 768,
});

export const pictureWorkerFileName = 'picture-worker.cjs';

export function createBundledPictureWorker(directory: string): PictureWorkerHandle {
  const code = readFileSync(join(directory, pictureWorkerFileName), 'utf8');
  return new Worker(code, {
    eval: true,
    name: 'pictures',
    resourceLimits: { maxOldGenerationSizeMb: pictureServiceDefaults.workerHeapMb },
  });
}

interface Job {
  id: number;
  request: PictureRequest;
  signal?: AbortSignal;
  resolve(result: PictureResult): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

export function createPictureService(options: PictureServiceOptions): PictureService {
  const deadlineMs = options.deadlineMs ?? pictureServiceDefaults.deadlineMs;
  const maximumQueued = options.maximumQueued ?? pictureServiceDefaults.maximumQueued;
  const idleMs = options.idleMs ?? pictureServiceDefaults.idleMs;
  let worker: PictureWorkerHandle | null = null;
  let running: Job | null = null;
  const queue: Job[] = [];
  let nextId = 1;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const stopWorker = () => {
    const current = worker;
    worker = null;
    if (current) void current.terminate().catch(() => undefined);
  };

  const finish = (job: Job) => {
    if (job.timer) clearTimeout(job.timer);
    if (job.onAbort) job.signal?.removeEventListener('abort', job.onAbort);
    if (running === job) running = null;
  };

  const ensureWorker = (): PictureWorkerHandle => {
    if (worker) return worker;
    const created = options.createWorker();
    worker = created;
    created.on('message', (message) => {
      if (worker !== created) return;
      const response = message as PictureWorkerResponse;
      const job = running;
      if (!job || response?.id !== job.id) return;
      finish(job);
      if (response.ok) {
        job.resolve(response.result);
      } else {
        job.reject(new PictureError(response.code, response.message));
      }
      pump();
    });
    const lost = (message: string) => {
      if (worker !== created) return;
      worker = null;
      const job = running;
      if (job) {
        finish(job);
        job.reject(new PictureError('worker-failed', message));
      }
      pump();
    };
    created.on('error', (error) => lost(`the picture worker failed: ${error.message}`));
    created.on('exit', (code) => lost(`the picture worker stopped (code ${code})`));
    return created;
  };

  const pump = () => {
    if (running || disposed) return;
    const job = queue.shift();
    if (!job) {
      clearIdle();
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (!running && queue.length === 0) stopWorker();
      }, idleMs);
      (idleTimer as { unref?: () => void }).unref?.();
      return;
    }
    clearIdle();
    running = job;
    job.timer = setTimeout(() => {
      if (running !== job) return;
      finish(job);
      stopWorker();
      job.reject(new PictureError('timeout', 'the picture took too long to draw'));
      pump();
    }, deadlineMs);
    try {
      ensureWorker().postMessage({ id: job.id, request: job.request });
    } catch (error) {
      finish(job);
      stopWorker();
      job.reject(
        new PictureError(
          'worker-failed',
          error instanceof Error ? error.message : 'the picture worker could not start',
        ),
      );
      pump();
    }
  };

  return {
    render(value, signal) {
      if (disposed) return Promise.reject(new PictureError('worker-failed', 'pictures are closed'));
      let request: PictureRequest;
      try {
        request = validatePictureRequest(value);
      } catch (error) {
        return Promise.reject(error);
      }
      if (signal?.aborted) {
        return Promise.reject(new PictureError('cancelled', 'the picture was cancelled'));
      }
      if (running && queue.length >= maximumQueued) {
        return Promise.reject(new PictureError('busy', 'other pictures are being drawn'));
      }
      return new Promise<PictureResult>((resolve, reject) => {
        const job: Job = { id: nextId++, request, signal, resolve, reject };
        if (signal) {
          job.onAbort = () => {
            const index = queue.indexOf(job);
            if (index >= 0) {
              queue.splice(index, 1);
            } else if (running === job) {
              stopWorker();
            } else {
              return;
            }
            finish(job);
            reject(new PictureError('cancelled', 'the picture was cancelled'));
            pump();
          };
          signal.addEventListener('abort', job.onAbort, { once: true });
        }
        queue.push(job);
        pump();
      });
    },
    async dispose() {
      disposed = true;
      clearIdle();
      const pending = [...(running ? [running] : []), ...queue.splice(0)];
      for (const job of pending) {
        finish(job);
        job.reject(new PictureError('cancelled', 'pictures are closed'));
      }
      running = null;
      const current = worker;
      worker = null;
      if (current) await current.terminate().catch(() => undefined);
    },
  };
}
