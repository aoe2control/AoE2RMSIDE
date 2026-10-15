import { maximumUpdateInstallerBytes, isUpdateVersion } from '../shared/update';
import {
  productClientHeader,
  releaseCheckHeaders,
  releaseRepository,
  ReleaseTransportError,
  type ReleaseHop,
  type ReleaseTransport,
} from './release-check';

export const updateLimits = Object.freeze({
  maximumMetadataBytes: 1024 * 1024,
  maximumChecksumBytes: 16 * 1024,
  maximumInstallerBytes: maximumUpdateInstallerBytes,
  requestDeadlineMs: 20_000,
  downloadIdleMs: 30_000,
  maximumRedirects: 5,
  maximumAssets: 64,
});

export const updateAssetHosts: readonly string[] = Object.freeze([
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

export function updateReleaseTag(version: string): string {
  if (!isUpdateVersion(version)) throw new Error('update version is invalid');
  return `v${version}`;
}

export function updateInstallerName(version: string): string {
  if (!isUpdateVersion(version)) throw new Error('update version is invalid');
  return `AoE2RMSIDE-${version}-win32-x64-setup.exe`;
}

export function updateChecksumsName(version: string): string {
  if (!isUpdateVersion(version)) throw new Error('update version is invalid');
  return `AoE2RMSIDE-${version}-SHA256SUMS.txt`;
}

export function updateReleaseUrl(version: string): string {
  return `https://api.github.com/repos/${releaseRepository}/releases/tags/${updateReleaseTag(version)}`;
}

export function updateAssetUrl(version: string, name: string): string {
  return `https://github.com/${releaseRepository}/releases/download/${updateReleaseTag(version)}/${encodeURIComponent(name)}`;
}

function plainHttpsUrl(value: string, allowQuery: boolean): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password || url.hash) {
    return null;
  }
  if (!allowQuery && url.search) return null;
  return url;
}

export function updateReleaseUrlAllowed(value: string, version: string): boolean {
  const url = plainHttpsUrl(value, false);
  if (!url || url.hostname !== 'api.github.com') return false;
  const tag = updateReleaseTag(version);
  return (
    url.pathname.toLowerCase() ===
      `/repos/${releaseRepository}/releases/tags/${tag}`.toLowerCase() ||
    (/^\/repositories\/[1-9][0-9]{0,15}\/releases\/tags\//u.test(url.pathname) &&
      url.pathname.endsWith(`/releases/tags/${tag}`) &&
      url.pathname.split('/').length === 6)
  );
}

export function updateAssetUrlAllowed(value: string, version: string, name: string): boolean {
  const canonical = plainHttpsUrl(value, false);
  if (canonical?.hostname === 'github.com') {
    return (
      canonical.pathname.toLowerCase() ===
      new URL(updateAssetUrl(version, name)).pathname.toLowerCase()
    );
  }
  const asset = plainHttpsUrl(value, true);
  return asset !== null && updateAssetHosts.includes(asset.hostname);
}

export function updateReleaseHeaders(): Readonly<Record<string, string>> {
  return releaseCheckHeaders(null);
}

export function updateAssetHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({ Accept: 'application/octet-stream', ...productClientHeader });
}

export type UpdateFailureReason =
  | 'offline'
  | 'timeout'
  | 'unavailable'
  | 'redirect-refused'
  | 'release-mismatch'
  | 'asset-missing'
  | 'oversized'
  | 'size-mismatch'
  | 'checksum-missing'
  | 'checksum-mismatch'
  | 'disk'
  | 'publisher-refused'
  | 'installer-missing'
  | 'installer-start-failed';

export class UpdateFailure extends Error {
  constructor(
    readonly reason: UpdateFailureReason,
    detail?: string,
  ) {
    super(detail ? `update failed (${reason}): ${detail}` : `update failed (${reason})`);
    this.name = 'UpdateFailure';
  }
}

export interface UpdateReleaseAssets {
  installer: { name: string; bytes: number };
  checksums: { name: string; bytes: number };
}

