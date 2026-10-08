import { t } from '../shared/i18n/translator';
import {
  packagedBehaviorProfiles,
  packagedProfileIdForProductVersion,
  type PackagedBehaviorProfileVersions,
} from '../shared/packaged-game-versions';

export interface EditorGameVersionOption {
  profileId: string;
  label: string;
}

export type EditorGameVersionSelection = 'auto' | string;

export function editorGameVersionOptions(
  profiles: ReadonlyArray<
    readonly [string, PackagedBehaviorProfileVersions]
  > = packagedBehaviorProfiles,
): EditorGameVersionOption[] {
  return profiles
    .map(([, profile]) => ({
      profileId: profile.profileId,
      label:
        [...profile.productVersions, ...(profile.unverifiedProductVersions ?? [])].sort(
          compareGameVersionsNewestFirst,
        )[0] ?? profile.profileId,
    }))
    .sort(
      (left, right) =>
        compareGameVersionsNewestFirst(left.label, right.label) ||
        right.profileId.localeCompare(left.profileId, 'en-US'),
    );
}

export function resolveEditorGameVersion(
  selection: EditorGameVersionSelection,
  localProductVersion: string | null,
  options: readonly EditorGameVersionOption[] = editorGameVersionOptions(),
  profileForProductVersion: (
    productVersion: string,
  ) => string | undefined = packagedProfileIdForProductVersion,
): string | null {
  if (selection !== 'auto') {
    return options.some((option) => option.profileId === selection) ? selection : null;
  }
  const local = localProductVersion ? profileForProductVersion(localProductVersion) : undefined;
  return local ?? options[0]?.profileId ?? null;
}

export function localGameVersionLabel(localProductVersion: string | null): string {
  return localProductVersion
    ? t('run-menu.version.local', { version: localProductVersion })
    : t('run-menu.version.local-folder');
}

export function compareGameVersionsNewestFirst(left: string, right: string): number {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] ?? '0';
    const rightPart = rightParts[index] ?? '0';
    const leftNumber = /^\d+$/u.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/u.test(rightPart) ? Number(rightPart) : null;
    const order =
      leftNumber !== null && rightNumber !== null
        ? rightNumber - leftNumber
        : rightPart.localeCompare(leftPart, 'en-US');
    if (order !== 0) return order;
  }
  return 0;
}
