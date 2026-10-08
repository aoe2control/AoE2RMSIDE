import {
  packagedBehaviorProfiles,
  type PackagedBehaviorProfileVersions,
} from '../shared/packaged-game-versions';

export type ControlGameBuildVerification = 'verified' | 'unverified';

const productVersionPattern = /^\d{1,10}\.\d{1,10}\.\d{1,10}\.\d{1,10}$/u;

const packagedGameBuilds: ReadonlyMap<string, ControlGameBuildVerification> =
  buildGameBuildCatalog(packagedBehaviorProfiles);

export function buildGameBuildCatalog(
  entries: ReadonlyArray<readonly [string, PackagedBehaviorProfileVersions]>,
): ReadonlyMap<string, ControlGameBuildVerification> {
  if (entries.length < 1 || entries.length > 16) {
    throw new Error('packaged behavior profile catalog is invalid');
  }
  const catalog = new Map<string, ControlGameBuildVerification>();
  for (const [file, profile] of entries) {
    const unverified = profile.unverifiedProductVersions ?? [];
    if (
      /(aoe2de-[0-9.]+-rms-v1)\.json$/u.exec(file)?.[1] !== profile.profileId ||
      profile.compatibility?.minimumMajor !== 1 ||
      profile.compatibility?.maximumMajor !== 1 ||
      !Array.isArray(profile.productVersions) ||
      !Array.isArray(unverified)
    ) {
      throw new Error('packaged behavior profile catalog is invalid');
    }
    const add = (version: string, verification: ControlGameBuildVerification) => {
      if (typeof version !== 'string' || !productVersionPattern.test(version)) {
        throw new Error('packaged behavior profile catalog is invalid');
      }
      const existing = catalog.get(version);
      if (existing === 'verified' && verification === 'unverified') return;
      catalog.set(version, verification);
    };
    if (unverified.some((version) => profile.productVersions.includes(version))) {
      throw new Error('packaged behavior profile catalog is invalid');
    }
    for (const version of profile.productVersions) add(version, 'verified');
    for (const version of unverified) add(version, 'unverified');
  }
  if (![...catalog.values()].includes('verified')) {
    throw new Error('packaged behavior profile catalog is invalid');
  }
  return catalog;
}

export function controlGameBuildVerification(
  fileVersion: string,
  catalog: ReadonlyMap<string, ControlGameBuildVerification> = packagedGameBuilds,
): ControlGameBuildVerification | undefined {
  return catalog.get(fileVersion);
}
