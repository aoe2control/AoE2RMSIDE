import type { ApplicationMenuEntry, ApplicationMenuModel, ApplicationMenuName } from './api';

export const applicationMenuNames: readonly ApplicationMenuName[] = Object.freeze([
  'file',
  'edit',
  'view',
  'help',
]);

export const applicationMenuKeyPattern = /^[A-Za-z0-9][\w.:/-]{0,159}$/u;

const maximumEntriesPerMenu = 256;
const maximumDepth = 3;
const maximumLabelLength = 512;
const maximumAcceleratorLength = 64;

export function isApplicationMenuKey(value: unknown): value is string {
  return typeof value === 'string' && applicationMenuKeyPattern.test(value);
}

function isLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length <= maximumLabelLength;
}

function validateEntries(value: unknown, depth: number): ApplicationMenuEntry[] | null {
  if (!Array.isArray(value) || value.length > maximumEntriesPerMenu || depth > maximumDepth) {
    return null;
  }
  const entries: ApplicationMenuEntry[] = [];
  for (const raw of value as unknown[]) {
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as Record<string, unknown>;
    if (entry.kind === 'separator') {
      entries.push(Object.freeze({ kind: 'separator' }));
      continue;
    }
    if (!isApplicationMenuKey(entry.key) || !isLabel(entry.label)) return null;
    if (typeof entry.enabled !== 'boolean') return null;
    if (entry.kind === 'submenu') {
      const children = validateEntries(entry.entries, depth + 1);
      if (!children) return null;
      entries.push(
        Object.freeze({
          kind: 'submenu',
          key: entry.key,
          label: entry.label,
          enabled: entry.enabled,
          entries: children,
        }),
      );
      continue;
    }
    if (entry.kind !== 'item') return null;
    if (
      entry.accelerator !== null &&
      (typeof entry.accelerator !== 'string' ||
        entry.accelerator.length < 1 ||
        entry.accelerator.length > maximumAcceleratorLength)
    ) {
      return null;
    }
    if (entry.check !== 'none' && entry.check !== 'checkbox' && entry.check !== 'radio') {
      return null;
    }
    if (typeof entry.checked !== 'boolean') return null;
    entries.push(
      Object.freeze({
        kind: 'item',
        key: entry.key,
        label: entry.label,
        enabled: entry.enabled,
        accelerator: entry.accelerator,
        check: entry.check,
        checked: entry.checked,
      }),
    );
  }
  return Object.freeze(entries) as ApplicationMenuEntry[];
}

export function validateApplicationMenuModel(value: unknown): ApplicationMenuModel | null {
  if (!value || typeof value !== 'object') return null;
  const menus = (value as { menus?: unknown }).menus;
  if (!Array.isArray(menus) || menus.length > applicationMenuNames.length) return null;
  const seen = new Set<ApplicationMenuName>();
  const validated: ApplicationMenuModel['menus'] = [];
  for (const raw of menus as unknown[]) {
    if (!raw || typeof raw !== 'object') return null;
    const menu = raw as Record<string, unknown>;
    const name = menu.name as ApplicationMenuName;
    if (!applicationMenuNames.includes(name) || seen.has(name) || !isLabel(menu.label)) {
      return null;
    }
    seen.add(name);
    const entries = validateEntries(menu.entries, 1);
    if (!entries) return null;
    validated.push(Object.freeze({ name, label: menu.label, entries }));
  }
  return Object.freeze({ menus: Object.freeze(validated) as ApplicationMenuModel['menus'] });
}

const acceleratorModifiers = new Map<string, 'Ctrl' | 'Shift' | 'Alt' | 'Win'>([
  ['cmdorctrl', 'Ctrl'],
  ['commandorcontrol', 'Ctrl'],
  ['ctrl', 'Ctrl'],
  ['control', 'Ctrl'],
  ['shift', 'Shift'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
  ['altgr', 'Alt'],
  ['super', 'Win'],
  ['meta', 'Win'],
  ['cmd', 'Win'],
  ['command', 'Win'],
]);

const modifierOrder = ['Ctrl', 'Shift', 'Alt', 'Win'] as const;

export function menuAcceleratorLabel(accelerator: string): string | null {
  const parts = accelerator.endsWith('++')
    ? [...accelerator.slice(0, -2).split('+'), 'Plus']
    : accelerator.split('+');
  const key = parts.pop();
  if (!key) return null;
  const modifiers = new Set<string>();
  for (const part of parts) {
    const modifier = acceleratorModifiers.get(part.trim().toLowerCase());
    if (!modifier) return null;
    modifiers.add(modifier);
  }
  const keyLabel =
    key.length === 1 ? key.toUpperCase() : `${key[0]!.toUpperCase()}${key.slice(1).toLowerCase()}`;
  return [...modifierOrder.filter((modifier) => modifiers.has(modifier)), keyLabel].join('+');
}
