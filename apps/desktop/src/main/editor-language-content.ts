import type {
  ConfigurationCatalog,
  ContentPackDescriptor,
  LanguageContentSelection,
  PreviewVersionOrigin,
} from '../shared/api';

export interface EditorLanguageVersion {
  profileId: string | null;
  versionOrigin: PreviewVersionOrigin;
}

type ContentIdentity = Pick<ContentPackDescriptor, 'packId' | 'packVersion' | 'contentHash'>;

export function editorLanguageContentSelection(
  catalog: ConfigurationCatalog,
  version: EditorLanguageVersion,
  localContent: ContentIdentity | null,
): LanguageContentSelection | null {
  const knownProfile = (profileId: string | undefined) =>
    profileId !== undefined &&
    catalog.behaviorProfiles.some((profile) => profile.profileId === profileId);
  if (version.versionOrigin === 'local' && localContent) {
    const pack = catalog.contentPacks.find((candidate) => sameContent(candidate, localContent));
    const profileId = pack?.compatibleProfileIds.find(knownProfile);
    if (pack && profileId) return selectionOf(pack, profileId, 'local');
  }
  const profileId = knownProfile(version.profileId ?? undefined)
    ? version.profileId!
    : catalog.contentPacks
        .find((candidate) => candidate.packagedBundle)
        ?.compatibleProfileIds.find(knownProfile);
  if (!profileId) return null;
  const pack = catalog.contentPacks
    .filter((candidate) => candidate.compatibleProfileIds.includes(profileId))
    .filter((candidate) => !localContent || !sameContent(candidate, localContent))
    .sort(
      (left, right) =>
        Number(right.packagedBundle) - Number(left.packagedBundle) ||
        Number(left.synthetic) - Number(right.synthetic) ||
        right.packVersion.localeCompare(left.packVersion, 'en-US', { numeric: true }) ||
        left.packId.localeCompare(right.packId, 'en-US'),
    )[0];
  return pack ? selectionOf(pack, profileId, version.versionOrigin) : null;
}

function sameContent(left: ContentIdentity, right: ContentIdentity): boolean {
  return (
    left.packId === right.packId &&
    left.packVersion === right.packVersion &&
    left.contentHash === right.contentHash
  );
}

function selectionOf(
  pack: ContentIdentity,
  profileId: string,
  versionOrigin: PreviewVersionOrigin,
): LanguageContentSelection {
  return {
    profileId,
    packId: pack.packId,
    packVersion: pack.packVersion,
    contentHash: pack.contentHash,
    versionOrigin,
  };
}
