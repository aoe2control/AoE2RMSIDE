import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createInflateRaw } from 'node:zlib';
import { readFileBounded } from './bounded-file';
import { gameExecutableNames, type GameExecutableName } from './linked-game-process';
import { readExecutableProductVersion } from './pe-version';

export const steamApplicationId = '813780';
export const maximumManifestBytes = 1024 * 1024;
export const maximumDatBytes = 256 * 1024 * 1024;
export const maximumPackageDocumentBytes = 64 * 1024;

const executeFile = promisify(execFile);
const steamExecutableName: GameExecutableName = 'AoE2DE_s.exe';
const packagedExecutableName: GameExecutableName = 'AoE2DE.exe';
const datRelativePath = join('resources', '_common', 'dat', 'empires2_x2_p1.dat');
const packagedGameFolders = ['Game', join('Content', 'Game')] as const;
const packageConfigurationFile = 'MicrosoftGame.config';
const packageManifestFile = 'appxmanifest.xml';
const builtInRmsCandidates = [
  join('resources', '_common', 'random-map-scripts'),
  join('resources', '_common', 'drs', 'gamedata_x2'),
] as const;

export interface InstallationHost {
  readBounded(path: string, maximumBytes: number): Promise<Buffer>;
  listDirectories(path: string): Promise<string[]>;
  pathKind(path: string): Promise<'file' | 'directory' | null>;
  productVersion(executablePath: string): Promise<string | null>;
  datVersionHeader(path: string): Promise<string>;
  sha256(path: string, maximumBytes: number): Promise<{ hash: string; size: number }>;
  steamRoots(): Promise<DiscoveryEvidence<string>[]>;
}

export interface DiscoveryEvidence<T> {
  value: T;
  source: string;
}

export interface InstallationEvidence {
  installationRoot: DiscoveryEvidence<string>;
  executable?: DiscoveryEvidence<GameExecutableName>;
  productVersion?: DiscoveryEvidence<string>;
  steamBuild?: DiscoveryEvidence<string>;
  datHeader?: DiscoveryEvidence<string>;
  contentRevision?: DiscoveryEvidence<string>;
  builtInRmsRoots: DiscoveryEvidence<string>[];
  userProfiles: DiscoveryEvidence<string>[];
}

export interface InstallationReport {
  kind: 'steam' | 'manual';
  valid: boolean;
  evidence: InstallationEvidence;
  uncertainty: string[];
}

export interface SteamDiscoveryOptions {
  userProfileRoot?: string;
}

export interface SteamUserProfileEvidence {
  known: string[];
  mostRecent: string[];
}

export async function discoverSteamInstallations(
  host: InstallationHost = nodeInstallationHost,
  options: SteamDiscoveryOptions = {},
): Promise<InstallationReport[]> {
  const reports: InstallationReport[] = [];
  const seen = new Set<string>();
  for (const steamRoot of await host.steamRoots()) {
    const libraries = await steamLibraries(host, steamRoot);
    for (const library of libraries) {
      const manifestPath = join(
        library.value,
        'steamapps',
        `appmanifest_${steamApplicationId}.acf`,
      );
      let manifest: string;
      try {
        manifest = (await host.readBounded(manifestPath, maximumManifestBytes)).toString('utf8');
      } catch {
        continue;
      }
      let values: Map<string, string>;
      try {
        values = parseKeyValueDocument(manifest);
      } catch {
        continue;
      }
      if (values.get('appid') !== steamApplicationId) continue;
      const installDirectory = values.get('installdir');
      if (!installDirectory) continue;
      const installationRoot = resolve(library.value, 'steamapps', 'common', installDirectory);
      const key = pathKey(installationRoot);
      if (seen.has(key)) continue;
      seen.add(key);
      reports.push(
        await inspectInstallation(
          installationRoot,
          'steam',
          host,
          options.userProfileRoot,
          values.get('buildid')
            ? { value: values.get('buildid')!, source: manifestPath }
            : undefined,
          { value: installationRoot, source: `${manifestPath} via ${steamRoot.source}` },
          [steamExecutableName],
        ),
      );
    }
  }
  return reports.sort((left, right) =>
    left.evidence.installationRoot.value.localeCompare(right.evidence.installationRoot.value),
  );
}

