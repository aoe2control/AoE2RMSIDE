import { randomUUID } from 'node:crypto';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ModStatusFailureReason } from '../shared/api';
import { FileTooLargeError, readFileBounded } from './bounded-file';

export const modStatusFileName = 'mod-status.json';
export const maximumModStatusBytes = 4 * 1024 * 1024;
const maximumNesting = 64;

export type ModStatusChange = 'enabled' | 'already-enabled' | 'added';

export type ModStatusRefusal = ModStatusFailureReason;

export class ModStatusRefusedError extends Error {
  constructor(
    readonly reason: ModStatusRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'ModStatusRefusedError';
  }
}

export interface LocalModIdentity {
  directoryName: string;
  title: string;
}

export interface ModStatusPlan {
  change: ModStatusChange;
  text: string | null;
}

export function localModStatusPath(directoryName: string): string {
  return `local//${directoryName}`;
}

export function localModStatusEntry(mod: LocalModIdentity, priority: number): string {
  return (
    `{"CheckSum":"0","Enabled":true,"LastUpdate":"0",` +
    `"Path":${JSON.stringify(localModStatusPath(mod.directoryName))},` +
    `"Priority":${priority},"PublishID":0,"Title":${JSON.stringify(mod.title)},"WorkshopID":0}`
  );
}

export function planLocalModEnable(original: string | null, mod: LocalModIdentity): ModStatusPlan {
  if (original === null) {
    const text = `{"Mods":[${localModStatusEntry(mod, 1)}],"Unsub":[]}`;
    verifyEnabled(text, mod);
    return { change: 'added', text };
  }
  const list = modList(original);
  const matches = matchingEntries(list.items, mod);
  if (matches.length > 1) {
    throw new ModStatusRefusedError(
      'duplicate-entry',
      `the game's mod list names ${localModStatusPath(mod.directoryName)} more than once`,
    );
  }
  let text: string;
  let change: ModStatusChange;
  if (matches.length === 1) {
    const enabled = member(matches[0]!, 'Enabled');
    if (!enabled || (enabled.kind !== 'true' && enabled.kind !== 'false')) {
      throw new ModStatusRefusedError(
        'unexpected-entry',
        `the game's mod list entry for ${localModStatusPath(mod.directoryName)} has no true or false "Enabled"`,
      );
    }
    if (enabled.kind === 'true') return { change: 'already-enabled', text: null };
    text = `${original.slice(0, enabled.start)}true${original.slice(enabled.end)}`;
    change = 'enabled';
  } else {
    const priority = nextPriority(list.items);
    const entry = localModStatusEntry(mod, priority);
    const last = list.items.at(-1);
    text = last
      ? `${original.slice(0, last.end)},${entry}${original.slice(last.end)}`
      : `${original.slice(0, list.array.start + 1)}${entry}${original.slice(list.array.start + 1)}`;
    change = 'added';
  }
  verifyEnabled(text, mod);
  return { change, text };
}

export function decodeModStatus(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ModStatusRefusedError('malformed', "the game's mod list is not UTF-8 text");
  }
  if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) {
    throw new ModStatusRefusedError('malformed', "the game's mod list is not UTF-8 text");
  }
  return text;
}

export interface ModStatusTarget extends LocalModIdentity {
  profileRoot: string;
}

export interface ModStatusHooks {
  beforeReplace?(): Promise<void>;
  afterReplace?(): Promise<void>;
}

