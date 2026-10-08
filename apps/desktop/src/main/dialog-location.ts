import { dirname } from 'node:path';
import type { DesktopSession } from '../shared/api';

export type DialogPurpose = keyof DesktopSession['dialogLocations'];

export async function dialogDirectory(
  locations: DesktopSession['dialogLocations'],
  purpose: DialogPurpose,
  validDirectory: (path: string | null) => Promise<string | undefined>,
  fallbacks: readonly (string | null)[] = [],
): Promise<string | undefined> {
  const remembered = locations[purpose];
  const directory = purpose === 'file' && remembered ? dirname(remembered) : remembered;
  for (const candidate of [directory, ...fallbacks]) {
    if (!candidate) continue;
    const valid = await validDirectory(candidate);
    if (valid) return valid;
  }
  return undefined;
}
