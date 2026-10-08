import { isSafeWindowsPathPart } from './windows-names';

export const managedModDirectoryName = 'AoE2RMSIDE-Managed-Maps';

export const maximumPersistentModNameLength = 120;

export const fallbackPersistentModName = 'MyRMSMod';

export function isPersistentModName(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maximumPersistentModNameLength &&
    value === value.trimEnd() &&
    !value.endsWith('.') &&
    isSafeWindowsPathPart(value)
  );
}

export function isReservedPersistentModName(value: string): boolean {
  return value.toLocaleLowerCase('en-US') === managedModDirectoryName.toLocaleLowerCase('en-US');
}

export function modNameFromScriptName(fileName: string): string {
  const base = fileName.split(/[\\/]/u).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  const cleaned = stem.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-').trim();
  let cut = '';
  for (const character of cleaned) {
    if (cut.length + character.length > maximumPersistentModNameLength) break;
    cut += character;
  }
  const name = cut.replace(/[.\s]+$/u, '');
  return isPersistentModName(name) && !isReservedPersistentModName(name)
    ? name
    : fallbackPersistentModName;
}