export function parseUpdateRelease(body: Uint8Array, version: string): UpdateReleaseAssets {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new UpdateFailure('unavailable', 'the release answer is not JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UpdateFailure('unavailable', 'the release answer is not an object');
  }
  const { tag_name: tag, draft, prerelease, assets } = value as Record<string, unknown>;
  if (tag !== updateReleaseTag(version) || draft !== false || prerelease !== false) {
    throw new UpdateFailure('release-mismatch', `the release is not the published ${String(tag)}`);
  }
  if (!Array.isArray(assets) || assets.length > updateLimits.maximumAssets) {
    throw new UpdateFailure('asset-missing', 'the release has no usable asset list');
  }
  const find = (name: string, maximumBytes: number) => {
    const matches = assets.filter(
      (asset: unknown) =>
        Boolean(asset) &&
        typeof asset === 'object' &&
        (asset as Record<string, unknown>).name === name,
    ) as Record<string, unknown>[];
    if (matches.length !== 1)
      throw new UpdateFailure('asset-missing', `the release lists no ${name}`);
    const [asset] = matches as [Record<string, unknown>];
    if (asset.state !== undefined && asset.state !== 'uploaded') {
      throw new UpdateFailure('asset-missing', `${name} is not uploaded`);
    }
    const size = asset.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) {
      throw new UpdateFailure('asset-missing', `${name} has no size`);
    }
    if (size > maximumBytes) throw new UpdateFailure('oversized', `${name} is ${size} bytes`);
    return { name, bytes: size };
  };
  return {
    installer: find(updateInstallerName(version), updateLimits.maximumInstallerBytes),
    checksums: find(updateChecksumsName(version), updateLimits.maximumChecksumBytes),
  };
}

const checksumLine = /^([0-9a-fA-F]{64}) [ *]([^\s/\\][^/\\]*)$/u;

export function parseUpdateChecksums(body: Uint8Array): ReadonlyMap<string, string> | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return null;
  }
  const lines = text.replace(/^﻿/u, '').split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0 || lines.length > updateLimits.maximumAssets) return null;
  const digests = new Map<string, string>();
  for (const line of lines) {
    const match = checksumLine.exec(line);
    if (!match) return null;
    const [, digest, name] = match as unknown as [string, string, string];
    if (digests.has(name)) return null;
    digests.set(name, digest.toLowerCase());
  }
  return digests;
}

export function expectedInstallerDigest(checksums: Uint8Array, installerName: string): string {
  const digests = parseUpdateChecksums(checksums);
  const digest = digests?.get(installerName);
  if (!digest) {
    throw new UpdateFailure('checksum-missing', `the checksum list names no ${installerName}`);
  }
  return digest;
}

const redirectStatuses: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export function followUpdateRedirect(
  hop: ReleaseHop & { kind: 'redirect' },
  from: string,
  redirects: number,
  allowed: (url: string) => boolean,
): string {
  if (!redirectStatuses.has(hop.status) || hop.location === null) {
    throw new UpdateFailure('unavailable', `status ${hop.status}`);
  }
  if (redirects >= updateLimits.maximumRedirects) {
    throw new UpdateFailure('redirect-refused', 'too many redirects');
  }
  let next: string;
  try {
    next = new URL(hop.location, from).href;
  } catch {
    throw new UpdateFailure('redirect-refused', 'malformed redirect');
  }
  if (!allowed(next)) throw new UpdateFailure('redirect-refused', new URL(next).hostname);
  return next;
}

export function updateTransportFailure(error: unknown, signal: AbortSignal): UpdateFailure {
  if (error instanceof UpdateFailure) return error;
  if (signal.aborted) return new UpdateFailure('timeout');
  if (error instanceof ReleaseTransportError) {
    return new UpdateFailure(error.reason === 'oversized' ? 'oversized' : error.reason);
  }
  return new UpdateFailure('offline', error instanceof Error ? error.message : undefined);
}

export async function fetchUpdateBody(options: {
  transport: ReleaseTransport;
  url: string;
  headers: Readonly<Record<string, string>>;
  maximumBytes: number;
  allowed: (url: string) => boolean;
  signal: AbortSignal;
  deadlineMs?: number;
}): Promise<Uint8Array> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) controller.abort();
  const timer = setTimeout(abort, options.deadlineMs ?? updateLimits.requestDeadlineMs);
  try {
    let url = options.url;
    if (!options.allowed(url))
      throw new UpdateFailure('redirect-refused', 'the address is not allowed');
    for (let redirects = 0; ; redirects += 1) {
      let hop: ReleaseHop;
      try {
        hop = await options.transport.request({
          url,
          headers: options.headers,
          maximumBytes: options.maximumBytes,
          signal: controller.signal,
        });
      } catch (error) {
        throw updateTransportFailure(error, controller.signal);
      }
      if (controller.signal.aborted) throw new UpdateFailure('timeout');
      if (hop.kind === 'redirect') {
        url = followUpdateRedirect(hop, url, redirects, options.allowed);
        continue;
      }
      if (hop.body.byteLength > options.maximumBytes) throw new UpdateFailure('oversized');
      if (hop.status === 404) throw new UpdateFailure('asset-missing', 'status 404');
      if (hop.status !== 200) throw new UpdateFailure('unavailable', `status ${hop.status}`);
      return hop.body;
    }
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
  }
}
