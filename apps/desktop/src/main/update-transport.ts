import type { ClientRequestConstructorOptions, Session } from 'electron';
import { ReleaseTransportError } from './release-check';

export interface DownloadRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  maximumBytes: number;
  signal: AbortSignal;
  onChunk(chunk: Uint8Array): Promise<void>;
}

export type DownloadHop =
  | { kind: 'redirect'; status: number; location: string | null }
  | { kind: 'response'; status: number; declaredBytes: number | null };

export interface DownloadTransport {
  request(request: DownloadRequest): Promise<DownloadHop>;
}

export interface NetDownloadMessage {
  statusCode: number;
  headers: Record<string, string | string[]>;
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'aborted', listener: () => void): this;
  pause(): void;
  resume(): void;
}

export interface NetDownloadRequest {
  setHeader(name: string, value: string): void;
  on(event: 'response', listener: (response: NetDownloadMessage) => void): this;
  on(
    event: 'redirect',
    listener: (status: number, method: string, redirectUrl: string) => void,
  ): this;
  on(event: 'login', listener: (authInfo: unknown, callback: () => void) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  abort(): void;
  end(): void;
}

export type NetDownloadRequestFactory = (
  options: ClientRequestConstructorOptions,
) => NetDownloadRequest;

export function netDownloadTransport(
  createRequest: NetDownloadRequestFactory,
  session: Session,
): DownloadTransport {
  return {
    request: ({ url, headers, maximumBytes, signal, onChunk }) =>
      new Promise<DownloadHop>((resolve, reject) => {
        if (signal.aborted) {
          reject(new ReleaseTransportError('timeout'));
          return;
        }
        let settled = false;
        let request: NetDownloadRequest | undefined;
        const finish = (settle: () => void, abort: boolean) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          if (abort) request?.abort();
          settle();
        };
        const fail = (error: unknown) => finish(() => reject(error), true);
        const onAbort = () => fail(new ReleaseTransportError('timeout'));
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
          });
          for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
        } catch {
          fail(new ReleaseTransportError('offline'));
          return;
        }
        request.on('login', (_authInfo, callback) => callback());
        request.on('redirect', (status, _method, redirectUrl) =>
          finish(() => resolve({ kind: 'redirect', status, location: redirectUrl }), true),
        );
        request.on('error', () => fail(new ReleaseTransportError('offline')));
        request.on('response', (response) => {
          const declaredText = firstHeader(response.headers['content-length']);
          const declared = declaredText === null ? null : Number(declaredText);
          const declaredBytes =
            declared !== null && Number.isSafeInteger(declared) && declared >= 0 ? declared : null;
          if (response.statusCode !== 200) {
            finish(
              () => resolve({ kind: 'response', status: response.statusCode, declaredBytes }),
              true,
            );
            return;
          }
          if (declaredBytes !== null && declaredBytes > maximumBytes) {
            fail(new ReleaseTransportError('oversized'));
            return;
          }
          let length = 0;
          let writing: Promise<void> = Promise.resolve();
          response.on('data', (chunk) => {
            if (settled) return;
            length += chunk.length;
            if (length > maximumBytes) {
              fail(new ReleaseTransportError('oversized'));
              return;
            }
            response.pause();
            writing = writing
              .then(() => onChunk(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length)))
              .then(
                () => {
                  if (!settled) response.resume();
                },
                (error: unknown) => fail(error),
              );
          });
          response.on('end', () => {
            void writing.then(() =>
              finish(() => resolve({ kind: 'response', status: 200, declaredBytes }), false),
            );
          });
          response.on('error', () => fail(new ReleaseTransportError('offline')));
          response.on('aborted', () => fail(new ReleaseTransportError('offline')));
        });
        request.end();
      }),
  };
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return (Array.isArray(value) ? value[0] : value) ?? null;
}
