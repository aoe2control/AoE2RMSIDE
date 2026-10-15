import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { OutputMessage } from '../shared/output-message';
import { isUpdateVersion, noUpdate, type UpdateState } from '../shared/update';
import type { ReleaseTransport } from './release-check';
import {
  checkInstallerFile,
  type InstallerHandOff,
  type InstallerPublisherPolicy,
} from './update-handoff';
import { updateCancelledMessage, updateFailedMessage } from './update-messages';
import {
  expectedInstallerDigest,
  fetchUpdateBody,
  followUpdateRedirect,
  parseUpdateRelease,
  updateAssetHeaders,
  updateAssetUrl,
  updateAssetUrlAllowed,
  updateLimits,
  updateReleaseHeaders,
  updateReleaseUrl,
  updateReleaseUrlAllowed,
  updateTransportFailure,
  UpdateFailure,
  type UpdateReleaseAssets,
} from './update-policy';
import type { DownloadHop, DownloadTransport } from './update-transport';

interface VerifiedInstaller {
  version: string;
  name: string;
  installerPath: string;
  digest: string;
  bytes: number;
}

export interface UpdateServiceOptions {
  currentVersion: string;
  offered: boolean;
  releaseTransport(): ReleaseTransport;
  downloadTransport(): DownloadTransport;
  downloadDirectory: string;
  publisherPolicy: InstallerPublisherPolicy;
  publish(message: OutputMessage): void;
  onState(state: UpdateState): void;
  requestClose(): void;
  progressIntervalMs?: number;
  idleMs?: number;
  now?: () => number;
}

type Phase = UpdateState['phase'] | 'handing-off';

class UpdateCancelled extends Error {}

export class UpdateService {
  private phase: Phase = 'none';
  private version: string | null = null;
  private receivedBytes = 0;
  private totalBytes: number | null = null;
  private controller: AbortController | null = null;
  private cancelled = false;
  private disposed = false;
  private handOff: InstallerHandOff | null = null;
  private verified: VerifiedInstaller | null = null;
  private lastProgressAt = 0;
  private running: Promise<void> | null = null;

  constructor(private readonly options: UpdateServiceOptions) {}

  state(): UpdateState {
    const version = this.version;
    if (this.phase === 'none' || version === null) return noUpdate;
    switch (this.phase) {
      case 'available':
      case 'verifying':
      case 'installing':
        return { phase: this.phase, version };
      case 'handing-off':
        return { phase: 'installing', version };
      case 'downloading':
        return {
          phase: 'downloading',
          version,
          receivedBytes: this.receivedBytes,
          totalBytes: this.totalBytes,
        };
    }
  }

  offer(version: string): void {
    if (!this.options.offered || !isUpdateVersion(version)) return;
    if (this.phase !== 'none' && this.phase !== 'available') return;
    this.version = version;
    this.setPhase('available');
  }

  start(version: string): boolean {
    if (this.phase !== 'available' || version !== this.version) return false;
    this.cancelled = false;
    this.controller = new AbortController();
    this.receivedBytes = 0;
    this.totalBytes = null;
    const verified = this.verified?.version === version ? this.verified : null;
    this.setPhase(verified ? 'verifying' : 'downloading');
    const signal = this.controller.signal;
    this.running = (verified ? this.reuse(verified, signal) : this.run(version, signal)).finally(
      () => {
        this.running = null;
      },
    );
    return true;
  }

  cancel(): boolean {
    if (this.phase !== 'downloading' && this.phase !== 'verifying') return false;
    this.cancelled = true;
    this.controller?.abort();
    return true;
  }

  windowClosing(): void {
    if (this.phase === 'installing') this.setPhase('handing-off');
  }

  closeDeclined(): void {
    if (this.phase !== 'installing' || this.version === null) return;
    const version = this.version;
    this.handOff = null;
    const downloadKept = this.verified?.version === version;
    if (!downloadKept) void this.discardVerified();
    this.options.publish(updateCancelledMessage(version, { keptOpen: true, downloadKept }));
    this.setPhase('available');
  }

  takeHandOff(): InstallerHandOff | null {
    if (this.phase !== 'handing-off') return null;
    const handOff = this.handOff;
    this.handOff = null;
    return handOff;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelled = true;
    this.controller?.abort();
    await this.running?.catch(() => undefined);
    if (this.phase !== 'handing-off') await this.discardVerified();
  }

  async settled(): Promise<void> {
    await this.running;
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.options.onState(this.state());
  }

