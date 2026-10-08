import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { ControlLauncherStatus } from '../shared/api';
import { FileTooLargeError, readFileBounded, replaceFileAtomically } from './bounded-file';

const preferenceVersion = 1;
const maximumExecutableBytes = 512 * 1024 * 1024;
const maximumPreferenceBytes = 16 * 1024;
const portableSha256 = /^[0-9a-f]{64}$/u;

interface PersistedControlLauncherPreference {
  version: 1;
  canonicalPath: string;
  sha256: string;
  size: number;
  mtimeMs: number;
}

export interface ValidatedControlLauncher {
  canonicalPath: string;
  sha256: string;
  size: number;
  mtimeMs: number;
}

export class ControlLauncherPreferenceStore {
  private readonly preferencePath: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(userDataPath: string) {
    this.preferencePath = join(userDataPath, 'aoe2control-launcher-v1.json');
  }

  select(candidatePath: string): Promise<ControlLauncherStatus> {
    return this.serialize(async () => {
      const validated = await validateControlLauncherExecutable(candidatePath);
      await this.write({ version: preferenceVersion, ...validated });
      return publicStatus('ready', validated);
    });
  }

  status(): Promise<ControlLauncherStatus> {
    return this.serialize(async () => {
      let stored: PersistedControlLauncherPreference | null;
      try {
        stored = await this.read();
      } catch (error) {
        if (error instanceof ControlLauncherPreferenceError) {
          return { configured: false, state: 'invalid' };
        }
        throw error;
      }
      if (!stored) return { configured: false, state: 'unconfigured' };
      try {
        const current = await validateControlLauncherExecutable(stored.canonicalPath);
        if (current.sha256 !== stored.sha256) return publicStatus('changed', stored);
        return publicStatus('ready', current);
      } catch (error) {
        return publicStatus(isMissingError(error) ? 'missing' : 'invalid', stored);
      }
    });
  }

  selectionDirectory(): Promise<string | undefined> {
    return this.serialize(async () => {
      try {
        const stored = await this.read();
        return stored ? dirname(stored.canonicalPath) : undefined;
      } catch (error) {
        if (error instanceof ControlLauncherPreferenceError) return undefined;
        throw error;
      }
    });
  }

  forLaunch(): Promise<ValidatedControlLauncher> {
    return this.serialize(async () => {
      const stored = await this.read();
      if (!stored) throw new ControlLauncherPreferenceError('unconfigured');
      let current: ValidatedControlLauncher;
      try {
        current = await validateControlLauncherExecutable(stored.canonicalPath);
      } catch (error) {
        throw new ControlLauncherPreferenceError(isMissingError(error) ? 'missing' : 'invalid');
      }
      if (current.sha256 !== stored.sha256) {
        throw new ControlLauncherPreferenceError('changed');
      }
      return current;
    });
  }

  forget(): Promise<void> {
    return this.serialize(() => rm(this.preferencePath, { force: true }));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.catch(() => undefined).then(operation);
    this.pending = result;
    return result;
  }

  private async read(): Promise<PersistedControlLauncherPreference | null> {
    let text: string;
    try {
      text = (await readFileBounded(this.preferencePath, maximumPreferenceBytes)).toString('utf8');
    } catch (error) {
      if (isMissingError(error)) return null;
      if (error instanceof FileTooLargeError) throw new ControlLauncherPreferenceError('invalid');
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ControlLauncherPreferenceError('invalid');
    }
    if (!isPreference(value)) throw new ControlLauncherPreferenceError('invalid');
    return value;
  }

  private async write(preference: PersistedControlLauncherPreference): Promise<void> {
    await replaceFileAtomically(this.preferencePath, JSON.stringify(preference));
  }
}

export class ControlLauncherPreferenceError extends Error {
  constructor(readonly code: ControlLauncherStatus['state']) {
    super(`AoE2Control launcher selection is ${code}`);
    this.name = 'ControlLauncherPreferenceError';
  }
}

export async function validateControlLauncherExecutable(
  candidatePath: string,
): Promise<ValidatedControlLauncher> {
  if (
    typeof candidatePath !== 'string' ||
    candidatePath.length < 1 ||
    candidatePath.length > 32_768
  ) {
    throw new Error('AoE2Control launcher path is invalid');
  }
  const canonicalPath = await realpath(candidatePath);
  if (extname(canonicalPath).toLocaleLowerCase('en-US') !== '.exe') {
    throw new Error('AoE2Control launcher must be a Windows executable');
  }
  const before = await stat(canonicalPath);
  if (!before.isFile() || before.size < 64 || before.size > maximumExecutableBytes) {
    throw new Error('AoE2Control launcher must be a bounded regular executable');
  }
  await validatePortableExecutableHeader(canonicalPath, before.size);
  const sha256 = await sha256File(canonicalPath);
  const after = await stat(canonicalPath);
  if (
    !after.isFile() ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    (before.ino !== 0 && after.ino !== 0 && after.ino !== before.ino)
  ) {
    throw new Error('AoE2Control launcher changed while it was being validated');
  }
  return { canonicalPath, sha256, size: after.size, mtimeMs: after.mtimeMs };
}

async function validatePortableExecutableHeader(path: string, size: number): Promise<void> {
  const file = await open(path, 'r');
  try {
    const dos = Buffer.alloc(64);
    const dosRead = await file.read(dos, 0, dos.length, 0);
    if (dosRead.bytesRead !== dos.length || dos[0] !== 0x4d || dos[1] !== 0x5a) {
      throw new Error('AoE2Control launcher does not have a valid PE header');
    }
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > size - 4 || peOffset > 16 * 1024 * 1024) {
      throw new Error('AoE2Control launcher has an invalid PE header offset');
    }
    const signature = Buffer.alloc(4);
    const signatureRead = await file.read(signature, 0, signature.length, peOffset);
    if (signatureRead.bytesRead !== 4 || !signature.equals(Buffer.from([0x50, 0x45, 0, 0]))) {
      throw new Error('AoE2Control launcher does not have a valid PE signature');
    }
  } finally {
    await file.close();
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

function publicStatus(
  state: Exclude<ControlLauncherStatus['state'], 'unconfigured'>,
  preference: Pick<ValidatedControlLauncher, 'canonicalPath' | 'sha256'>,
): ControlLauncherStatus {
  return {
    configured: true,
    state,
    executableName: basename(preference.canonicalPath),
    fingerprintSha256: preference.sha256,
  };
}

function isPreference(value: unknown): value is PersistedControlLauncherPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 5 &&
    record.version === preferenceVersion &&
    typeof record.canonicalPath === 'string' &&
    record.canonicalPath.length >= 1 &&
    record.canonicalPath.length <= 32_768 &&
    typeof record.sha256 === 'string' &&
    portableSha256.test(record.sha256) &&
    Number.isSafeInteger(record.size) &&
    (record.size as number) >= 64 &&
    (record.size as number) <= maximumExecutableBytes &&
    typeof record.mtimeMs === 'number' &&
    Number.isFinite(record.mtimeMs)
  );
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
