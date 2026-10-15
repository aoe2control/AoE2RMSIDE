import { ReleaseTransportError, type ReleaseTransport } from './release-check';
import type { DownloadTransport } from './update-transport';

interface FixtureResponse {
  status: number;
  location?: string;
  body?: unknown;
  bytes?: { size: number; pattern: string };
  chunkBytes?: number;
  chunkDelayMs?: number;
}

export interface UpdateFixture {
  installation: 'installed' | 'portable';
  releaseTransport: ReleaseTransport;
  downloadTransport: DownloadTransport;
  readonly requests: readonly string[];
}

const maximumFixtureBytes = 64 * 1024 * 1024;

export function updateFixtureBytes(size: number, pattern: string): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = pattern.charCodeAt(index % pattern.length) & 0xff;
  }
  return bytes;
}

function responseBody(response: FixtureResponse): Uint8Array {
  if (response.bytes) return updateFixtureBytes(response.bytes.size, response.bytes.pattern);
  if (response.body === undefined) return new Uint8Array();
  return new TextEncoder().encode(
    typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
  );
}

function validResponse(value: unknown): value is FixtureResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { status, location, bytes, chunkBytes, chunkDelayMs } = value as Record<string, unknown>;
  if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599) {
    return false;
  }
  if (location !== undefined && typeof location !== 'string') return false;
  if (bytes !== undefined) {
    if (!bytes || typeof bytes !== 'object') return false;
    const { size, pattern } = bytes as Record<string, unknown>;
    if (
      !Number.isSafeInteger(size) ||
      (size as number) < 0 ||
      (size as number) > maximumFixtureBytes
    ) {
      return false;
    }
    if (typeof pattern !== 'string' || pattern.length === 0) return false;
  }
  if (
    chunkBytes !== undefined &&
    (!Number.isSafeInteger(chunkBytes) || (chunkBytes as number) < 1)
  ) {
    return false;
  }
  if (
    chunkDelayMs !== undefined &&
    (!Number.isSafeInteger(chunkDelayMs) ||
      (chunkDelayMs as number) < 0 ||
      (chunkDelayMs as number) > 10_000)
  ) {
    return false;
  }
  return true;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ReleaseTransportError('timeout'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ReleaseTransportError('timeout'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function parseUpdateFixture(text: string): UpdateFixture | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { installation, responses } = value as Record<string, unknown>;
  if (installation !== 'installed' && installation !== 'portable') return null;
  if (!responses || typeof responses !== 'object' || Array.isArray(responses)) return null;
  const table = new Map<string, FixtureResponse>();
  for (const [url, response] of Object.entries(responses as Record<string, unknown>)) {
    if (!validResponse(response)) return null;
    table.set(url, response);
  }
  const requests: string[] = [];
  const answer = (url: string): FixtureResponse => {
    requests.push(url);
    const response = table.get(url);
    if (!response) throw new ReleaseTransportError('offline');
    return response;
  };
  return {
    installation,
    requests,
    releaseTransport: {
      async request(request) {
        if (request.signal.aborted) throw new ReleaseTransportError('timeout');
        const response = answer(request.url);
        if (response.location !== undefined) {
          return { kind: 'redirect', status: response.status, location: response.location };
        }
        const body = responseBody(response);
        if (body.byteLength > request.maximumBytes) throw new ReleaseTransportError('oversized');
        return { kind: 'response', status: response.status, etag: null, body };
      },
    },
    downloadTransport: {
      async request(request) {
        if (request.signal.aborted) throw new ReleaseTransportError('timeout');
        const response = answer(request.url);
        if (response.location !== undefined) {
          return { kind: 'redirect', status: response.status, location: response.location };
        }
        const body = responseBody(response);
        if (response.status !== 200) {
          return { kind: 'response', status: response.status, declaredBytes: body.byteLength };
        }
        if (body.byteLength > request.maximumBytes) throw new ReleaseTransportError('oversized');
        const chunkBytes = response.chunkBytes ?? 64 * 1024;
        for (let offset = 0; offset < body.byteLength; offset += chunkBytes) {
          if (response.chunkDelayMs) await delay(response.chunkDelayMs, request.signal);
          if (request.signal.aborted) throw new ReleaseTransportError('timeout');
          await request.onChunk(body.subarray(offset, offset + chunkBytes));
        }
        return { kind: 'response', status: 200, declaredBytes: body.byteLength };
      },
    },
  };
}
