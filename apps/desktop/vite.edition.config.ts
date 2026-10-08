import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Alias } from 'vite';
import { capabilitiesFor, parseEdition, type Edition } from './src/shared/edition';

export interface BuildIdentity {
  edition: Edition;
  version: string;
  commit: string;
}

export function buildIdentity(environment: NodeJS.ProcessEnv = process.env): BuildIdentity {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8'),
  ) as { version?: unknown };
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('the desktop package version is missing');
  }
  return {
    edition: parseEdition(environment.RMSIDE_EDITION?.trim()),
    version: manifest.version,
    commit: environment.RMSIDE_BUILD_COMMIT?.trim() || gitCommit(),
  };
}

function gitCommit(): string {
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: import.meta.dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  try {
    const commit = git('rev-parse', '--short=7', 'HEAD');
    if (!/^[0-9a-f]{7,40}$/u.test(commit)) return 'unknown';
    return git('status', '--porcelain', '--untracked-files=normal').length > 0
      ? `${commit}-dirty`
      : commit;
  } catch {
    return 'unknown';
  }
}

export function buildIdentityDefines(identity: BuildIdentity): Record<string, string> {
  return {
    __RMSIDE_EDITION__: JSON.stringify(identity.edition),
    __RMSIDE_VERSION__: JSON.stringify(identity.version),
    __RMSIDE_COMMIT__: JSON.stringify(identity.commit),
  };
}

export function rendererEditionAliases(edition: Edition): Alias[] {
  const capabilities = capabilitiesFor(edition);
  const stubs = resolve(import.meta.dirname, 'src/renderer/edition-stubs.tsx');
  const empty = resolve(import.meta.dirname, 'src/renderer/edition-empty-module.ts');
  const omitted: Array<[boolean, RegExp, string]> = [
    [capabilities.preview, /^\.\/preview-panel$/u, stubs],
    [capabilities.preview, /^pixi\.js\/unsafe-eval$/u, empty],
    [capabilities.deployment, /^\.\/managed-mod-deployment-panel$/u, stubs],
    [capabilities.installedSourceBrowser, /^\.\/installed-source-browser$/u, stubs],
  ];
  return omitted
    .filter(([present]) => !present)
    .map(([, find, replacement]) => ({ find, replacement }));
}
