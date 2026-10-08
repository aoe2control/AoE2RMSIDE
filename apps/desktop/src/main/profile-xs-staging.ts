import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { FileTooLargeError, readFileBounded } from './bounded-file';
import { isSafeWindowsPathPart } from './windows-names';
import { atomicReplaceFile } from './workspace-service';

export const profileXsStagingStateFileName = 'profile-xs-staging-v1.json';
const xsFolderParts = ['resources', '_common', 'xs'] as const;
const maximumStagedFiles = 256;
const maximumProfiles = 64;
const maximumXsFileBytes = 64 * 1024 * 1024;
const maximumStateBytes = 1024 * 1024;

export type ProfileXsStagingCode =
  | 'xs-profile-file-not-owned'
  | 'xs-profile-file-changed'
  | 'xs-profile-name-invalid'
  | 'xs-profile-name-collision'
  | 'xs-profile-folder-unsafe'
  | 'xs-profile-record-invalid'
  | 'xs-profile-staging-failed';

export class ProfileXsStagingError extends Error {
  constructor(
    readonly code: ProfileXsStagingCode,
    message: string,
  ) {
    super(`${message} (${code})`);
    this.name = 'ProfileXsStagingError';
  }
}

export interface ProfileXsFile {
  name: string;
  bytes: Uint8Array;
}

export interface ProfileXsStagingTarget {
  profileRoot: string;
  profileId: string;
}

export interface ProfileXsStagingResult {
  files: string[];
  written: string[];
  removed: string[];
  changed: boolean;
}

export interface ProfileXsFileOperations {
  replaceFile(path: string, bytes: Uint8Array): Promise<void>;
  removeFile(path: string): Promise<void>;
}

const nodeFileOperations: ProfileXsFileOperations = {
  replaceFile: atomicReplaceFile,
  removeFile: (path) => rm(path),
};

interface ProfileRecord {
  profileId: string;
  files: Record<string, string>;
  interrupted?: Record<string, string[]>;
}

interface StagingState {
  schemaVersion: '1.0.0';
  compatibility: { readerMajor: 1 };
  profiles: Record<string, ProfileRecord>;
}

type OnDisk =
  { kind: 'missing' } | { kind: 'other' } | { kind: 'file'; hash: string; bytes: Buffer };

interface PlannedWrite {
  name: string;
  path: string;
  bytes: Uint8Array;
  hash: string;
  previous: { hash: string; bytes: Buffer } | null;
}

interface PlannedRemoval {
  name: string;
  path: string;
  hash: string;
  bytes: Buffer;
}

export interface ProfileXsStagingPlan {
  readonly key: string;
  readonly target: ProfileXsStagingTarget;
  readonly folder: string;
  readonly label: string;
  readonly missingFolders: readonly string[];
  readonly writes: readonly PlannedWrite[];
  readonly removals: readonly PlannedRemoval[];
  readonly keeps: readonly { name: string; path: string; hash: string }[];
  readonly files: readonly string[];
  readonly recordSnapshot: string;
  readonly nextRecord: ProfileRecord | null;
}

export class ProfileXsStaging {
  private readonly statePath: string;

  constructor(
    userDataPath: string,
    private readonly operations: ProfileXsFileOperations = nodeFileOperations,
  ) {
    this.statePath = join(resolve(userDataPath), profileXsStagingStateFileName);
  }

