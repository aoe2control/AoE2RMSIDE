import type { MessageId } from '../shared/i18n/translator';
import type { WriteProtection, WriteProtectionTarget } from '../shared/write-protection';

export const writeProtectionMenuItems: ReadonlyArray<{
  id: `file.write-protection.${WriteProtectionTarget}`;
  target: WriteProtectionTarget;
  labelId: MessageId;
}> = [
  {
    id: 'file.write-protection.gameFolder',
    target: 'gameFolder',
    labelId: 'app-menu.file.write-protection.game-folder',
  },
  {
    id: 'file.write-protection.modFolders',
    target: 'modFolders',
    labelId: 'app-menu.file.write-protection.mod-folders',
  },
];

export function withWriteProtection(
  current: WriteProtection,
  target: WriteProtectionTarget,
  enabled: boolean,
): WriteProtection {
  return { ...current, [target]: enabled };
}