export async function discoverManualInstallation(
  installationRoot: string,
  host: InstallationHost = nodeInstallationHost,
  options: SteamDiscoveryOptions = {},
): Promise<InstallationReport> {
  const selected = resolve(installationRoot);
  const root = await resolveManualGameFolder(selected, host);
  return inspectInstallation(
    root,
    'manual',
    host,
    options.userProfileRoot,
    undefined,
    {
      value: root,
      source:
        root === selected
          ? 'explicit manual selection'
          : `game folder inside the explicit manual selection ${selected}`,
    },
    gameExecutableNames,
  );
}

async function resolveManualGameFolder(selected: string, host: InstallationHost): Promise<string> {
  if (await detectGameExecutable(selected, host)) return selected;
  for (const relativePath of packagedGameFolders) {
    const candidate = join(selected, relativePath);
    if ((await host.pathKind(join(candidate, packagedExecutableName))) === 'file') return candidate;
  }
  return selected;
}

export async function detectGameExecutable(
  installationRoot: string,
  host: InstallationHost = nodeInstallationHost,
  executableNames: readonly GameExecutableName[] = gameExecutableNames,
): Promise<GameExecutableName | null> {
  for (const name of executableNames) {
    if ((await host.pathKind(join(installationRoot, name))) === 'file') return name;
  }
  return null;
}

export async function readInstallationProductVersion(
  installationRoot: string,
  executableName: GameExecutableName,
  host: InstallationHost = nodeInstallationHost,
): Promise<DiscoveryEvidence<string> | undefined> {
  try {
    const value = await host.productVersion(join(installationRoot, executableName));
    if (value) return { value, source: `${executableName} product-version resource` };
  } catch {}
  if (executableName !== packagedExecutableName) return undefined;
  return packageProductVersion(installationRoot, host);
}

async function packageProductVersion(
  gameFolder: string,
  host: InstallationHost,
): Promise<DiscoveryEvidence<string> | undefined> {
  const packageRoot = dirname(gameFolder);
  if (pathKey(packageRoot) === pathKey(gameFolder)) return undefined;
  const configurationPath = join(packageRoot, packageConfigurationFile);
  if ((await host.pathKind(configurationPath)) === 'file') {
    const document = await readPackageDocument(host, configurationPath);
    if (document === null) return undefined;
    const expected = `${basename(gameFolder)}/${packagedExecutableName}`.toLocaleLowerCase('en-US');
    const namesThisFolder = xmlElementAttributes(document, 'Executable', 'Name').some(
      (name) => name.replaceAll('\\', '/').toLocaleLowerCase('en-US') === expected,
    );
    const version = namesThisFolder ? packageIdentityVersion(document) : null;
    return version
      ? { value: version, source: `${configurationPath} package identity version` }
      : undefined;
  }
  const manifestPath = join(packageRoot, packageManifestFile);
  if ((await host.pathKind(manifestPath)) !== 'file') return undefined;
  const document = await readPackageDocument(host, manifestPath);
  const version = document === null ? null : packageIdentityVersion(document);
  return version
    ? { value: version, source: `${manifestPath} package identity version` }
    : undefined;
}

async function readPackageDocument(host: InstallationHost, path: string): Promise<string | null> {
  try {
    return (await host.readBounded(path, maximumPackageDocumentBytes))
      .toString('utf8')
      .replace(/^﻿/u, '');
  } catch {
    return null;
  }
}

export function packageIdentityVersion(document: string): string | null {
  const [version] = xmlElementAttributes(document, 'Identity', 'Version', 1);
  return version !== undefined && /^[0-9]{1,5}(?:\.[0-9]{1,5}){3}$/u.test(version) ? version : null;
}