export async function enableLocalModStatus(
  target: ModStatusTarget,
  hooks: ModStatusHooks = {},
): Promise<ModStatusChange> {
  const modsPath = await modsDirectory(target.profileRoot);
  const statusPath = join(modsPath, modStatusFileName);
  const original = await readModStatus(statusPath);
  const plan = planLocalModEnable(original === null ? null : decodeModStatus(original), target);
  if (plan.text === null) return plan.change;
  const bytes = Buffer.from(plan.text, 'utf8');
  if (bytes.byteLength > maximumModStatusBytes) {
    throw new ModStatusRefusedError('malformed', "the game's mod list would grow too large");
  }
  const id = randomUUID();
  const temporary = join(modsPath, `.${modStatusFileName}.aoe2rmside-${id}.new`);
  const backup = join(modsPath, `.${modStatusFileName}.aoe2rmside-${id}.backup`);
  let backupWritten = false;
  let keepBackup = false;
  let replaced = false;
  try {
    try {
      await writeSynced(temporary, bytes);
      if (original !== null) {
        await writeSynced(backup, original);
        backupWritten = true;
      }
    } catch (error) {
      throw new ModStatusRefusedError(
        'write-failed',
        `the game's mod list could not be prepared: ${errorText(error)}`,
      );
    }
    await hooks.beforeReplace?.();
    if (!sameBytes(await readModStatus(statusPath), original)) {
      throw new ModStatusRefusedError(
        'changed',
        "the game's mod list changed while it was being updated",
      );
    }
    try {
      await rename(temporary, statusPath);
    } catch (error) {
      throw new ModStatusRefusedError(
        'write-failed',
        `the game's mod list could not be replaced: ${errorText(error)}`,
      );
    }
    replaced = true;
    await hooks.afterReplace?.();
    if (!sameBytes(await readModStatus(statusPath), bytes)) {
      throw new ModStatusRefusedError(
        'changed',
        "the game's mod list changed right after it was updated",
      );
    }
    return plan.change;
  } catch (error) {
    if (
      replaced &&
      (await restoreOriginal(statusPath, bytes, original, backup)) === 'kept-backup'
    ) {
      keepBackup = true;
      throw new ModStatusRefusedError(
        'write-failed',
        `${errorText(error)}; the original mod list is kept as ${backup}`,
      );
    }
    if (error instanceof ModStatusRefusedError) throw error;
    throw new ModStatusRefusedError('write-failed', errorText(error));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (backupWritten && !keepBackup) await rm(backup, { force: true }).catch(() => undefined);
  }
}

async function restoreOriginal(
  statusPath: string,
  written: Buffer,
  original: Buffer | null,
  backup: string,
): Promise<'restored' | 'left' | 'kept-backup'> {
  let current: Buffer | null;
  try {
    current = await readModStatus(statusPath);
  } catch {
    return original === null ? 'left' : 'kept-backup';
  }
  if (!sameBytes(current, written)) return 'left';
  try {
    if (original === null) await rm(statusPath, { force: true });
    else await rename(backup, statusPath);
    return 'restored';
  } catch {
    return original === null ? 'left' : 'kept-backup';
  }
}

async function modsDirectory(profileRoot: string): Promise<string> {
  let root: string;
  try {
    root = await realpath(profileRoot);
  } catch (error) {
    throw new ModStatusRefusedError(
      'unsafe-path',
      `the profile folder is unavailable: ${errorText(error)}`,
    );
  }
  const mods = join(root, 'mods');
  let metadata;
  try {
    metadata = await lstat(mods);
  } catch (error) {
    throw new ModStatusRefusedError(
      'unsafe-path',
      `the profile's mods folder is unavailable: ${errorText(error)}`,
    );
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ModStatusRefusedError(
      'unsafe-path',
      "the profile's mods folder is not a plain folder",
    );
  }
  const canonical = await realpath(mods);
  if (pathKey(canonical) !== pathKey(mods) || !isInside(canonical, root)) {
    throw new ModStatusRefusedError('unsafe-path', "the profile's mods folder is redirected");
  }
  return canonical;
}

async function readModStatus(path: string): Promise<Buffer | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ModStatusRefusedError(
      'write-failed',
      `the game's mod list could not be read: ${errorText(error)}`,
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ModStatusRefusedError('unsafe-path', "the game's mod list is not a plain file");
  }
  try {
    return await readFileBounded(path, maximumModStatusBytes);
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      throw new ModStatusRefusedError('malformed', "the game's mod list is too large");
    }
    throw new ModStatusRefusedError(
      'write-failed',
      `the game's mod list could not be read: ${errorText(error)}`,
    );
  }
}