  private progress(force: boolean): void {
    const now = (this.options.now ?? Date.now)();
    if (!force && now - this.lastProgressAt < (this.options.progressIntervalMs ?? 100)) return;
    this.lastProgressAt = now;
    this.options.onState(this.state());
  }

  private async reuse(verified: VerifiedInstaller, signal: AbortSignal): Promise<void> {
    const { version } = verified;
    try {
      try {
        await checkInstallerFile(verified);
      } catch (error) {
        if (!(error instanceof UpdateFailure)) throw error;
        console.warn(
          `the kept update installer is not usable (${error.reason}); downloading again`,
        );
        await this.discardVerified();
        if (this.disposed) return;
        if (this.cancelled) {
          this.options.publish(
            updateCancelledMessage(version, { keptOpen: false, downloadKept: false }),
          );
          this.setPhase('available');
          return;
        }
        this.setPhase('downloading');
        await this.run(version, signal);
        return;
      }
      if ((await this.options.publisherPolicy.check(verified.installerPath)) !== 'accepted') {
        throw new UpdateFailure('publisher-refused');
      }
      this.throwIfCancelled();
      this.accept(verified);
    } catch (error) {
      this.handOff = null;
      if (this.disposed) return;
      if (this.cancelled || error instanceof UpdateCancelled) {
        this.options.publish(
          updateCancelledMessage(version, { keptOpen: false, downloadKept: true }),
        );
      } else {
        await this.discardVerified();
        const failure =
          error instanceof UpdateFailure
            ? error
            : new UpdateFailure('unavailable', error instanceof Error ? error.message : undefined);
        console.warn(failure.message);
        this.options.publish(updateFailedMessage(version, failure.reason, failure.message));
      }
      this.setPhase('available');
    } finally {
      this.controller = null;
    }
  }

  private accept(verified: VerifiedInstaller): void {
    this.handOff = {
      version: verified.version,
      fromVersion: this.options.currentVersion,
      installerPath: verified.installerPath,
      digest: verified.digest,
      bytes: verified.bytes,
    };
    this.setPhase('installing');
    this.options.requestClose();
  }

  private async run(version: string, signal: AbortSignal): Promise<void> {
    this.verified = null;
    try {
      const directory = this.options.downloadDirectory;
      try {
        await rm(directory, { force: true, recursive: true, maxRetries: 2 });
        await mkdir(directory, { recursive: true });
      } catch (error) {
        throw new UpdateFailure('disk', error instanceof Error ? error.message : undefined);
      }
      this.throwIfCancelled();
      const assets = await this.readRelease(version, signal);
      this.throwIfCancelled();
      const checksums = await fetchUpdateBody({
        transport: this.options.releaseTransport(),
        url: updateAssetUrl(version, assets.checksums.name),
        headers: updateAssetHeaders(),
        maximumBytes: assets.checksums.bytes,
        allowed: (url) => updateAssetUrlAllowed(url, version, assets.checksums.name),
        signal,
      }).catch((error: unknown) => this.rethrow(error));
      const expected = expectedInstallerDigest(checksums, assets.installer.name);
      this.totalBytes = assets.installer.bytes;
      this.progress(true);
      const partialPath = join(directory, `${assets.installer.name}.partial`);
      const downloaded = await this.download(version, assets, partialPath, signal);
      this.setPhase('verifying');
      if (downloaded.bytes !== assets.installer.bytes) {
        throw new UpdateFailure(
          'size-mismatch',
          `${downloaded.bytes} of ${assets.installer.bytes} bytes`,
        );
      }
      if (downloaded.digest !== expected) throw new UpdateFailure('checksum-mismatch');
      this.throwIfCancelled();
      const installerPath = join(directory, assets.installer.name);
      try {
        await rename(partialPath, installerPath);
      } catch (error) {
        throw new UpdateFailure('disk', error instanceof Error ? error.message : undefined);
      }
      if ((await this.options.publisherPolicy.check(installerPath)) !== 'accepted') {
        throw new UpdateFailure('publisher-refused');
      }
      this.throwIfCancelled();
      this.verified = {
        version,
        name: assets.installer.name,
        installerPath,
        digest: expected,
        bytes: assets.installer.bytes,
      };
      this.accept(this.verified);
    } catch (error) {
      this.handOff = null;
      await this.discardVerified();
      if (this.disposed) return;
      if (this.cancelled || error instanceof UpdateCancelled) {
        this.options.publish(
          updateCancelledMessage(version, { keptOpen: false, downloadKept: false }),
        );
      } else {
        const failure =
          error instanceof UpdateFailure
            ? error
            : new UpdateFailure('unavailable', error instanceof Error ? error.message : undefined);
        console.warn(failure.message);
        this.options.publish(updateFailedMessage(version, failure.reason, failure.message));
      }
      this.setPhase('available');
    } finally {
      this.controller = null;
    }
  }