  async plan(
    target: ProfileXsStagingTarget,
    files: readonly ProfileXsFile[],
  ): Promise<ProfileXsStagingPlan> {
    validateTarget(target);
    const label = folderLabel(target.profileRoot);
    const desired = new Map<string, { name: string; bytes: Uint8Array; hash: string }>();
    for (const file of files) {
      if (!isPlainXsName(file.name)) {
        throw new ProfileXsStagingError(
          'xs-profile-name-invalid',
          `XS file name ${safeName(file.name)} can't be copied to your profile's XS folder (${label}); #includeXS has to name a plain file`,
        );
      }
      const hash = hashBytes(file.bytes);
      const existing = desired.get(nameKey(file.name));
      if (existing) {
        if (existing.hash === hash) continue;
        throw new ProfileXsStagingError(
          'xs-profile-name-collision',
          `Two different XS files would both be copied as ${file.name} to your profile's XS folder (${label})`,
        );
      }
      desired.set(nameKey(file.name), { name: file.name, bytes: file.bytes, hash });
    }
    if (desired.size > maximumStagedFiles) {
      throw new ProfileXsStagingError(
        'xs-profile-staging-failed',
        `The map loads more XS files than a live test copies to your profile's XS folder (${label})`,
      );
    }

    const state = await this.readState();
    const key = profileKey(target);
    const record = state.profiles[key];
    if (record && record.profileId !== target.profileId) {
      throw new ProfileXsStagingError(
        'xs-profile-record-invalid',
        "AoE2RMSIDE's record of XS files copied to your profile is invalid",
      );
    }
    const owned = ownedHashes(record);
    const folder = await inspectFolder(target.profileRoot, label);
    const writes: PlannedWrite[] = [];
    const keeps: Array<{ name: string; path: string; hash: string }> = [];
    const nextFiles: Record<string, string> = {};
    for (const [nameKeyValue, file] of [...desired].sort(([left], [right]) =>
      compare(left, right),
    )) {
      const path = join(folder.path, file.name);
      const current = folder.missing.length > 0 ? missing : await onDisk(path);
      const ownership = owned.get(nameKeyValue);
      if (current.kind === 'missing') {
        writes.push({ name: file.name, path, bytes: file.bytes, hash: file.hash, previous: null });
        nextFiles[file.name] = file.hash;
      } else if (current.kind === 'other') {
        throw notOwned(file.name, label);
      } else if (ownership?.hashes.has(current.hash)) {
        nextFiles[file.name] = file.hash;
        if (current.hash === file.hash) keeps.push({ name: file.name, path, hash: file.hash });
        else {
          writes.push({
            name: file.name,
            path,
            bytes: file.bytes,
            hash: file.hash,
            previous: { hash: current.hash, bytes: current.bytes },
          });
        }
      } else if (ownership) {
        throw changedSinceCopied(file.name, label);
      } else if (current.hash === file.hash) {
        keeps.push({ name: file.name, path, hash: file.hash });
      } else {
        throw notOwned(file.name, label);
      }
    }
    const removals: PlannedRemoval[] = [];
    for (const [nameKeyValue, ownership] of [...owned].sort(([left], [right]) =>
      compare(left, right),
    )) {
      if (desired.has(nameKeyValue)) continue;
      const path = join(folder.path, ownership.name);
      const current = folder.missing.length > 0 ? missing : await onDisk(path);
      if (current.kind === 'file' && ownership.hashes.has(current.hash)) {
        removals.push({ name: ownership.name, path, hash: current.hash, bytes: current.bytes });
      }
    }
    const nextRecord: ProfileRecord | null =
      Object.keys(nextFiles).length > 0
        ? { profileId: target.profileId, files: sortedRecord(nextFiles) }
        : null;
    return Object.freeze({
      key,
      target: { ...target },
      folder: folder.path,
      label,
      missingFolders: folder.missing,
      writes,
      removals,
      keeps,
      files: [...desired.values()].map((file) => file.name).sort(compare),
      recordSnapshot: JSON.stringify(record ?? null),
      nextRecord,
    });
  }