function xmlElementAttributes(
  document: string,
  element: string,
  attribute: string,
  limit = 64,
): string[] {
  const values: string[] = [];
  const withoutComments = document.replace(/<!--[\s\S]*?-->/gu, '');
  const elementPattern = new RegExp(`<${element}(\\s[^<>]*)>`, 'gu');
  const attributePattern = new RegExp(`(?:^|\\s)${attribute}\\s*=\\s*"([^"<>]*)"`, 'u');
  for (const match of withoutComments.matchAll(elementPattern)) {
    const value = attributePattern.exec(match[1]!)?.[1];
    if (value !== undefined) values.push(value);
    if (values.length >= limit) break;
  }
  return values;
}

async function inspectInstallation(
  installationRoot: string,
  kind: InstallationReport['kind'],
  host: InstallationHost,
  userProfileRoot: string | undefined,
  steamBuild: DiscoveryEvidence<string> | undefined,
  rootEvidence: DiscoveryEvidence<string>,
  executableNames: readonly GameExecutableName[],
): Promise<InstallationReport> {
  const uncertainty: string[] = [];
  const missingAnchors: string[] = [];
  const executableName = await detectGameExecutable(installationRoot, host, executableNames);
  if (!executableName) missingAnchors.push(executableNames.join(' or '));
  const datPath = join(installationRoot, datRelativePath);
  if ((await host.pathKind(datPath)) !== 'file') missingAnchors.push(datRelativePath);
  if (missingAnchors.length > 0) {
    uncertainty.push(`required anchors are missing: ${missingAnchors.join(', ')}`);
  }

  let productVersion: DiscoveryEvidence<string> | undefined;
  if (executableName) {
    productVersion = await readInstallationProductVersion(installationRoot, executableName, host);
    if (!productVersion) uncertainty.push('the executable product version could not be read');
  }

  let datHeader: DiscoveryEvidence<string> | undefined;
  let contentRevision: DiscoveryEvidence<string> | undefined;
  if ((await host.pathKind(datPath)) === 'file') {
    try {
      datHeader = {
        value: await host.datVersionHeader(datPath),
        source: `${datRelativePath} raw-deflate header`,
      };
      const identity = await host.sha256(datPath, maximumDatBytes);
      contentRevision = {
        value: `sha256:${identity.hash};bytes:${identity.size}`,
        source: datRelativePath,
      };
    } catch (error) {
      uncertainty.push(`DAT identity could not be read: ${errorMessage(error)}`);
    }
  }

  const builtInRmsRoots: DiscoveryEvidence<string>[] = [];
  for (const relativePath of builtInRmsCandidates) {
    const path = join(installationRoot, relativePath);
    if ((await host.pathKind(path)) === 'directory') {
      builtInRmsRoots.push({ value: path, source: relativePath });
    }
  }
  if (builtInRmsRoots.length === 0) uncertainty.push('no built-in RMS root was found');

  const profileRoot = resolve(userProfileRoot ?? join(homedir(), 'Games', 'Age of Empires 2 DE'));
  const userProfiles = (await safeListDirectories(host, profileRoot))
    .filter((name) => /^[0-9]{3,20}$/.test(name))
    .map((name) => ({ value: name, source: join(profileRoot, name) }));
  if (userProfiles.length > 1) {
    uncertainty.push(
      executableName === steamExecutableName
        ? 'multiple user profiles were discovered; deployment resolves the active Steam account'
        : 'multiple user profiles were discovered',
    );
  }

  return {
    kind,
    valid: missingAnchors.length === 0 && datHeader !== undefined,
    evidence: {
      installationRoot: rootEvidence,
      ...(executableName
        ? { executable: { value: executableName, source: join(installationRoot, executableName) } }
        : {}),
      ...(productVersion ? { productVersion } : {}),
      ...(steamBuild ? { steamBuild } : {}),
      ...(datHeader ? { datHeader } : {}),
      ...(contentRevision ? { contentRevision } : {}),
      builtInRmsRoots,
      userProfiles,
    },
    uncertainty,
  };
}

