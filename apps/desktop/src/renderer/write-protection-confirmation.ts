import { t } from '../shared/i18n/translator';
import type { WriteProtectionTarget } from '../shared/write-protection';

export interface WriteProtectionOffConfirmation {
  title: string;
  description: string;
  primaryLabel: string;
  primaryVariant: 'warning';
  initialFocus: 'default';
}

export function writeProtectionOffConfirmation(
  target: WriteProtectionTarget,
): WriteProtectionOffConfirmation {
  const gameFolder = target === 'gameFolder';
  return {
    title: t(
      gameFolder
        ? 'write-protection.warning.game-folder.message'
        : 'write-protection.warning.mod-folders.message',
    ),
    description: t(
      gameFolder
        ? 'write-protection.warning.game-folder.detail'
        : 'write-protection.warning.mod-folders.detail',
    ),
    primaryLabel: t('write-protection.warning.turn-off'),
    primaryVariant: 'warning',
    initialFocus: 'default',
  };
}
