import type { ApplicationMenuEntry, ApplicationMenuName } from '../shared/api';
import type { MessageId } from '../shared/i18n/translator';

export const applicationMenus: readonly {
  name: ApplicationMenuName;
  label: MessageId;
  accessKey: string;
}[] = [
  { name: 'file', label: 'app-menu.file.name', accessKey: 'f' },
  { name: 'edit', label: 'app-menu.edit.name', accessKey: 'e' },
  { name: 'view', label: 'app-menu.view.name', accessKey: 'v' },
  { name: 'help', label: 'app-menu.help.name', accessKey: 'h' },
];

export function applicationMenuForAccessKey(
  event: Pick<KeyboardEvent, 'key' | 'code'>,
): ApplicationMenuName | null {
  const letter = /^[a-z]$/iu.test(event.key)
    ? event.key.toLowerCase()
    : (/^Key([A-Z])$/u.exec(event.code)?.[1]?.toLowerCase() ?? null);
  if (!letter) return null;
  return applicationMenus.find((menu) => menu.accessKey === letter)?.name ?? null;
}

type ApplicationMenuItemEntry = Extract<ApplicationMenuEntry, { kind: 'item' }>;

export type ApplicationMenuRow =
  | { kind: 'separator'; key: string }
  | { kind: 'item'; entry: ApplicationMenuItemEntry }
  | { kind: 'submenu'; entry: Extract<ApplicationMenuEntry, { kind: 'submenu' }> }
  | {
      kind: 'radio-group';
      key: string;
      value: string | null;
      entries: ApplicationMenuItemEntry[];
    };

export function applicationMenuRows(
  entries: readonly ApplicationMenuEntry[],
): ApplicationMenuRow[] {
  const rows: ApplicationMenuRow[] = [];
  entries.forEach((entry, index) => {
    if (entry.kind === 'separator') {
      rows.push({ kind: 'separator', key: `separator-${index}` });
      return;
    }
    if (entry.kind === 'submenu') {
      rows.push({ kind: 'submenu', entry });
      return;
    }
    if (entry.check !== 'radio') {
      rows.push({ kind: 'item', entry });
      return;
    }
    const previous = rows.at(-1);
    let group: Extract<ApplicationMenuRow, { kind: 'radio-group' }>;
    if (previous?.kind === 'radio-group') group = previous;
    else {
      group = { kind: 'radio-group', key: `radio-${entry.key}`, value: null, entries: [] };
      rows.push(group);
    }
    group.entries.push(entry);
    if (entry.checked && group.value === null) group.value = entry.key;
  });
  return rows;
}