async function steamLibraries(
  host: InstallationHost,
  steamRoot: DiscoveryEvidence<string>,
): Promise<DiscoveryEvidence<string>[]> {
  const libraries = new Map<string, DiscoveryEvidence<string>>();
  libraries.set(pathKey(steamRoot.value), steamRoot);
  const path = join(steamRoot.value, 'steamapps', 'libraryfolders.vdf');
  try {
    const document = (await host.readBounded(path, maximumManifestBytes)).toString('utf8');
    for (const value of parseValues(document, 'path')) {
      const normalized = resolve(value.replaceAll('\\\\', '\\'));
      libraries.set(pathKey(normalized), { value: normalized, source: path });
    }
  } catch {}
  return [...libraries.values()];
}

export function parseKeyValueDocument(document: string): Map<string, string> {
  const values = new Map<string, string>();
  const tokens = tokenizeKeyValues(document);
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (
      tokens[index] !== '{' &&
      tokens[index] !== '}' &&
      tokens[index + 1] !== '{' &&
      tokens[index + 1] !== '}'
    ) {
      values.set(tokens[index]!.toLocaleLowerCase('en-US'), tokens[index + 1]!);
      index += 1;
    }
  }
  return values;
}

export async function discoverSteamUserProfiles(
  host: InstallationHost = nodeInstallationHost,
): Promise<SteamUserProfileEvidence> {
  const known = new Set<string>();
  const mostRecent = new Set<string>();
  for (const root of await host.steamRoots()) {
    try {
      const document = (
        await host.readBounded(join(root.value, 'config', 'loginusers.vdf'), maximumManifestBytes)
      ).toString('utf8');
      for (const profile of parseSteamLoginUsers(document)) {
        known.add(profile.id);
        if (profile.mostRecent) mostRecent.add(profile.id);
      }
    } catch {}
  }
  return {
    known: [...known].sort((left, right) => left.localeCompare(right)),
    mostRecent: [...mostRecent].sort((left, right) => left.localeCompare(right)),
  };
}

export async function installationAccountProfiles(
  report: InstallationReport,
  host: InstallationHost = nodeInstallationHost,
): Promise<SteamUserProfileEvidence> {
  return report.evidence.executable?.value === steamExecutableName
    ? discoverSteamUserProfiles(host)
    : { known: [], mostRecent: [] };
}

export function resolveDeploymentUserProfile(
  profiles: readonly DiscoveryEvidence<string>[],
  options: {
    managedProfileIds: readonly string[];
    rememberedProfileId?: string;
    steamProfiles: SteamUserProfileEvidence;
  },
): DiscoveryEvidence<string> | null {
  const uniqueProfile = (ids: readonly string[]) => {
    const matches = profiles.filter((candidate) => ids.includes(candidate.value));
    return matches.length === 1 ? matches[0] : undefined;
  };
  return (
    uniqueProfile(options.steamProfiles.mostRecent) ??
    uniqueProfile(options.steamProfiles.known) ??
    uniqueProfile(options.managedProfileIds) ??
    profiles.find((candidate) => candidate.value === options.rememberedProfileId) ??
    (profiles.length === 1 ? profiles[0]! : null)
  );
}

export function parseSteamLoginUsers(document: string): { id: string; mostRecent: boolean }[] {
  const tokens = tokenizeKeyValues(document);
  const profiles: { id: string; mostRecent: boolean }[] = [];
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const id = tokens[index]!;
    if (!/^[0-9]{17}$/u.test(id) || tokens[index + 1] !== '{') continue;
    let depth = 1;
    let mostRecent = false;
    let closed = false;
    let cursor = index + 2;
    for (; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor]!;
      if (token === '{') {
        depth += 1;
        continue;
      }
      if (token === '}') {
        depth -= 1;
        if (depth === 0) {
          closed = true;
          break;
        }
        continue;
      }
      if (
        depth === 1 &&
        token.toLocaleLowerCase('en-US') === 'mostrecent' &&
        tokens[cursor + 1] === '1'
      ) {
        mostRecent = true;
      }
    }
    if (closed) profiles.push({ id, mostRecent });
    index = cursor;
  }
  return profiles;
}