  async apply(plan: ProfileXsStagingPlan): Promise<ProfileXsStagingResult> {
    const state = await this.readState();
    const record = state.profiles[plan.key];
    if (JSON.stringify(record ?? null) !== plan.recordSnapshot) {
      throw new ProfileXsStagingError(
        'xs-profile-staging-failed',
        `AoE2RMSIDE's record of your profile's XS folder (${plan.label}) changed during the live test`,
      );
    }
    const recordChanged = JSON.stringify(plan.nextRecord) !== JSON.stringify(record ?? null);
    const result = (changed: boolean): ProfileXsStagingResult => ({
      files: [...plan.files],
      written: plan.writes.map((write) => write.name).sort(compare),
      removed: plan.removals.map((removal) => removal.name).sort(compare),
      changed,
    });
    if (plan.writes.length === 0 && plan.removals.length === 0) {
      await this.verifyKeeps(plan);
      if (recordChanged) await this.writeRecord(state, plan.key, plan.nextRecord);
      return result(recordChanged);
    }

    const createdFolders: string[] = [];
    const written: PlannedWrite[] = [];
    const removed: PlannedRemoval[] = [];
    let intentWritten = false;
    try {
      const folder = await inspectFolder(plan.target.profileRoot, plan.label);
      if (!samePath(folder.path, plan.folder)) {
        throw new Error('the XS folder moved during the live test');
      }
      let parent = join(
        plan.target.profileRoot,
        ...xsFolderParts.slice(0, xsFolderParts.length - folder.missing.length),
      );
      for (const part of folder.missing) {
        parent = join(parent, part);
        await mkdir(parent);
        createdFolders.push(parent);
      }
      const interrupted: Record<string, string[]> = { ...(record?.interrupted ?? {}) };
      const accept = (name: string, ...hashes: string[]) => {
        const existing = Object.entries(interrupted).find(
          ([candidate]) => nameKey(candidate) === nameKey(name),
        );
        const merged = new Set([...(existing?.[1] ?? []), ...hashes]);
        if (existing) delete interrupted[existing[0]];
        interrupted[name] = [...merged].sort(compare);
      };
      for (const write of plan.writes) {
        accept(write.name, write.hash, ...(write.previous ? [write.previous.hash] : []));
      }
      for (const removal of plan.removals) accept(removal.name, removal.hash);
      await this.writeRecord(state, plan.key, {
        profileId: plan.target.profileId,
        files: record?.files ?? {},
        interrupted: sortedRecord(interrupted),
      });
      intentWritten = true;

      for (const removal of plan.removals) {
        const current = await onDisk(removal.path);
        if (current.kind !== 'file' || current.hash !== removal.hash) {
          throw new Error(`${removal.name} changed during the live test`);
        }
        await this.operations.removeFile(removal.path);
        removed.push(removal);
      }
      for (const write of plan.writes) {
        const current = await onDisk(write.path);
        if (write.previous === null && current.kind !== 'missing') {
          throw notOwned(write.name, plan.label);
        }
        if (
          write.previous !== null &&
          (current.kind !== 'file' || current.hash !== write.previous.hash)
        ) {
          throw changedSinceCopied(write.name, plan.label);
        }
        await this.operations.replaceFile(write.path, write.bytes);
        written.push(write);
      }
      await this.verifyKeeps(plan);
      await this.writeRecord(await this.readState(), plan.key, plan.nextRecord);
      return result(true);
    } catch (error) {
      const restored = await this.rollback(written, removed, createdFolders);
      if (restored && intentWritten) {
        try {
          await this.writeRecord(await this.readState(), plan.key, record ?? null);
        } catch {}
      }
      if (error instanceof ProfileXsStagingError) throw error;
      throw new ProfileXsStagingError(
        'xs-profile-staging-failed',
        `XS files could not be copied to your profile's XS folder (${plan.label}): ${failureReason(error)}; ${
          restored
            ? 'every file this live test changed there was restored'
            : 'some files this live test changed there could not be restored'
        }`,
      );
    }
  }

  private async verifyKeeps(plan: ProfileXsStagingPlan): Promise<void> {
    for (const keep of plan.keeps) {
      const current = await onDisk(keep.path);
      if (current.kind !== 'file' || current.hash !== keep.hash) {
        throw new ProfileXsStagingError(
          'xs-profile-file-changed',
          `XS file ${keep.name} in your profile's XS folder (${plan.label}) changed during the live test`,
        );
      }
    }
  }

  private async rollback(
    written: readonly PlannedWrite[],
    removed: readonly PlannedRemoval[],
    createdFolders: readonly string[],
  ): Promise<boolean> {
    let complete = true;
    for (const write of [...written].reverse()) {
      try {
        const current = await onDisk(write.path);
        if (current.kind === 'file' && current.hash !== write.hash) {
          complete = false;
        } else if (write.previous) {
          await this.operations.replaceFile(write.path, write.previous.bytes);
        } else if (current.kind === 'file') {
          await this.operations.removeFile(write.path);
        }
      } catch {
        complete = false;
      }
    }
    for (const removal of [...removed].reverse()) {
      try {
        if ((await onDisk(removal.path)).kind !== 'missing') complete = false;
        else await this.operations.replaceFile(removal.path, removal.bytes);
      } catch {
        complete = false;
      }
    }
    for (const folder of [...createdFolders].reverse()) {
      await rmdir(folder).catch(() => undefined);
    }
    return complete;
  }

