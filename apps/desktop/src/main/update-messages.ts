import type { MessageId } from '../shared/i18n/translator';
import { outputNote, type OutputMessage, type OutputText } from '../shared/output-message';
import type { UpdateFailureReason } from './update-policy';

const failureCauses: Readonly<Record<UpdateFailureReason, MessageId>> = Object.freeze({
  offline: 'app-update.failed.cause.offline',
  timeout: 'app-update.failed.cause.timeout',
  unavailable: 'app-update.failed.cause.unavailable',
  'redirect-refused': 'app-update.failed.cause.redirect-refused',
  'release-mismatch': 'app-update.failed.cause.release-mismatch',
  'asset-missing': 'app-update.failed.cause.asset-missing',
  oversized: 'app-update.failed.cause.oversized',
  'size-mismatch': 'app-update.failed.cause.size-mismatch',
  'checksum-missing': 'app-update.failed.cause.checksum-missing',
  'checksum-mismatch': 'app-update.failed.cause.checksum-mismatch',
  disk: 'app-update.failed.cause.disk',
  'publisher-refused': 'app-update.failed.cause.publisher-refused',
  'installer-missing': 'app-update.failed.cause.installer-missing',
  'installer-start-failed': 'app-update.failed.cause.installer-start-failed',
});

export function updateFailureCause(reason: UpdateFailureReason): OutputText {
  return { id: failureCauses[reason] };
}

export function updateFailedMessage(
  version: string,
  reason: UpdateFailureReason,
  detail?: string,
): OutputMessage {
  return outputNote(
    'Update',
    `update.failed.${reason}`,
    { id: 'app-update.failed.headline', args: { version } },
    {
      severity: 'warning',
      cause: updateFailureCause(reason),
      action: { text: { id: 'app-update.failed.action' } },
      ...(detail ? { detail } : {}),
    },
  );
}

export function updateCancelledMessage(
  version: string,
  options: { keptOpen: boolean; downloadKept: boolean },
): OutputMessage {
  return outputNote(
    'Update',
    'update.cancelled',
    { id: 'app-update.cancelled.headline', args: { version } },
    {
      ...(options.keptOpen ? { cause: { id: 'app-update.cancelled.cause.kept-open' } } : {}),
      ...(options.downloadKept
        ? { action: { text: { id: 'app-update.cancelled.action.download-kept' } } }
        : {}),
    },
  );
}
