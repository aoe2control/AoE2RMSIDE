import type { ApplicationMenuEntry, ApplicationMenuModel } from '../shared/api';
import {
  applicationMenuNames,
  isApplicationMenuKey,
  menuAcceleratorLabel,
} from '../shared/application-menu-model';

export interface MenuItemLike {
  id?: string | null;
  label: string;
  type: string;
  role?: string | null;
  enabled: boolean;
  visible: boolean;
  checked: boolean;
  accelerator?: string | null;
  submenu?: MenuLike | null;
  getDefaultRoleAccelerator?: () => unknown;
}

export interface MenuLike {
  items: readonly MenuItemLike[];
}

export function applicationMenuItemKey(item: MenuItemLike): string | null {
  if (typeof item.id === 'string' && isApplicationMenuKey(item.id)) return item.id;
  if (typeof item.role === 'string' && item.role !== '') {
    const key = `role:${item.role.toLowerCase()}`;
    if (isApplicationMenuKey(key)) return key;
  }
  return null;
}

function itemAccelerator(item: MenuItemLike): string | null {
  let accelerator: unknown = item.accelerator;
  if ((accelerator === undefined || accelerator === null) && item.role) {
    accelerator = item.getDefaultRoleAccelerator?.();
  }
  return typeof accelerator === 'string' && accelerator !== ''
    ? menuAcceleratorLabel(accelerator)
    : null;
}

function menuEntries(menu: MenuLike, path: string): ApplicationMenuEntry[] {
  const entries: ApplicationMenuEntry[] = [];
  menu.items.forEach((item, index) => {
    if (!item.visible) return;
    if (item.type === 'separator') {
      if (entries.length > 0 && entries.at(-1)?.kind !== 'separator') {
        entries.push({ kind: 'separator' });
      }
      return;
    }
    const key = applicationMenuItemKey(item) ?? `pos:${path}/${index}`;
    if (item.submenu) {
      entries.push({
        kind: 'submenu',
        key,
        label: item.label,
        enabled: item.enabled,
        entries: menuEntries(item.submenu, `${path}/${index}`),
      });
      return;
    }
    entries.push({
      kind: 'item',
      key,
      label: item.label,
      enabled: item.enabled,
      accelerator: itemAccelerator(item),
      check: item.type === 'checkbox' || item.type === 'radio' ? item.type : 'none',
      checked: item.type === 'checkbox' || item.type === 'radio' ? item.checked : false,
    });
  });
  if (entries.at(-1)?.kind === 'separator') entries.pop();
  return entries;
}

export function applicationMenuModel(menu: MenuLike | null | undefined): ApplicationMenuModel {
  const menus: ApplicationMenuModel['menus'] = [];
  for (const item of menu?.items ?? []) {
    const name = applicationMenuNames.find((candidate) => item.id === `menu.${candidate}`);
    if (!name || !item.submenu || !item.visible) continue;
    menus.push({ name, label: item.label, entries: menuEntries(item.submenu, name) });
  }
  return { menus };
}

export function findApplicationMenuItem(
  menu: MenuLike | null | undefined,
  key: string,
): MenuItemLike | undefined {
  if (!isApplicationMenuKey(key) || key.startsWith('pos:')) return undefined;
  const search = (items: readonly MenuItemLike[]): MenuItemLike | undefined => {
    for (const item of items) {
      if (!item.visible || !item.enabled || item.type === 'separator') continue;
      if (item.submenu) {
        const found = search(item.submenu.items);
        if (found) return found;
        continue;
      }
      if (applicationMenuItemKey(item) === key) return item;
    }
    return undefined;
  };
  for (const item of menu?.items ?? []) {
    const isTitleBarMenu = applicationMenuNames.some((name) => item.id === `menu.${name}`);
    if (!isTitleBarMenu || !item.visible || !item.enabled || !item.submenu) continue;
    const found = search(item.submenu.items);
    if (found) return found;
  }
  return undefined;
}

export function reportApplicationMenuClicks(
  menu: { items: readonly { click?: unknown; submenu?: unknown }[] },
  afterClick: () => void,
): void {
  for (const item of menu.items) {
    const click = item.click;
    if (typeof click === 'function') {
      (item as { click: unknown }).click = function (this: unknown, ...args: unknown[]) {
        try {
          return (click as (...parameters: unknown[]) => unknown).apply(this, args);
        } finally {
          afterClick();
        }
      };
    }
    const submenu = item.submenu as typeof menu | null | undefined;
    if (submenu && Array.isArray(submenu.items)) reportApplicationMenuClicks(submenu, afterClick);
  }
}