  private async readState(): Promise<StagingState> {
    let bytes: Buffer;
    try {
      bytes = await readFileBounded(this.statePath, maximumStateBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: '1.0.0', compatibility: { readerMajor: 1 }, profiles: {} };
      }
      throw invalidRecord();
    }
    try {
      return validateProfileXsStagingState(JSON.parse(bytes.toString('utf8')));
    } catch {
      throw invalidRecord();
    }
  }

  private async writeRecord(
    state: StagingState,
    key: string,
    record: ProfileRecord | null,
  ): Promise<void> {
    const profiles = { ...state.profiles };
    if (record) profiles[key] = record;
    else delete profiles[key];
    if (Object.keys(profiles).length > maximumProfiles) {
      throw new Error('too many profiles have staged XS files');
    }
    const next: StagingState = {
      schemaVersion: '1.0.0',
      compatibility: { readerMajor: 1 },
      profiles: Object.fromEntries(
        Object.entries(profiles).sort(([left], [right]) => compare(left, right)),
      ),
    };
    await atomicReplaceFile(this.statePath, Buffer.from(`${JSON.stringify(next, null, 2)}\n`));
  }
}

export function validateProfileXsStagingState(value: unknown): StagingState {
  if (
    !isRecord(value) ||
    value.schemaVersion !== '1.0.0' ||
    !isRecord(value.compatibility) ||
    value.compatibility.readerMajor !== 1 ||
    !isRecord(value.profiles) ||
    Object.keys(value.profiles).length > maximumProfiles
  ) {
    throw new Error('profile XS staging state is invalid');
  }
  const profiles: Record<string, ProfileRecord> = {};
  for (const [key, record] of Object.entries(value.profiles)) {
    if (
      !/^[a-f0-9]{64}$/u.test(key) ||
      !isRecord(record) ||
      typeof record.profileId !== 'string' ||
      !/^[0-9]{3,20}$/u.test(record.profileId) ||
      !isRecord(record.files)
    ) {
      throw new Error('profile XS staging record is invalid');
    }
    const files = validateNames(record.files, (hash) => validHash(hash));
    const interrupted =
      record.interrupted === undefined
        ? undefined
        : isRecord(record.interrupted)
          ? validateNames(
              record.interrupted,
              (hashes) =>
                Array.isArray(hashes) &&
                hashes.length >= 1 &&
                hashes.length <= 8 &&
                hashes.every(validHash),
            )
          : null;
    if (interrupted === null) throw new Error('profile XS staging record is invalid');
    profiles[key] = {
      profileId: record.profileId,
      files: files as Record<string, string>,
      ...(interrupted ? { interrupted: interrupted as Record<string, string[]> } : {}),
    };
  }
  return { schemaVersion: '1.0.0', compatibility: { readerMajor: 1 }, profiles };
}

function validateNames(
  value: Record<string, unknown>,
  validValue: (entry: unknown) => boolean,
): Record<string, unknown> {
  const entries = Object.entries(value);
  const keys = new Set(entries.map(([name]) => nameKey(name)));
  if (
    entries.length > maximumStagedFiles ||
    keys.size !== entries.length ||
    entries.some(([name, entry]) => !isPlainXsName(name) || !validValue(entry))
  ) {
    throw new Error('profile XS staging record is invalid');
  }
  return Object.fromEntries(
    entries.map(([name, entry]) => [name, Array.isArray(entry) ? [...entry] : entry]),
  );
}

export function isPlainXsName(name: string): boolean {
  return (
    typeof name === 'string' &&
    isSafeWindowsPathPart(name) &&
    extname(name).toLocaleLowerCase('en-US') === '.xs' &&
    basename(name, extname(name)).length > 0
  );
}

export function folderLabel(profileRoot: string): string {
  return [basename(dirname(profileRoot)), basename(profileRoot), ...xsFolderParts]
    .filter(Boolean)
    .join('\\');
}