function parseValues(document: string, requestedKey: string): string[] {
  const values: string[] = [];
  const tokens = tokenizeKeyValues(document);
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (tokens[index]?.toLocaleLowerCase('en-US') === requestedKey && tokens[index + 1] !== '{') {
      values.push(tokens[index + 1]!);
      index += 1;
    }
  }
  return values;
}

function tokenizeKeyValues(document: string): string[] {
  if (Buffer.byteLength(document, 'utf8') > maximumManifestBytes) {
    throw new Error('Steam manifest exceeds its bounded size');
  }
  const tokens: string[] = [];
  let index = 0;
  while (index < document.length) {
    const character = document[index]!;
    if (/\s/.test(character)) {
      index += 1;
    } else if (character === '{' || character === '}') {
      tokens.push(character);
      index += 1;
    } else if (character === '"') {
      index += 1;
      let value = '';
      let terminated = false;
      while (index < document.length) {
        const next = document[index++]!;
        if (next === '"') {
          terminated = true;
          break;
        }
        if (next === '\\') {
          if (index >= document.length) throw new Error('truncated Steam manifest escape');
          value += document[index++]!;
        } else {
          value += next;
        }
        if (value.length > 32_768) throw new Error('Steam manifest token exceeds its limit');
      }
      if (!terminated) throw new Error('unterminated Steam manifest string');
      tokens.push(value);
    } else {
      throw new Error('Steam manifest contains an unsupported token');
    }
    if (tokens.length > 100_000) throw new Error('Steam manifest has too many tokens');
  }
  return tokens;
}

async function safeListDirectories(host: InstallationHost, path: string): Promise<string[]> {
  try {
    return await host.listDirectories(path);
  } catch {
    return [];
  }
}

export interface RememberedInstallationSelection {
  installationRoot: string;
  userProfileId?: string;
}

export class InstallationSelectionStore {
  private readonly path: string;
  private readonly automaticDiscoveryDisabledPath: string;

  constructor(userDataPath: string) {
    this.path = join(resolve(userDataPath), 'installation-selection-v1.json');
    this.automaticDiscoveryDisabledPath = join(
      resolve(userDataPath),
      'installation-auto-discovery-v1.disabled',
    );
  }

  async read(): Promise<RememberedInstallationSelection | null> {
    try {
      const bytes = await readFileBounded(this.path, 64 * 1024);
      return validateSelection(JSON.parse(bytes.toString('utf8')));
    } catch {
      return null;
    }
  }

