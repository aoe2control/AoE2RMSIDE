import { stat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, resolve, win32 } from 'node:path';
import type { ExternalLanguage } from './external-language-compatibility';
import { compareSemanticVersions, parseSemanticVersion } from './semantic-version';

export type ExternalCandidateOrigin = 'override' | 'path' | 'cargo' | 'vscode';

export interface ExternalServerCandidate {
  language: ExternalLanguage;
  path: string;
  origin: ExternalCandidateOrigin;
  bundleVersion: string | null;
}

export interface ExternalDetectionEnvironment {
  platform: NodeJS.Platform;
  path: string | undefined;
  homeDirectory: string;
  excludedRoots: readonly string[];
  overrides: Partial<Record<ExternalLanguage, string>>;
  isFile(path: string): Promise<boolean>;
  listDirectory(path: string): Promise<string[]>;
}

export const externalProgramNames: Readonly<Record<ExternalLanguage, string>> = {
  rms: 'rms-check-lsp',
  xs: 'xs-check-lsp',
};

export const maximumExternalCandidates = 4;
const maximumPathEntries = 256;
const maximumExtensionEntries = 2_048;

const xsExtensionPattern = /^divy\.vscode-xs-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/iu;
const extensionFolders = ['.vscode', '.vscode-insiders', '.vscode-oss'];

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

function comparisonKey(platform: NodeJS.Platform, path: string): string {
  const normalized = pathApi(platform).normalize(path);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isInsideRoot(platform: NodeJS.Platform, path: string, root: string): boolean {
  const api = pathApi(platform);
  const between = api.relative(
    comparisonKey(platform, api.resolve(root)),
    comparisonKey(platform, api.resolve(path)),
  );
  return between === '' || (!between.startsWith('..') && !api.isAbsolute(between));
}

export async function externalServerCandidates(
  language: ExternalLanguage,
  environment: ExternalDetectionEnvironment,
): Promise<ExternalServerCandidate[]> {
  const { platform } = environment;
  const api = pathApi(platform);
  const program = externalProgramNames[language] + (platform === 'win32' ? '.exe' : '');
  const proposals: ExternalServerCandidate[] = [];
  const override = environment.overrides[language];
  if (override && api.isAbsolute(override)) {
    proposals.push({
      language,
      path: api.normalize(override),
      origin: 'override',
      bundleVersion: null,
    });
  }
  const pathEntries = (environment.path ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim().replace(/^"(.*)"$/u, '$1'))
    .filter((entry) => entry !== '' && api.isAbsolute(entry))
    .slice(0, maximumPathEntries);
  for (const entry of pathEntries) {
    proposals.push({
      language,
      path: api.join(entry, program),
      origin: 'path',
      bundleVersion: null,
    });
  }
  proposals.push({
    language,
    path: api.join(environment.homeDirectory, '.cargo', 'bin', program),
    origin: 'cargo',
    bundleVersion: null,
  });
  if (language === 'xs') {
    const bundles: Array<{ path: string; version: string }> = [];
    for (const folder of extensionFolders) {
      const extensions = api.join(environment.homeDirectory, folder, 'extensions');
      let entries: string[];
      try {
        entries = (await environment.listDirectory(extensions)).slice(0, maximumExtensionEntries);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const version = xsExtensionPattern.exec(entry)?.[1];
        if (version && parseSemanticVersion(version)) {
          bundles.push({ path: api.join(extensions, entry, 'server', program), version });
        }
      }
    }
    bundles.sort((left, right) =>
      compareSemanticVersions(
        parseSemanticVersion(right.version)!,
        parseSemanticVersion(left.version)!,
      ),
    );
    for (const bundle of bundles) {
      proposals.push({
        language,
        path: bundle.path,
        origin: 'vscode',
        bundleVersion: bundle.version,
      });
    }
  }
  const seen = new Set<string>();
  const candidates: ExternalServerCandidate[] = [];
  for (const proposal of proposals) {
    if (candidates.length >= maximumExternalCandidates) break;
    const key = comparisonKey(platform, proposal.path);
    if (seen.has(key)) continue;
    seen.add(key);
    if (
      proposal.origin !== 'override' &&
      environment.excludedRoots.some((root) => isInsideRoot(platform, proposal.path, root))
    )
      continue;
    if (await environment.isFile(proposal.path).catch(() => false)) candidates.push(proposal);
  }
  return candidates;
}

export function nodeDetectionEnvironment(
  excludedRoots: readonly string[],
  overrides: Partial<Record<ExternalLanguage, string>>,
): ExternalDetectionEnvironment {
  return {
    platform: process.platform,
    path: process.env.PATH ?? process.env.Path,
    homeDirectory: process.env.USERPROFILE || homedir(),
    excludedRoots: excludedRoots.map((root) => resolve(root)),
    overrides,
    isFile: async (path) => (await stat(path)).isFile(),
    listDirectory: (path) => readdir(path),
  };
}
