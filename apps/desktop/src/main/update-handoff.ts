import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isUpdateVersion } from '../shared/update';
import { outputNote, type OutputMessage } from '../shared/output-message';
import { hashFileBounded, readFileBounded, replaceFileAtomically } from './bounded-file';
import { compareSemanticVersions, parseSemanticVersion } from './semantic-version';
import { updateLimits, UpdateFailure, type UpdateFailureReason } from './update-policy';
import { updateFailureCause } from './update-messages';

export const installerUpdateParameter = 'RMSIDEUPDATE';

export const installerHandOffArguments: readonly string[] = Object.freeze([
  '/SILENT',
  '/SUPPRESSMSGBOXES',
  '/NORESTART',
  `/${installerUpdateParameter}=1`,
]);

export interface InstallerHandOff {
  version: string;
  fromVersion: string;
  installerPath: string;
  digest: string;
  bytes: number;
}

export interface InstallerPublisherPolicy {
  check(installerPath: string): Promise<'accepted' | 'refused'>;
}

export const unsignedReleasePublisherPolicy: InstallerPublisherPolicy = Object.freeze({
  async check() {
    return 'accepted' as const;
  },
});

export function installerEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    const upper = name.toUpperCase();
    if (upper.startsWith('ELECTRON_') || upper.startsWith('RMSIDE_') || upper === 'NODE_OPTIONS') {
      continue;
    }
    kept[name] = value;
  }
  return kept;
}

export interface InstallerLauncher {
  launch(path: string, args: readonly string[], environment: NodeJS.ProcessEnv): Promise<void>;
}

export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export function spawnInstallerLauncher(
  spawn: SpawnFunction,
  timeoutMs = 10_000,
): InstallerLauncher {
  return {
    launch: (path, args, environment) =>
      new Promise<void>((resolve, reject) => {
        let child: ChildProcess;
        try {
          child = spawn(path, args, {
            cwd: dirname(path),
            detached: true,
            env: environment,
            stdio: 'ignore',
            windowsHide: false,
          });
        } catch (error) {
          reject(error);
          return;
        }
        const timer = setTimeout(() => reject(new Error('the installer did not start')), timeoutMs);
        child.once('spawn', () => {
          clearTimeout(timer);
          child.unref();
          resolve();
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      }),
  };
}

export interface HandOffRecord {
  version: string;
  fromVersion: string;
  failure: UpdateFailureReason | null;
}

const recordedFailures: readonly UpdateFailureReason[] = [
  'installer-missing',
  'installer-start-failed',
  'checksum-mismatch',
  'size-mismatch',
  'publisher-refused',
];

export class HandOffRecordStore {
  readonly path: string;

  constructor(userDataPath: string) {
    this.path = join(userDataPath, 'update-handoff-v1.json');
  }

  async write(record: HandOffRecord): Promise<void> {
    await replaceFileAtomically(
      this.path,
      JSON.stringify({
        schemaVersion: 1,
        version: record.version,
        fromVersion: record.fromVersion,
        failure: record.failure,
      }),
    );
  }

  async take(): Promise<HandOffRecord | null> {
    let text: string;
    try {
      text = (await readFileBounded(this.path, 4096)).toString('utf8');
    } catch {
      return null;
    }
    await rm(this.path, { force: true }).catch(() => undefined);
    return parseHandOffRecord(text);
  }
}

export function parseHandOffRecord(text: string): HandOffRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'failure,fromVersion,schemaVersion,version') {
    return null;
  }
  if (record.schemaVersion !== 1) return null;
  if (!isUpdateVersion(record.version) || !isUpdateVersion(record.fromVersion)) return null;
  const failure = record.failure;
  if (failure !== null && !recordedFailures.includes(failure as UpdateFailureReason)) return null;
  return {
    version: record.version,
    fromVersion: record.fromVersion,
    failure: failure as UpdateFailureReason | null,
  };
}

export function handOffOutcomeMessage(
  record: HandOffRecord,
  currentVersion: string,
): OutputMessage | null {
  const target = parseSemanticVersion(record.version);
  const current = parseSemanticVersion(currentVersion);
  if (!target || !current) return null;
  if (compareSemanticVersions(current, target) >= 0) {
    return outputNote('Update', 'update.installed', {
      id: 'app-update.installed.headline',
      args: { version: currentVersion },
    });
  }
  return outputNote(
    'Update',
    'update.incomplete',
    { id: 'app-update.incomplete.headline', args: { version: record.version } },
    {
      severity: 'warning',
      cause:
        record.failure === null
          ? { id: 'app-update.incomplete.cause', args: { current: currentVersion } }
          : updateFailureCause(record.failure),
      action: { text: { id: 'release-check.newer.action' }, link: 'rmside-releases' },
    },
  );
}

export async function checkInstallerFile(
  installer: Pick<InstallerHandOff, 'installerPath' | 'bytes' | 'digest'>,
): Promise<void> {
  let digest: string;
  try {
    digest = (
      await hashFileBounded(
        installer.installerPath,
        updateLimits.maximumInstallerBytes,
        async (metadata) => {
          if (metadata.size !== installer.bytes) throw new UpdateFailure('size-mismatch');
        },
      )
    ).toString('hex');
  } catch (error) {
    throw error instanceof UpdateFailure ? error : new UpdateFailure('installer-missing');
  }
  if (digest !== installer.digest) throw new UpdateFailure('checksum-mismatch');
}

export async function handOffToInstaller(options: {
  handOff: InstallerHandOff;
  records: Pick<HandOffRecordStore, 'write'>;
  launcher: InstallerLauncher;
  environment: NodeJS.ProcessEnv;
}): Promise<void> {
  const { handOff, records } = options;
  const record = { version: handOff.version, fromVersion: handOff.fromVersion, failure: null };
  await records.write(record).catch(() => undefined);
  try {
    await checkInstallerFile(handOff);
    try {
      await options.launcher.launch(
        handOff.installerPath,
        installerHandOffArguments,
        installerEnvironment(options.environment),
      );
    } catch (error) {
      throw new UpdateFailure(
        'installer-start-failed',
        error instanceof Error ? error.message : undefined,
      );
    }
  } catch (error) {
    const failure =
      error instanceof UpdateFailure ? error : new UpdateFailure('installer-start-failed');
    await records.write({ ...record, failure: failure.reason }).catch(() => undefined);
    throw failure;
  }
}
