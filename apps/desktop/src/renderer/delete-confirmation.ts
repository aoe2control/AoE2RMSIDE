import { t } from '../shared/i18n/translator';

export interface DeleteConfirmationContent {
  title: string;
  description: string;
  primaryLabel: string;
  destructive: true;
  initialFocus: 'primary';
}

export function deleteEntryConfirmation(
  entry: { name: string; kind: 'file' | 'folder'; hasChildren?: boolean },
  permanent: boolean,
): DeleteConfirmationContent {
  const nonEmptyFolder = entry.kind === 'folder' && entry.hasChildren === true;
  return permanent
    ? {
        title: t('dialog.delete-entry.permanent.title', { name: entry.name }),
        description: t(
          nonEmptyFolder
            ? 'dialog.delete-entry.permanent.description.folder'
            : 'dialog.delete-entry.permanent.description',
        ),
        primaryLabel: t('dialog.delete-entry.permanent.confirm'),
        destructive: true,
        initialFocus: 'primary',
      }
    : {
        title: t('dialog.delete-entry.title', { name: entry.name }),
        description: t(
          nonEmptyFolder
            ? 'dialog.delete-entry.description.folder'
            : 'dialog.delete-entry.description',
        ),
        primaryLabel: t('dialog.delete-entry.confirm'),
        destructive: true,
        initialFocus: 'primary',
      };
}
