import { t, type MessageId } from '../shared/i18n/translator';

export type DirtyDocumentsAction =
  | { kind: 'close-window' }
  | { kind: 'close-tab' }
  | { kind: 'close-folder' }
  | { kind: 'delete'; name: string };

const unsavedDescriptions = {
  'close-window': 'dialog.unsaved.description.close-window',
  'close-tab': 'dialog.unsaved.description.close-tab',
  'close-folder': 'dialog.unsaved.description.close-folder',
} as const satisfies Record<Exclude<DirtyDocumentsAction['kind'], 'delete'>, MessageId>;

export function unsavedChangesConfirmation(
  dirtyDocuments: readonly { name: string }[],
  action: DirtyDocumentsAction,
): { title: string; description: string; primaryLabel: string; secondaryLabel: string } {
  const one = dirtyDocuments.length === 1;
  return {
    title: one
      ? t('dialog.unsaved.title.one', { name: dirtyDocuments[0]!.name })
      : t('dialog.unsaved.title.many', { count: dirtyDocuments.length }),
    description:
      action.kind === 'delete'
        ? t('dialog.unsaved.description.delete', { name: action.name })
        : t(unsavedDescriptions[action.kind]),
    primaryLabel: t(one ? 'dialog.unsaved.save' : 'dialog.unsaved.save-all'),
    secondaryLabel: t('dialog.unsaved.dont-save'),
  };
}
