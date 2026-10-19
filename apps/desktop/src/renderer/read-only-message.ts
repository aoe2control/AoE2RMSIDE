import type { ProtectedSourceReason } from '../shared/api';
import { t, type MessageId } from '../shared/i18n/translator';
import { escapeMarkdownText } from './include-navigation';

export const saveAsFromReadOnlyMessageCommandId = 'rmside.saveAsFromReadOnlyMessage';

const reasonMessages: Readonly<Record<ProtectedSourceReason, MessageId>> = {
  'game-installation': 'code-editor.read-only-message.game-installation',
  'subscribed-mod': 'code-editor.read-only-message.subscribed-mod',
  'managed-mod': 'code-editor.read-only-message.managed-mod',
};

export function readOnlyMessageId(reason: unknown): MessageId {
  return typeof reason === 'string' && Object.hasOwn(reasonMessages, reason)
    ? reasonMessages[reason as ProtectedSourceReason]
    : 'code-editor.read-only-message.protected';
}

export function readOnlyMessage(reason: unknown): {
  value: string;
  isTrusted: { enabledCommands: string[] };
} {
  const text = escapeMarkdownText(t(readOnlyMessageId(reason)));
  const label = escapeMarkdownText(t('code-editor.read-only-message.save-as'));
  return {
    value: `${text}\n\n[${label}](command:${saveAsFromReadOnlyMessageCommandId})`,
    isTrusted: { enabledCommands: [saveAsFromReadOnlyMessageCommandId] },
  };
}