async function writeSynced(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathKey(path: string): string {
  return resolve(path).replaceAll('\\', '/').toLocaleLowerCase('en-US');
}

function isInside(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

type JsonValue =
  | { kind: 'object'; start: number; end: number; members: JsonMember[] }
  | { kind: 'array'; start: number; end: number; items: JsonValue[] }
  | { kind: 'string'; start: number; end: number; value: string }
  | { kind: 'number'; start: number; end: number; raw: string }
  | { kind: 'true' | 'false' | 'null'; start: number; end: number };

interface JsonMember {
  key: string;
  value: JsonValue;
}

type JsonObject = Extract<JsonValue, { kind: 'object' }>;
type JsonArray = Extract<JsonValue, { kind: 'array' }>;

function modList(text: string): { array: JsonArray; items: JsonObject[] } {
  const root = parseJson(text);
  if (root.kind !== 'object') {
    throw new ModStatusRefusedError('unexpected-layout', "the game's mod list is not an object");
  }
  const mods = member(root, 'Mods');
  if (!mods || mods.kind !== 'array') {
    throw new ModStatusRefusedError('unexpected-layout', 'the game\'s mod list has no "Mods" list');
  }
  const items: JsonObject[] = [];
  for (const item of mods.items) {
    if (item.kind !== 'object') {
      throw new ModStatusRefusedError(
        'unexpected-layout',
        'the game\'s mod list has a "Mods" entry that is not an object',
      );
    }
    items.push(item);
  }
  return { array: mods, items };
}

function matchingEntries(items: readonly JsonObject[], mod: LocalModIdentity): JsonObject[] {
  const expected = modPathKey(localModStatusPath(mod.directoryName));
  return items.filter((item) => {
    const path = member(item, 'Path');
    return path?.kind === 'string' && modPathKey(path.value) === expected;
  });
}

function modPathKey(path: string): string {
  return path.replaceAll('\\', '/').toLocaleLowerCase('en-US');
}

function nextPriority(items: readonly JsonObject[]): number {
  let highest = items.length;
  for (const item of items) {
    const priority = member(item, 'Priority');
    if (priority?.kind !== 'number' || !/^-?(?:0|[1-9][0-9]*)$/u.test(priority.raw)) continue;
    const value = Number(priority.raw);
    if (Number.isSafeInteger(value) && value > highest) highest = value;
  }
  if (!Number.isSafeInteger(highest + 1)) {
    throw new ModStatusRefusedError(
      'unexpected-layout',
      "the game's mod list priorities are out of range",
    );
  }
  return highest + 1;
}

function member(object: JsonObject, key: string): JsonValue | undefined {
  return object.members.find((candidate) => candidate.key === key)?.value;
}

function verifyEnabled(text: string, mod: LocalModIdentity): void {
  const matches = matchingEntries(modList(text).items, mod);
  const enabled = matches.length === 1 ? member(matches[0]!, 'Enabled') : undefined;
  if (enabled?.kind !== 'true') {
    throw new ModStatusRefusedError('unexpected-layout', 'the mod list edit did not verify');
  }
}

function parseJson(text: string): JsonValue {
  const parser = new JsonParser(text);
  return parser.document();
}

class JsonParser {
  private index = 0;

  constructor(private readonly text: string) {}

  document(): JsonValue {
    if (this.text.charCodeAt(0) === 0xfeff) this.index = 1;
    this.whitespace();
    const value = this.value(0);
    this.whitespace();
    if (this.index !== this.text.length) this.fail('text after the value');
    return value;
  }

  private value(depth: number): JsonValue {
    if (depth > maximumNesting) this.fail('nesting is too deep');
    const character = this.text[this.index];
    if (character === '{') return this.object(depth);
    if (character === '[') return this.array(depth);
    if (character === '"') {
      const start = this.index;
      const value = this.string();
      return { kind: 'string', start, end: this.index, value };
    }
    if (character === '-' || (character !== undefined && character >= '0' && character <= '9')) {
      return this.number();
    }
    for (const literal of ['true', 'false', 'null'] as const) {
      if (this.text.startsWith(literal, this.index)) {
        const start = this.index;
        this.index += literal.length;
        return { kind: literal, start, end: this.index };
      }
    }
    return this.fail('a value was expected');
  }

  private object(depth: number): JsonObject {
    const start = this.index;
    this.index += 1;
    const members: JsonMember[] = [];
    const keys = new Set<string>();
    this.whitespace();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return { kind: 'object', start, end: this.index, members };
    }
    for (;;) {
      this.whitespace();
      if (this.text[this.index] !== '"') this.fail('a key was expected');
      const key = this.string();
      if (keys.has(key)) {
        throw new ModStatusRefusedError(
          'unexpected-layout',
          `the game's mod list repeats the key "${key}"`,
        );
      }
      keys.add(key);
      this.whitespace();
      if (this.text[this.index] !== ':') this.fail('a colon was expected');
      this.index += 1;
      this.whitespace();
      members.push({ key, value: this.value(depth + 1) });
      this.whitespace();
      const next = this.text[this.index];
      this.index += 1;
      if (next === '}') return { kind: 'object', start, end: this.index, members };
      if (next !== ',') this.fail('a comma or closing brace was expected');
    }
  }

  private array(depth: number): JsonArray {
    const start = this.index;
    this.index += 1;
    const items: JsonValue[] = [];
    this.whitespace();
    if (this.text[this.index] === ']') {
      this.index += 1;
      return { kind: 'array', start, end: this.index, items };
    }
    for (;;) {
      this.whitespace();
      items.push(this.value(depth + 1));
      this.whitespace();
      const next = this.text[this.index];
      this.index += 1;
      if (next === ']') return { kind: 'array', start, end: this.index, items };
      if (next !== ',') this.fail('a comma or closing bracket was expected');
    }
  }

  private string(): string {
    this.index += 1;
    let value = '';
    for (;;) {
      const code = this.text.charCodeAt(this.index);
      if (Number.isNaN(code)) this.fail('a string is not closed');
      if (code < 0x20) this.fail('a string holds a control character');
      if (code === 0x22) {
        this.index += 1;
        return value;
      }
      if (code !== 0x5c) {
        value += this.text[this.index];
        this.index += 1;
        continue;
      }
      const escape = this.text[this.index + 1];
      const simple: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
      };
      if (escape !== undefined && escape in simple) {
        value += simple[escape];
        this.index += 2;
      } else if (escape === 'u') {
        const hex = this.text.slice(this.index + 2, this.index + 6);
        if (!/^[0-9A-Fa-f]{4}$/u.test(hex)) this.fail('a unicode escape is malformed');
        value += String.fromCharCode(Number.parseInt(hex, 16));
        this.index += 6;
      } else {
        this.fail('an escape is malformed');
      }
    }
  }

  private number(): JsonValue {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;
    match.lastIndex = this.index;
    const found = match.exec(this.text);
    if (!found) this.fail('a number is malformed');
    const start = this.index;
    this.index += found![0].length;
    return { kind: 'number', start, end: this.index, raw: found![0] };
  }

  private whitespace(): void {
    for (;;) {
      const character = this.text[this.index];
      if (character !== ' ' && character !== '\t' && character !== '\n' && character !== '\r') {
        return;
      }
      this.index += 1;
    }
  }

  private fail(reason: string): never {
    throw new ModStatusRefusedError(
      'malformed',
      `the game's mod list is not valid JSON (${reason} at character ${this.index + 1})`,
    );
  }
}
