import { basename } from 'node:path';
import type { PositionEncoding } from './external-language-position';

export type ExternalLanguage = 'rms' | 'xs';

export const externalLanguages: readonly ExternalLanguage[] = ['rms', 'xs'];

export const externalLanguageNames: Readonly<Record<ExternalLanguage, string>> = {
  rms: 'RMS',
  xs: 'XS',
};

export interface ExternalServerIdentity {
  name: string | null;
  version: string | null;
  programPath: string;
  bundleVersion: string | null;
}

export interface ExternalConfigurationContext {
  documentFolders: readonly string[];
}

export interface CompatibilityProfile {
  id: 'xsc' | 'rmsc' | 'generic';
  displayName: string;
  codePrefix: string;
  positionEncoding?: PositionEncoding;
  asciiSubstitution: boolean;
  onlyExistingFiles: boolean;
  refreshClosedFromDisk: boolean;
  configuration(section: string | null, context: ExternalConfigurationContext): unknown;
  configurationUsesFolders: boolean;
  testedVersions: readonly string[];
  provisional: boolean;
}

const maximumDisplayName = 64;

export const xscConfigurationSection = 'xsc';

const xsc: Omit<CompatibilityProfile, 'displayName'> = {
  id: 'xsc',
  codePrefix: 'XSC',
  asciiSubstitution: true,
  positionEncoding: 'utf-32',
  onlyExistingFiles: true,
  refreshClosedFromDisk: true,
  configuration: (section, context) =>
    section === xscConfigurationSection
      ? {
          ignores: [],
          extraPreludePath: '',
          includeDirectories: [...context.documentFolders],
          flavour: 'AoE2:DE',
        }
      : null,
  configurationUsesFolders: true,
  testedVersions: ['0.1.0'],
  provisional: false,
};

const rmsc: Omit<CompatibilityProfile, 'displayName'> = {
  id: 'rmsc',
  codePrefix: 'RMSC',
  asciiSubstitution: true,
  positionEncoding: 'utf-32',
  onlyExistingFiles: true,
  refreshClosedFromDisk: true,
  configuration: () => null,
  configurationUsesFolders: false,
  testedVersions: [],
  provisional: true,
};

const generic: Omit<CompatibilityProfile, 'displayName'> = {
  id: 'generic',
  codePrefix: 'EXT',
  asciiSubstitution: false,
  onlyExistingFiles: false,
  refreshClosedFromDisk: false,
  configuration: () => null,
  configurationUsesFolders: false,
  testedVersions: [],
  provisional: false,
};

export function programStem(programPath: string): string {
  const name = basename(programPath.replaceAll('\\', '/'));
  return name.replace(/\.exe$/iu, '').toLowerCase();
}

export function compatibilityProfile(
  language: ExternalLanguage,
  identity: ExternalServerIdentity,
): CompatibilityProfile {
  const name = identity.name?.trim().toLowerCase() ?? null;
  const stem = programStem(identity.programPath);
  if (language === 'xs' && (name === 'xs check' || (name === null && stem === 'xs-check-lsp'))) {
    return { ...xsc, displayName: 'XS Check' };
  }
  if (
    language === 'rms' &&
    ((name !== null && /^rms[\s_-]?check\b/u.test(name)) ||
      (name === null && stem === 'rms-check-lsp'))
  ) {
    return { ...rmsc, displayName: 'RMS Check' };
  }
  return { ...generic, displayName: displayNameOf(identity) };
}

export function untestedVersion(
  profile: CompatibilityProfile,
  identity: ExternalServerIdentity,
): boolean {
  if (profile.id === 'generic') return false;
  return identity.version === null || !profile.testedVersions.includes(identity.version);
}

export function displayNameOf(identity: ExternalServerIdentity): string {
  const own = identity.name?.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
  const name = own || basename(identity.programPath.replaceAll('\\', '/'));
  return name.length > maximumDisplayName ? `${name.slice(0, maximumDisplayName - 1)}…` : name;
}

export function versionLabel(identity: ExternalServerIdentity): string | null {
  const parts = [identity.version, identity.bundleVersion]
    .filter((part): part is string => !!part)
    .map((part) => part.replace(/[^\w.+-]/gu, '').slice(0, 32))
    .filter(Boolean);
  return parts.length === 0 ? null : parts.join(', ');
}
