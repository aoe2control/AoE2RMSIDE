import { join } from 'node:path';
import { outputNote, type OutputMessage } from '../shared/output-message';
import { readFileBounded, replaceFileAtomically } from './bounded-file';
import {
  compareSemanticVersions,
  formatSemanticVersion,
  isPrerelease,
  parseReleaseTag,
  parseSemanticVersion,
} from './semantic-version';

export const releaseRepository = 'aoe2control/AoE2RMSIDE';

export const releaseCheckEndpoint = `https://api.github.com/repos/${releaseRepository}/releases/latest`;

export const releaseCheckLimits = Object.freeze({
  maximumResponseBytes: 256 * 1024,
  deadlineMs: 10_000,
  maximumRedirects: 3,
  maximumCacheBytes: 4 * 1024,
});

export function releaseCheckHeaders(etag: string | null): Readonly<Record<string, string>> {
  return Object.freeze({
    Accept: 'application/vnd.github+json',
    'User-Agent': 'AoE2RMSIDE',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(etag === null ? {} : { 'If-None-Match': etag }),
  });
}

export function releaseCheckUrlAllowed(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || url.port !== '') {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  const repositoryPath = `/repos/${releaseRepository}/releases/latest`.toLowerCase();
  return (
    url.pathname.toLowerCase() === repositoryPath ||
    /^\/repositories\/[1-9][0-9]{0,15}\/releases\/latest$/u.test(url.pathname)
  );
}

const redirectStatuses: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export interface ReleaseRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  maximumBytes: number;
  signal: AbortSignal;
}

export type ReleaseHop =
  | { kind: 'redirect'; status: number; location: string | null }
  | { kind: 'response'; status: number; etag: string | null; body: Uint8Array };

export interface ReleaseTransport {
  request(request: ReleaseRequest): Promise<ReleaseHop>;
}

export class ReleaseTransportError extends Error {
  constructor(readonly reason: 'oversized' | 'timeout' | 'offline') {
    super(`release check transport failed: ${reason}`);
    this.name = 'ReleaseTransportError';
  }
}

export interface ReleaseCheckCache {
  etag: string;
  version: string;
}

export interface ReleaseCheckCacheStore {
  read(): Promise<ReleaseCheckCache | null>;
  write(cache: ReleaseCheckCache): Promise<void>;
}

export type ReleaseCheckQuietReason =
  | 'equal'
  | 'older'
  | 'current-version-malformed'
  | 'malformed'
  | 'prerelease'
  | 'not-modified-without-cache'
  | 'rate-limited'
  | 'unavailable'
  | 'redirect-refused'
  | 'too-many-redirects'
  | 'oversized'
  | 'timeout'
  | 'offline';

export type ReleaseCheckOutcome =
  | { kind: 'newer'; version: string; currentVersion: string }
  | { kind: 'quiet'; reason: ReleaseCheckQuietReason };

export interface ReleaseCheckOptions {
  currentVersion: string;
  transport: ReleaseTransport;
  cache: ReleaseCheckCacheStore;
  deadlineMs?: number;
}

const entityTagPattern = /^(?:W\/)?"[\x21\x23-\x7e]{0,250}"$/u;

export function validEntityTag(value: unknown): string | null {
  return typeof value === 'string' && entityTagPattern.test(value) ? value : null;
}

export async function checkForNewerRelease(
  options: ReleaseCheckOptions,
): Promise<ReleaseCheckOutcome> {
  const current = parseSemanticVersion(options.currentVersion);
  if (!current) return quiet('current-version-malformed');
  const cached = await options.cache.read().catch(() => null);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.deadlineMs ?? releaseCheckLimits.deadlineMs,
  );
  let answer: ReleaseHop & { kind: 'response' };
  try {
    const fetched = await fetchLatest(options.transport, cached?.etag ?? null, controller.signal);
    if (fetched.kind === 'quiet') return fetched;
    answer = fetched.answer;
  } finally {
    clearTimeout(timer);
  }

  let latestText: string;
  if (answer.status === 304) {
    if (!cached) return quiet('not-modified-without-cache');
    latestText = cached.version;
  } else if (answer.status === 200) {
    const parsed = parseLatestRelease(answer.body);
    if (parsed === 'prerelease') return quiet('prerelease');
    if (!parsed) return quiet('malformed');
    latestText = parsed;
    const etag = validEntityTag(answer.etag);
    if (etag) await options.cache.write({ etag, version: latestText }).catch(() => undefined);
  } else if (answer.status === 403 || answer.status === 429) {
    return quiet('rate-limited');
  } else {
    return quiet('unavailable');
  }

  const latest = parseSemanticVersion(latestText);
  if (!latest) return quiet('malformed');
  if (isPrerelease(latest)) return quiet('prerelease');
  const order = compareSemanticVersions(latest, current);
  if (order === 0) return quiet('equal');
  if (order < 0) return quiet('older');
  return {
    kind: 'newer',
    version: formatSemanticVersion(latest),
    currentVersion: formatSemanticVersion(current),
  };
}

function quiet(reason: ReleaseCheckQuietReason): ReleaseCheckOutcome {
  return { kind: 'quiet', reason };
}

async function fetchLatest(
  transport: ReleaseTransport,
  etag: string | null,
  signal: AbortSignal,
): Promise<
  | { kind: 'answer'; answer: ReleaseHop & { kind: 'response' } }
  | (ReleaseCheckOutcome & { kind: 'quiet' })
