export const themePreferences = ['system', 'light', 'dark'] as const;

export type { ResolvedTheme, ThemePreference } from '../shared/api';
import type { ResolvedTheme, ThemePreference } from '../shared/api';

export const themeStorageKey = 'rmside.theme';

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && themePreferences.includes(value as ThemePreference);
}

export function resolveTheme(preference: ThemePreference, systemIsDark: boolean): ResolvedTheme {
  return preference === 'system' ? (systemIsDark ? 'dark' : 'light') : preference;
}

export function readStoredTheme(storage: Pick<Storage, 'getItem'>): ThemePreference {
  try {
    const value = storage.getItem(themeStorageKey);
    return isThemePreference(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function writeStoredTheme(
  storage: Pick<Storage, 'setItem'>,
  preference: ThemePreference,
): void {
  try {
    storage.setItem(themeStorageKey, preference);
  } catch {}
}
