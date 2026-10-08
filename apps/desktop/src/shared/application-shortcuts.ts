import type { ApplicationMenuAction, RootExecutionPhase } from './api';

export const applicationShortcuts = {
  run: 'F5',
  stop: 'Shift+F5',
  deployManagedMod: 'CmdOrCtrl+Shift+B',
  browseInstalledSources: 'CmdOrCtrl+Shift+G',
} as const;

export type ApplicationShortcutName = keyof typeof applicationShortcuts;

interface ParsedShortcut {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

const modifierNames = new Map<string, keyof Omit<ParsedShortcut, 'key'>>([
  ['cmdorctrl', 'ctrl'],
  ['commandorcontrol', 'ctrl'],
  ['ctrl', 'ctrl'],
  ['control', 'ctrl'],
  ['shift', 'shift'],
  ['alt', 'alt'],
]);

export function parseShortcut(accelerator: string): ParsedShortcut {
  const parts = accelerator.split('+');
  const key = parts.pop();
  if (!key) throw new Error(`shortcut ${accelerator} has no key`);
  const parsed: ParsedShortcut = { ctrl: false, shift: false, alt: false, key: key.toUpperCase() };
  for (const part of parts) {
    const modifier = modifierNames.get(part.toLowerCase());
    if (!modifier || parsed[modifier]) throw new Error(`shortcut ${accelerator} is invalid`);
    parsed[modifier] = true;
  }
  return parsed;
}

export function shortcutLabel(accelerator: string): string {
  const { ctrl, shift, alt, key } = parseShortcut(accelerator);
  return [ctrl ? 'Ctrl' : null, shift ? 'Shift' : null, alt ? 'Alt' : null, key]
    .filter((part): part is string => part !== null)
    .join('+');
}

export interface ShortcutKeyEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function matchesShortcut(event: ShortcutKeyEvent, accelerator: string): boolean {
  const shortcut = parseShortcut(accelerator);
  if (
    event.metaKey ||
    event.ctrlKey !== shortcut.ctrl ||
    event.shiftKey !== shortcut.shift ||
    event.altKey !== shortcut.alt
  ) {
    return false;
  }
  const key = event.key.toUpperCase();
  if (key === shortcut.key) return true;
  return (
    /^[A-Z]$/u.test(shortcut.key) &&
    !/^[\x20-\x7e]$/u.test(event.key) &&
    event.code === `Key${shortcut.key}`
  );
}

export const menuShortcutItems = [
  { id: 'file.deploy-managed-mod', accelerator: applicationShortcuts.deployManagedMod },
  { id: 'file.browse-installed-sources', accelerator: applicationShortcuts.browseInstalledSources },
] as const;

export const modalSafeMenuActions: ReadonlySet<ApplicationMenuAction['type']> = new Set<
  ApplicationMenuAction['type']
>([
  'undo',
  'redo',
  'set-theme',
  'set-format-on-save',
  'set-indent-conditionals',
  'set-live-generation-stages',
  'set-gpu-map-rendering',
  'set-inlay-hints',
  'set-delete-permanently',
]);

export function menuActionAllowed(
  type: ApplicationMenuAction['type'],
  modalSurfaceOpen: boolean,
): boolean {
  return !modalSurfaceOpen || modalSafeMenuActions.has(type);
}

export function applicationKeyAllowed(modalSurfaceOpen: boolean): boolean {
  return !modalSurfaceOpen;
}

export function runShortcutAction(state: {
  stopOnly: boolean;
  announcedPhase: RootExecutionPhase | null;
  renderedPhase: RootExecutionPhase;
  canRun: boolean;
}): 'stop' | 'run' | 'explain' | 'none' {
  if ((state.announcedPhase ?? state.renderedPhase) !== 'idle') return 'stop';
  if (state.stopOnly) return 'none';
  return state.canRun ? 'run' : 'explain';
}
