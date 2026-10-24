import { randomUUID } from 'node:crypto';
import type {
  ConnectorRendererReply,
  ConnectorRendererRequest,
  ConnectorRendererRequestKind,
} from '../../shared/connector-api';
import { ConnectorToolError } from './dispatcher';

const maximumPendingRequests = 64;

interface PendingRequest {
  resolve(payload: unknown): void;
  reject(error: ConnectorToolError): void;
}

export interface ConnectorRendererRequestOptions {
  timeoutMilliseconds: number;
  signal?: AbortSignal;
}

export class ConnectorRendererBridge {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly send: (request: ConnectorRendererRequest) => boolean) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  request(
    kind: ConnectorRendererRequestKind,
    payload: unknown,
    options: ConnectorRendererRequestOptions,
  ): Promise<unknown> {
    if (options.signal?.aborted) {
      return Promise.reject(new ConnectorToolError('cancelled', 'The call was cancelled.'));
    }
    if (this.pending.size >= maximumPendingRequests) {
      return Promise.reject(
        new ConnectorToolError('internal', 'AoE2RMSIDE has too many requests open.', {
          hint: 'Wait for running calls to finish.',
        }),
      );
    }
    const requestId = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', aborted);
        this.pending.delete(requestId);
      };
      const aborted = () => {
        cleanup();
        reject(new ConnectorToolError('cancelled', 'The call was cancelled.'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new ConnectorToolError('internal', 'The AoE2RMSIDE window did not answer in time.'));
      }, options.timeoutMilliseconds);
      this.pending.set(requestId, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      options.signal?.addEventListener('abort', aborted, { once: true });
      let sent = false;
      try {
        sent = this.send({ requestId, kind, payload });
      } catch {
        sent = false;
      }
      if (!sent) {
        this.pending
          .get(requestId)
          ?.reject(new ConnectorToolError('internal', 'The AoE2RMSIDE window is not open.'));
      }
    });
  }

  reply(reply: ConnectorRendererReply): void {
    const request = this.pending.get(reply.requestId);
    if (!request) return;
    if (reply.ok) request.resolve(reply.payload);
    else request.reject(new ConnectorToolError(reply.error.code, reply.error.message));
  }

  rendererReset(): void {
    for (const request of [...this.pending.values()]) {
      request.reject(new ConnectorToolError('internal', 'The AoE2RMSIDE window reloaded.'));
    }
  }
}
