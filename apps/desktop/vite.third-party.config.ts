import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';

export const bundledPackagesDirectory = resolve(import.meta.dirname, 'dist', 'bundled-packages');
const repositoryRoot = resolve(import.meta.dirname, '../..');

export interface BundledPackage {
  name: string;
  version: string;
  directory: string;
}

const virtualModuleOwners: Array<[RegExp, string]> = [
  [/^\0?vite\//u, 'vite'],
  [/^\0?rolldown[/:]/u, 'rolldown'],
];

function packageNameAt(path: string): string | undefined {
  const marker = '/node_modules/';
  const index = path.lastIndexOf(marker);
  if (index < 0) return undefined;
  const segments = path.slice(index + marker.length).split('/');
  const first = segments[0];
  if (!first) return undefined;
  if (first.startsWith('@')) return segments[1] ? `${first}/${segments[1]}` : undefined;
  return first;
}

function packageAt(directory: string): BundledPackage | undefined {
  const manifestPath = join(directory, 'package.json');
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name?: unknown;
    version?: unknown;
  };
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return undefined;
  return {
    name: manifest.name,
    version: manifest.version,
    directory: relative(repositoryRoot, directory).replaceAll('\\', '/'),
  };
}

export function owningPackage(id: string): BundledPackage | undefined {
  const path = id
    .replace(/^\0/u, '')
    .replace(/[?#].*$/u, '')
    .replaceAll('\\', '/');
  const name = packageNameAt(path);
  if (!name) return undefined;
  const marker = '/node_modules/';
  const root = path.slice(0, path.lastIndexOf(marker) + marker.length) + name;
  return packageAt(root);
}

function importedStylePackage(importer: string, specifier: string): BundledPackage | undefined {
  const name = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
  if (!name) return undefined;
  let directory = dirname(importer);
  for (;;) {
    const found = packageAt(join(directory, 'node_modules', name));
    if (found) return found;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

const bareStyleImport = /@import\s+(?:url\(\s*)?['"]([^'"./][^'"]*)['"]/gu;

export function bundledPackagesCollector(target: 'main' | 'preload' | 'renderer') {
  const packages = new Map<string, BundledPackage>();
  const unknownVirtualModules = new Set<string>();
  const record = (found: BundledPackage | undefined) => {
    if (found) packages.set(`${found.name}@${found.version}\0${found.directory}`, found);
  };
  const recordModule = (id: string) => {
    if (id.startsWith('\0') || !isAbsolute(id)) {
      const owner = virtualModuleOwners.find(([pattern]) => pattern.test(id))?.[1];
      if (owner) record(packageAt(join(repositoryRoot, 'node_modules', owner)));
      else unknownVirtualModules.add(id);
      return;
    }
    const clean = id.replace(/[?#].*$/u, '');
    record(owningPackage(clean));
    if (/\.css$/u.test(clean) && !clean.includes('node_modules') && existsSync(clean)) {
      for (const match of readFileSync(clean, 'utf8').matchAll(bareStyleImport)) {
        if (match[1]) record(importedStylePackage(clean, match[1]));
      }
    }
  };
  const collect: Plugin['generateBundle'] = function (_options, bundle) {
    for (const output of Object.values(bundle)) {
      if (output.type === 'chunk') for (const id of output.moduleIds) recordModule(id);
      else for (const name of output.originalFileNames) recordModule(resolve(name));
    }
  };
  const workerPlugin = (): Plugin => ({
    name: 'rmside-bundled-packages-worker',
    apply: 'build',
    generateBundle: collect,
  });
  const plugin: Plugin = {
    name: 'rmside-bundled-packages',
    apply: 'build',
    generateBundle: collect,
    writeBundle() {
      if (unknownVirtualModules.size > 0) {
        throw new Error(
          `bundled virtual modules without a known owning package: ${[...unknownVirtualModules].join(', ')}`,
        );
      }
      const sorted = [...packages.values()].sort((left, right) =>
        left.name === right.name
          ? left.version.localeCompare(right.version, 'en')
          : left.name.localeCompare(right.name, 'en'),
      );
      mkdirSync(bundledPackagesDirectory, { recursive: true });
      writeFileSync(
        join(bundledPackagesDirectory, `${target}.json`),
        `${JSON.stringify({ schemaVersion: 1, target, packages: sorted }, null, 2)}\n`,
        'utf8',
      );
    },
  };
  return { plugin, workerPlugin };
}
