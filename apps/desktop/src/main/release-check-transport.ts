import type { ClientRequestConstructorOptions, Session } from 'electron';
import { ReleaseTransportError, type ReleaseHop, type ReleaseTransport } from './release-check';

export interface NetClientRequest {
  setHeader(name: string, value: string): void;
  on(event: 'response', listener: (response: NetIncomingMessage) => void): this;
  on(
    event: 'redirect',
    listener: (status: number, method: string, redirectUrl: string) => void,
  ): this;
  on(event: 'login', listener: (authInfo: unknown, callback: () => void) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  abort(): void;
  end(): void;
}

export interface NetIncomingMessage {
  statusCode: number;
  headers: Record<string, string | string[]>;
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'aborted', listener: () => void): this;
}

export type NetRequestFactory = (options: ClientRequestConstructorOptions) => NetClientRequest;

export const releaseCheckPartition = 'rmside-release-check';

export function netReleaseTransport(
  createRequest: NetRequestFactory,
  session: Session,
): ReleaseTransport {
  return {
    request: ({ url, headers, maximumBytes, signal }) =>
      new Promise<ReleaseHop>((resolve, reject) => {
        if (signal.aborted) {
          reject(new ReleaseTransportError('timeout'));
          return;
        }
        let settled = false;
        let request: NetClientRequest | undefined;
        const finish = (settle: () => void, abort: boolean) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          if (abort) request?.abort();
          settle();
        };
        const fail = (reason: ReleaseTransportError['reason']) =>
          finish(() => reject(new ReleaseTransportError(reason)), true);
        const onAbort = () => fail('timeout');
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          request = createRequest({
            method: 'GET',
            url,
            session,
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'manual',
            referrerPolicy: 'no-referrer',
            priority: 'idle',
          });
          for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
        } catch {
          fail('offline');
          return;
        }
        request.on('login', (_authInfo, callback) => callback());
        request.on('redirect', (status, _method, redirectUrl) =>
          finish(() => resolve({ kind: 'redirect', status, location: redirectUrl }), true),
        );
        request.on('error', () => fail('offline'));
        request.on('response', (response) => {
          const declared = Number(firstHeader(response.headers['content-length']));
          if (Number.isFinite(declared) && declared > maximumBytes) {
            fail('oversized');
            return;
          }
          const chunks: Buffer[] = [];
          let length = 0;
          response.on('data', (chunk) => {
            if (settled) return;
            length += chunk.length;
            if (length > maximumBytes) {
              fail('oversized');
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () =>
            finish(
              () =>
                resolve({
                  kind: 'response',
                  status: response.statusCode,
                  etag: firstHeader(response.headers.etag),
                  body: new Uint8Array(Buffer.concat(chunks, length)),
                }),
              false,
            ),
          );
          response.on('error', () => fail('offline'));
          response.on('aborted', () => fail('offline'));
        });
        request.end();
      }),
  };
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return (Array.isArray(value) ? value[0] : value) ?? null;
}