  private throwIfCancelled(): void {
    if (this.cancelled) throw new UpdateCancelled();
  }

  private rethrow(error: unknown): never {
    if (this.cancelled) throw new UpdateCancelled();
    throw error;
  }

  private async readRelease(version: string, signal: AbortSignal): Promise<UpdateReleaseAssets> {
    const body = await fetchUpdateBody({
      transport: this.options.releaseTransport(),
      url: updateReleaseUrl(version),
      headers: updateReleaseHeaders(),
      maximumBytes: updateLimits.maximumMetadataBytes,
      allowed: (url) => updateReleaseUrlAllowed(url, version),
      signal,
    }).catch((error: unknown) => this.rethrow(error));
    return parseUpdateRelease(body, version);
  }

  private async download(
    version: string,
    assets: UpdateReleaseAssets,
    partialPath: string,
    signal: AbortSignal,
  ): Promise<{ digest: string; bytes: number }> {
    const { name, bytes: expectedBytes } = assets.installer;
    let handle: FileHandle;
    try {
      handle = await open(partialPath, 'wx', 0o600);
    } catch (error) {
      throw new UpdateFailure('disk', error instanceof Error ? error.message : undefined);
    }
    const hash = createHash('sha256');
    const idle = new AbortController();
    const idleMs = this.options.idleMs ?? updateLimits.downloadIdleMs;
    let idleTimer = setTimeout(() => idle.abort(), idleMs);
    const keepAlive = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(), idleMs);
    };
    const requestSignal = AbortSignal.any([signal, idle.signal]);
    const transport = this.options.downloadTransport();
    let received = 0;
    try {
      let url = updateAssetUrl(version, name);
      for (let redirects = 0; ; redirects += 1) {
        let hop: DownloadHop;
        try {
          hop = await transport.request({
            url,
            headers: updateAssetHeaders(),
            maximumBytes: expectedBytes,
            signal: requestSignal,
            onChunk: async (chunk) => {
              try {
                await handle.write(chunk);
              } catch (error) {
                throw new UpdateFailure('disk', error instanceof Error ? error.message : undefined);
              }
              hash.update(chunk);
              received += chunk.byteLength;
              this.receivedBytes = received;
              keepAlive();
              this.progress(false);
            },
          });
        } catch (error) {
          if (this.cancelled) throw new UpdateCancelled();
          if (idle.signal.aborted) throw new UpdateFailure('timeout', 'no data arrived');
          const failure = updateTransportFailure(error, requestSignal);
          throw failure.reason === 'oversized'
            ? new UpdateFailure('size-mismatch', 'more bytes than the release lists')
            : failure;
        }
        if (hop.kind === 'redirect') {
          keepAlive();
          url = followUpdateRedirect(hop, url, redirects, (next) =>
            updateAssetUrlAllowed(next, version, name),
          );
          continue;
        }
        if (hop.status === 404) throw new UpdateFailure('asset-missing', 'status 404');
        if (hop.status !== 200) throw new UpdateFailure('unavailable', `status ${hop.status}`);
        if (hop.declaredBytes !== null && hop.declaredBytes !== expectedBytes) {
          throw new UpdateFailure('size-mismatch', `${hop.declaredBytes} declared bytes`);
        }
        break;
      }
      this.progress(true);
      try {
        await handle.sync();
      } catch (error) {
        throw new UpdateFailure('disk', error instanceof Error ? error.message : undefined);
      }
    } finally {
      clearTimeout(idleTimer);
      await handle.close().catch(() => undefined);
    }
    return { digest: hash.digest('hex'), bytes: received };
  }

  private async discardVerified(): Promise<void> {
    this.verified = null;
    await rm(this.options.downloadDirectory, {
      force: true,
      recursive: true,
      maxRetries: 3,
      retryDelay: 200,
    }).catch(() => undefined);
  }
}

export async function removeUpdateDownloads(directory: string): Promise<boolean> {
  try {
    await rm(directory, { force: true, recursive: true });
    return true;
  } catch {
    return false;
  }
}
