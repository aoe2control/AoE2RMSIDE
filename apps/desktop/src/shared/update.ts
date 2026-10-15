export type UpdateState =
  | { phase: 'none' }
  | { phase: 'available'; version: string }
  | {
      phase: 'downloading';
      version: string;
      receivedBytes: number;
      totalBytes: number | null;
    }
  | { phase: 'verifying'; version: string }
  | { phase: 'installing'; version: string };

export type UpdatePhase = UpdateState['phase'];

export const noUpdate: UpdateState = Object.freeze({ phase: 'none' });

export const maximumUpdateInstallerBytes = 512 * 1024 * 1024;

const versionPattern = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?$/u;

export function isUpdateVersion(value: unknown): value is string {
  return typeof value === 'string' && versionPattern.test(value);
}

function isByteCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximumUpdateInstallerBytes
  );
}

export function validateUpdateState(value: unknown): UpdateState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('update state is invalid');
  }
  const record = value as Record<string, unknown>;
  if (record.phase === 'none') return noUpdate;
  if (!isUpdateVersion(record.version)) throw new TypeError('update state version is invalid');
  const version = record.version;
  switch (record.phase) {
    case 'available':
    case 'verifying':
    case 'installing':
      return { phase: record.phase, version };
    case 'downloading': {
      const { receivedBytes, totalBytes } = record;
      if (!isByteCount(receivedBytes) || (totalBytes !== null && !isByteCount(totalBytes))) {
        throw new TypeError('update progress is invalid');
      }
      if (totalBytes !== null && receivedBytes > totalBytes) {
        throw new TypeError('update progress is invalid');
      }
      return { phase: 'downloading', version, receivedBytes, totalBytes };
    }
    default:
      throw new TypeError('update state phase is invalid');
  }
}

export function updateDownloadPercent(state: UpdateState): number {
  if (state.phase === 'verifying' || state.phase === 'installing') return 100;
  if (state.phase !== 'downloading' || !state.totalBytes) return 0;
  return Math.min(100, Math.floor((state.receivedBytes / state.totalBytes) * 100));
}

export function updateBusy(state: UpdateState): boolean {
  return (
    state.phase === 'downloading' || state.phase === 'verifying' || state.phase === 'installing'
  );
}

export function updateReleaseNotesUrl(repository: string, version: string): string {
  if (!isUpdateVersion(version)) throw new Error('update version is invalid');
  return `https://github.com/${repository}/releases/tag/v${version}`;
}