function profileKey(target: ProfileXsStagingTarget): string {
  return createHash('sha256')
    .update(`profile-xs-staging-v1\0${pathKey(target.profileRoot)}\0${target.profileId}`)
    .digest('hex');
}

function ownedHashes(
  record: ProfileRecord | undefined,
): Map<string, { name: string; hashes: Set<string> }> {
  const owned = new Map<string, { name: string; hashes: Set<string> }>();
  const add = (name: string, hashes: readonly string[]) => {
    const key = nameKey(name);
    const existing = owned.get(key);
    if (existing) for (const hash of hashes) existing.hashes.add(hash);
    else owned.set(key, { name, hashes: new Set(hashes) });
  };
  for (const [name, hash] of Object.entries(record?.files ?? {})) add(name, [hash]);
  for (const [name, hashes] of Object.entries(record?.interrupted ?? {})) add(name, hashes);
  return owned;
}

const missing: OnDisk = { kind: 'missing' };

async function onDisk(path: string): Promise<OnDisk> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missing;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) return { kind: 'other' };
  try {
    const bytes = await readFileBounded(path, maximumXsFileBytes);
    return { kind: 'file', hash: hashBytes(bytes), bytes };
  } catch (error) {
    if (error instanceof FileTooLargeError) return { kind: 'other' };
    throw error;
  }
}

async function inspectFolder(
  profileRoot: string,
  label: string,
): Promise<{ path: string; missing: string[] }> {
  const unsafe = () =>
    new ProfileXsStagingError(
      'xs-profile-folder-unsafe',
      `Your profile's XS folder (${label}) is not a regular folder or points to another place`,
    );
  const root = await realpath(profileRoot).catch(() => {
    throw unsafe();
  });
  if (!samePath(root, profileRoot)) throw unsafe();
  let current = root;
  for (const [index, part] of xsFolderParts.entries()) {
    const next = join(current, part);
    let metadata;
    try {
      metadata = await lstat(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {
        path: join(next, ...xsFolderParts.slice(index + 1)),
        missing: [...xsFolderParts.slice(index)],
      };
    }
    const canonical =
      metadata.isDirectory() && !metadata.isSymbolicLink() ? await realpath(next) : null;
    if (!canonical || !samePath(canonical, next) || !isInside(canonical, root)) throw unsafe();
    current = canonical;
  }
  return { path: current, missing: [] };
}

function validateTarget(target: ProfileXsStagingTarget): void {
  if (
    !target ||
    typeof target.profileRoot !== 'string' ||
    !isAbsolute(target.profileRoot) ||
    typeof target.profileId !== 'string' ||
    !/^[0-9]{3,20}$/u.test(target.profileId)
  ) {
    throw new Error('managed deployment requires an explicitly selected numeric profile');
  }
}

function notOwned(name: string, label: string): ProfileXsStagingError {
  return new ProfileXsStagingError(
    'xs-profile-file-not-owned',
    `XS file ${name} already exists in your profile's XS folder (${label}) and was not created by AoE2RMSIDE`,
  );
}

function changedSinceCopied(name: string, label: string): ProfileXsStagingError {
  return new ProfileXsStagingError(
    'xs-profile-file-changed',
    `XS file ${name} in your profile's XS folder (${label}) was changed after AoE2RMSIDE copied it there`,
  );
}

function invalidRecord(): ProfileXsStagingError {
  return new ProfileXsStagingError(
    'xs-profile-record-invalid',
    "AoE2RMSIDE's record of XS files copied to your profile is invalid",
  );
}

function failureReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,32}$/u.test(code)) return code;
  const message = error instanceof Error ? error.message : '';
  return /^[^\\/:]{1,120}$/u.test(message) ? message : 'the file system refused a change';
}

function safeName(name: unknown): string {
  return typeof name === 'string'
    ? name.replace(/[\u0000-\u001f]/gu, '?').slice(0, 120)
    : 'with an invalid name';
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => compare(left, right)));
}

function nameKey(name: string): string {
  return name.toLocaleLowerCase('en-US');
}

function pathKey(path: string): string {
  return resolve(path).replaceAll('\\', '/').toLocaleLowerCase('en-US');
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function isInside(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