  async write(selection: RememberedInstallationSelection): Promise<void> {
    const validated = validateSelection(selection);
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(validated)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await rename(temporaryPath, this.path);
      await rm(this.automaticDiscoveryDisabledPath, { force: true });
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async unlink(): Promise<void> {
    const temporaryPath = `${this.automaticDiscoveryDisabledPath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await writeFile(temporaryPath, 'unlinked\n', { encoding: 'utf8', flag: 'wx' });
      await rename(temporaryPath, this.automaticDiscoveryDisabledPath);
      await rm(this.path, { force: true });
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async automaticDiscoveryEnabled(): Promise<boolean> {
    try {
      await stat(this.automaticDiscoveryDisabledPath);
      return false;
    } catch {
      return true;
    }
  }
}

function validateSelection(value: unknown): RememberedInstallationSelection {
  if (!value || typeof value !== 'object') throw new Error('installation selection is invalid');
  const record = value as Partial<RememberedInstallationSelection>;
  if (
    typeof record.installationRoot !== 'string' ||
    record.installationRoot.length < 1 ||
    record.installationRoot.length > 32_768 ||
    (record.userProfileId !== undefined &&
      (typeof record.userProfileId !== 'string' || !/^[0-9]{3,20}$/.test(record.userProfileId)))
  ) {
    throw new Error('installation selection is invalid');
  }
  return {
    installationRoot: normalize(record.installationRoot),
    ...(record.userProfileId ? { userProfileId: record.userProfileId } : {}),
  };
}

async function registrySteamRoots(): Promise<DiscoveryEvidence<string>[]> {
  const queries = [
    {
      key: 'HKCU\\Software\\Valve\\Steam',
      value: 'SteamPath',
    },
    {
      key: 'HKLM\\Software\\WOW6432Node\\Valve\\Steam',
      value: 'InstallPath',
    },
  ];
  const roots: DiscoveryEvidence<string>[] = [];
  for (const query of queries) {
    try {
      const { stdout } = await executeFile('reg.exe', ['query', query.key, '/v', query.value], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
      const line = stdout
        .split(/\r?\n/)
        .find((candidate) =>
          candidate.toLocaleLowerCase('en-US').includes(query.value.toLowerCase()),
        );
      const match = line?.match(/REG_SZ\s+(.+)$/i);
      if (match?.[1]) roots.push({ value: resolve(match[1].trim()), source: query.key });
    } catch {}
  }
  const unique = new Map(roots.map((entry) => [pathKey(entry.value), entry]));
  return [...unique.values()];
}

const productVersionCacheLimit = 64;
const productVersionCache = new Map<
  string,
  { size: number; mtimeMs: number; value: string | null }
>();

async function executableProductVersion(executablePath: string): Promise<string | null> {
  const metadata = await stat(executablePath).catch(() => null);
  const key = pathKey(executablePath);
  const cached = productVersionCache.get(key);
  if (metadata && cached && cached.size === metadata.size && cached.mtimeMs === metadata.mtimeMs) {
    return cached.value;
  }
  const result = await readExecutableProductVersion(executablePath);
  if (metadata) {
    if (productVersionCache.size >= productVersionCacheLimit) productVersionCache.clear();
    productVersionCache.set(key, { size: metadata.size, mtimeMs: metadata.mtimeMs, value: result });
  }
  return result;
}

async function readDatVersionHeader(path: string): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maximumDatBytes) {
    throw new Error('DAT is missing or exceeds its bounded size');
  }
  return new Promise<string>((resolvePromise, reject) => {
    const source = createReadStream(path, { highWaterMark: 64 * 1024 });
    const decoder = createInflateRaw();
    let header = Buffer.alloc(0);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      source.destroy();
      decoder.destroy();
      reject(error);
    };
    source.once('error', fail);
    decoder.once('error', fail);
    decoder.on('data', (chunk: Buffer) => {
      if (settled) return;
      header = Buffer.concat([header, chunk.subarray(0, 8 - header.byteLength)]);
      if (header.byteLength < 8) return;
      const value = header.toString('ascii').replaceAll('\0', '').trim();
      if (!/^VER [78]\.[0-9]$/u.test(value)) {
        fail(new Error(`unsupported DAT version header ${JSON.stringify(value)}`));
        return;
      }
      settled = true;
      source.destroy();
      decoder.destroy();
      resolvePromise(value);
    });
    decoder.once('end', () => {
      if (!settled) fail(new Error('DAT version header is truncated'));
    });
    source.pipe(decoder);
  });
}

export const nodeInstallationHost: InstallationHost = {
  async readBounded(path, maximumBytes) {
    return readFileBounded(path, maximumBytes);
  },
  async listDirectories(path) {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry: Dirent) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  },
  async pathKind(path) {
    try {
      const metadata = await stat(path);
      if (metadata.isFile()) return 'file';
      if (metadata.isDirectory()) return 'directory';
      return null;
    } catch {
      return null;
    }
  },
  productVersion: executableProductVersion,
  datVersionHeader: readDatVersionHeader,
  async sha256(path, maximumBytes) {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > maximumBytes) {
      throw new Error('content file is missing or exceeds its bounded size');
    }
    const hash = createHash('sha256');
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
      stream.on('data', (chunk) => {
        hash.update(chunk);
      });
      stream.once('error', reject);
      stream.once('end', resolvePromise);
    });
    return { hash: hash.digest('hex'), size: metadata.size };
  },
  steamRoots: registrySteamRoots,
};

function pathKey(path: string): string {
  return normalize(path).toLocaleLowerCase('en-US');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function installationDisplayName(report: InstallationReport): string {
  const root = report.evidence.installationRoot.value;
  const version = report.evidence.productVersion?.value;
  return version ? `${basename(root)} (${version})` : basename(root);
}
