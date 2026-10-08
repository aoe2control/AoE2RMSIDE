import type { InstalledSourceOwnership } from '../shared/api';
import { t } from '../shared/i18n/translator';

export function installedSourceOriginLabel(ownership: InstalledSourceOwnership): string {
  switch (ownership) {
    case 'built-in':
      return t('installed-maps.origin.built-in');
    case 'local':
      return t('installed-maps.origin.local');
    case 'subscribed':
      return t('installed-maps.origin.subscribed');
  }
}