> {
  let url = releaseCheckEndpoint;
  for (let redirects = 0; ; redirects += 1) {
    let hop: ReleaseHop;
    try {
      hop = await transport.request({
        url,
        headers: releaseCheckHeaders(etag),
        maximumBytes: releaseCheckLimits.maximumResponseBytes,
        signal,
      });
    } catch (error) {
      if (signal.aborted) return { kind: 'quiet', reason: 'timeout' };
      if (error instanceof ReleaseTransportError) return { kind: 'quiet', reason: error.reason };
      return { kind: 'quiet', reason: 'offline' };
    }
    if (signal.aborted) return { kind: 'quiet', reason: 'timeout' };
    if (hop.kind === 'response') {
      if (hop.body.byteLength > releaseCheckLimits.maximumResponseBytes) {
        return { kind: 'quiet', reason: 'oversized' };
      }
      return { kind: 'answer', answer: hop };
    }
    if (!redirectStatuses.has(hop.status) || hop.location === null) {
      return { kind: 'quiet', reason: 'unavailable' };
    }
    if (redirects >= releaseCheckLimits.maximumRedirects) {
      return { kind: 'quiet', reason: 'too-many-redirects' };
    }
    let next: string;
    try {
      next = new URL(hop.location, url).href;
    } catch {
      return { kind: 'quiet', reason: 'redirect-refused' };
    }
    if (!releaseCheckUrlAllowed(next)) return { kind: 'quiet', reason: 'redirect-refused' };
    url = next;
  }
}

export function parseLatestRelease(body: Uint8Array): string | 'prerelease' | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { tag_name: tag, draft, prerelease } = value as Record<string, unknown>;
  if (draft !== false || typeof prerelease !== 'boolean') return null;
  const version = parseReleaseTag(tag);
  if (!version) return null;
  if (prerelease || isPrerelease(version)) return 'prerelease';
  const text = tag as string;
  return text.startsWith('v') ? text.slice(1) : text;
}

export function releaseNoticeMessage(
  outcome: ReleaseCheckOutcome & { kind: 'newer' },
): OutputMessage {
  return outputNote(
    'Update',
    'update.release-available',
    { id: 'release-check.newer.headline', args: { version: outcome.version } },
    {
      cause: { id: 'release-check.newer.cause', args: { current: outcome.currentVersion } },
      action: { text: { id: 'release-check.newer.action' }, link: 'rmside-releases' },
    },
  );
}

export class StartupReleaseCheck {
  private taken = false;

  constructor(private readonly run: (() => Promise<ReleaseCheckOutcome>) | null) {}

  async take(): Promise<OutputMessage | null> {
    if (this.taken || !this.run) return null;
    this.taken = true;
    try {
      const outcome = await this.run();
      return outcome.kind === 'newer' ? releaseNoticeMessage(outcome) : null;
    } catch {
      return null;
    }
  }
}

export class FileReleaseCheckCacheStore implements ReleaseCheckCacheStore {
  private readonly path: string;

  constructor(userDataPath: string) {
    this.path = join(userDataPath, 'release-check-v1.json');
  }

  async read(): Promise<ReleaseCheckCache | null> {
    let text: string;
    try {
      text = (await readFileBounded(this.path, releaseCheckLimits.maximumCacheBytes)).toString(
        'utf8',
      );
    } catch {
      return null;
    }
    return parseReleaseCheckCache(text);
  }

  async write(cache: ReleaseCheckCache): Promise<void> {
    await replaceFileAtomically(
      this.path,
      JSON.stringify({ schemaVersion: 1, etag: cache.etag, version: cache.version }),
    );
  }
}

export function parseReleaseCheckCache(text: string): ReleaseCheckCache | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'etag,schemaVersion,version') return null;
  if (record.schemaVersion !== 1) return null;
  const etag = validEntityTag(record.etag);
  const version = parseSemanticVersion(record.version);
  if (!etag || !version || isPrerelease(version)) return null;
  return { etag, version: record.version as string };
}

interface FixtureHop {
  status: number;
  location?: string;
  etag?: string;
  body?: unknown;
}

export function fixtureReleaseTransport(
  text: string,
): (ReleaseTransport & { readonly requests: readonly ReleaseRequest[] }) | null {
  let hops: unknown;
  try {
    hops = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(hops) || hops.length < 1 || hops.length > 8) return null;
  const parsed: FixtureHop[] = [];
  for (const hop of hops as unknown[]) {
    if (!hop || typeof hop !== 'object') return null;
    const { status, location, etag } = hop as Record<string, unknown>;
    if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599) {
      return null;
    }
    if (location !== undefined && typeof location !== 'string') return null;
    if (etag !== undefined && typeof etag !== 'string') return null;
    parsed.push(hop as FixtureHop);
  }
  const requests: ReleaseRequest[] = [];
  return {
    requests,
    async request(request) {
      requests.push(request);
      if (request.signal.aborted) throw new ReleaseTransportError('timeout');
      const hop = parsed[Math.min(requests.length, parsed.length) - 1]!;
      if (hop.location !== undefined) {
        return { kind: 'redirect', status: hop.status, location: hop.location };
      }
      const body =
        hop.body === undefined
          ? new Uint8Array()
          : new TextEncoder().encode(
              typeof hop.body === 'string' ? hop.body : JSON.stringify(hop.body),
            );
      if (body.byteLength > request.maximumBytes) throw new ReleaseTransportError('oversized');
      return { kind: 'response', status: hop.status, etag: hop.etag ?? null, body };
    },
  };
}
