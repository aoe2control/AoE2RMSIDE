export interface PackagedBehaviorProfileVersions {
  profileId: string;
  compatibility: { minimumMajor: number; maximumMajor: number };
  productVersions: string[];
  unverifiedProductVersions?: string[];
}

interface PackagedContentCompleteness {
  $schema: string;
  behaviorProfileId: string;
  civilizationCount: number;
}

export const packagedBehaviorProfiles: ReadonlyArray<
  readonly [string, PackagedBehaviorProfileVersions]
> = Object.entries(
  import.meta.glob<PackagedBehaviorProfileVersions>('../../../../profiles/aoe2de-*-rms-v1.json', {
    eager: true,
    import: 'default',
  }),
);

const packagedCompleteness = Object.entries(
  import.meta.glob<PackagedContentCompleteness>(
    '../../../../crates/rms-content/data/aoe2de-*-content-completeness.json',
    { eager: true, import: 'default' },
  ),
);

export function buildCivilizationCountCatalog(
  entries: ReadonlyArray<readonly [string, PackagedContentCompleteness]>,
  profiles: ReadonlyArray<readonly [string, PackagedBehaviorProfileVersions]>,
): ReadonlyMap<string, number> {
  const profileIds = new Set(profiles.map(([, profile]) => profile.profileId));
  const counts = new Map<string, number>();
  for (const [, completeness] of entries) {
    if (
      completeness.$schema !== 'https://rmside.invalid/schemas/content-completeness/v1' ||
      !profileIds.has(completeness.behaviorProfileId) ||
      counts.has(completeness.behaviorProfileId) ||
      !Number.isInteger(completeness.civilizationCount) ||
      completeness.civilizationCount < 1 ||
      completeness.civilizationCount > 256
    ) {
      throw new Error('packaged content completeness catalog is invalid');
    }
    counts.set(completeness.behaviorProfileId, completeness.civilizationCount);
  }
  if (counts.size !== profileIds.size) {
    throw new Error('packaged content completeness catalog is invalid');
  }
  return counts;
}

const civilizationCounts = buildCivilizationCountCatalog(
  packagedCompleteness,
  packagedBehaviorProfiles,
);

export function packagedProfileIdForProductVersion(productVersion: string): string | undefined {
  return packagedBehaviorProfiles.find(
    ([, profile]) =>
      profile.productVersions.includes(productVersion) ||
      (profile.unverifiedProductVersions ?? []).includes(productVersion),
  )?.[1].profileId;
}

export function packagedCivilizationCount(
  profileId: string | null,
  productVersion: string | null = null,
): number | undefined {
  const versionProfile = productVersion
    ? packagedProfileIdForProductVersion(productVersion)
    : undefined;
  const effectiveProfile = versionProfile ?? profileId;
  return effectiveProfile ? civilizationCounts.get(effectiveProfile) : undefined;
}
