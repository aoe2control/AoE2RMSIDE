export const snippetFileFormat = 'aoe2rmside-snippets';
export const snippetFileVersion = 1;

export const snippetSections = [
  'player_setup',
  'land_generation',
  'elevation_generation',
  'cliff_generation',
  'terrain_generation',
  'connection_generation',
  'objects_generation',
] as const;
export type SnippetSection = (typeof snippetSections)[number];
export const anySnippetSection = 'any';
export type OwnSnippetSection = SnippetSection | typeof anySnippetSection;

export interface OwnSnippet {
  name: string;
  section: OwnSnippetSection;
  description: string;
  body: string;
}

export const ownSnippetLimits = Object.freeze({
  snippets: 500,
  name: 80,
  description: 200,
  body: 20_000,
  fileBytes: 2 * 1024 * 1024,
});

export class SnippetFileError extends Error {
  constructor(
    readonly reason: 'format' | 'version' | 'invalid' | 'too-many' | 'too-large' | 'duplicate-name',
    message: string,
  ) {
    super(message);
    this.name = 'SnippetFileError';
  }
}

export function isOwnSnippetSection(value: unknown): value is OwnSnippetSection {
  return (
    value === anySnippetSection ||
    (typeof value === 'string' && (snippetSections as readonly string[]).includes(value))
  );
}

// eslint-disable-next-line no-control-regex
const controlCharacters = /[\u0000-\u001f\u007f\u2028\u2029]/u;
// eslint-disable-next-line no-control-regex
const bodyControlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export function ownSnippetNameProblem(
  name: string,
  others: readonly OwnSnippet[],
  previousName: string | null = null,
): 'required' | 'too-long' | 'invalid' | 'taken' | null {
  const trimmed = name.trim();
  if (!trimmed) return 'required';
  if (trimmed.length > ownSnippetLimits.name) return 'too-long';
  if (controlCharacters.test(trimmed)) return 'invalid';
  const key = snippetNameKey(trimmed);
  const previous = previousName === null ? null : snippetNameKey(previousName);
  if (others.some((other) => snippetNameKey(other.name) === key && key !== previous)) {
    return 'taken';
  }
  return null;
}

export function snippetNameKey(name: string): string {
  return name.trim().toLocaleLowerCase('en');
}

export function normalizeSnippetBody(body: string): string {
  return body.replace(/\r\n?/gu, '\n');
}

export function validateOwnSnippet(value: unknown): OwnSnippet {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SnippetFileError('invalid', 'a snippet must be an object');
  }
  const record = value as Record<string, unknown>;
  const { name, section, description, body } = record;
  if (typeof name !== 'string' || typeof body !== 'string') {
    throw new SnippetFileError('invalid', 'a snippet needs a name and a body');
  }
  if (description !== undefined && typeof description !== 'string') {
    throw new SnippetFileError('invalid', 'a snippet description must be text');
  }
  if (!isOwnSnippetSection(section)) {
    throw new SnippetFileError('invalid', 'a snippet names an unknown section');
  }
  const trimmedName = name.trim();
  if (
    !trimmedName ||
    trimmedName.length > ownSnippetLimits.name ||
    controlCharacters.test(trimmedName)
  ) {
    throw new SnippetFileError('invalid', 'a snippet name is empty, too long, or not one line');
  }
  const trimmedDescription = (description ?? '').trim();
  if (
    trimmedDescription.length > ownSnippetLimits.description ||
    controlCharacters.test(trimmedDescription)
  ) {
    throw new SnippetFileError('invalid', 'a snippet description is too long or not one line');
  }
  const normalizedBody = normalizeSnippetBody(body);
  if (
    !normalizedBody.trim() ||
    normalizedBody.length > ownSnippetLimits.body ||
    bodyControlCharacters.test(normalizedBody)
  ) {
    throw new SnippetFileError(
      'invalid',
      'a snippet body is empty, too long, or holds control characters',
    );
  }
  return {
    name: trimmedName,
    section,
    description: trimmedDescription,
    body: normalizedBody,
  };
}

export function validateSnippetFile(value: unknown): OwnSnippet[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SnippetFileError('format', 'this is not an AoE2RMSIDE snippet file');
  }
  const record = value as Record<string, unknown>;
  if (record.format !== snippetFileFormat) {
    throw new SnippetFileError('format', 'this is not an AoE2RMSIDE snippet file');
  }
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 1) {
    throw new SnippetFileError('format', 'the snippet file has no valid version');
  }
  if (record.version !== snippetFileVersion) {
    throw new SnippetFileError(
      'version',
      `snippet file version ${String(record.version)} is not supported`,
    );
  }
  if (!Array.isArray(record.snippets)) {
    throw new SnippetFileError('invalid', 'the snippet file holds no snippet list');
  }
  if (record.snippets.length > ownSnippetLimits.snippets) {
    throw new SnippetFileError(
      'too-many',
      `a snippet file holds at most ${ownSnippetLimits.snippets} snippets`,
    );
  }
  const snippets = record.snippets.map(validateOwnSnippet);
  const names = new Set<string>();
  for (const snippet of snippets) {
    const key = snippetNameKey(snippet.name);
    if (names.has(key)) {
      throw new SnippetFileError('duplicate-name', 'two snippets in the file share one name');
    }
    names.add(key);
  }
  return snippets;
}

export function parseSnippetFile(input: Uint8Array | string): OwnSnippet[] {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > ownSnippetLimits.fileBytes) {
    throw new SnippetFileError('too-large', 'the snippet file is larger than 2 MiB');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SnippetFileError('format', 'this is not an AoE2RMSIDE snippet file');
  }
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/u, ''));
  } catch {
    throw new SnippetFileError('format', 'this is not an AoE2RMSIDE snippet file');
  }
  return validateSnippetFile(value);
}

export function serializeSnippetFile(snippets: readonly OwnSnippet[]): string {
  if (snippets.length > ownSnippetLimits.snippets) {
    throw new SnippetFileError(
      'too-many',
      `a snippet file holds at most ${ownSnippetLimits.snippets} snippets`,
    );
  }
  const text = `${JSON.stringify(
    {
      format: snippetFileFormat,
      version: snippetFileVersion,
      snippets: snippets.map(({ name, section, description, body }) => ({
        name,
        section,
        description,
        body,
      })),
    },
    null,
    2,
  )}\n`;
  if (new TextEncoder().encode(text).byteLength > ownSnippetLimits.fileBytes) {
    throw new SnippetFileError('too-large', 'the snippets are larger than 2 MiB together');
  }
  return text;
}

export function uniqueSnippetName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(snippetNameKey(name))) return name;
  for (let number = 2; ; number += 1) {
    const suffix = ` (${number})`;
    const base = name.slice(0, ownSnippetLimits.name - suffix.length).trimEnd();
    const candidate = `${base}${suffix}`;
    if (!taken.has(snippetNameKey(candidate))) return candidate;
  }
}

export function mergeImportedSnippets(
  existing: readonly OwnSnippet[],
  imported: readonly OwnSnippet[],
): OwnSnippet[] {
  if (existing.length + imported.length > ownSnippetLimits.snippets) {
    throw new SnippetFileError(
      'too-many',
      `you can keep at most ${ownSnippetLimits.snippets} snippets`,
    );
  }
  const taken = new Set(existing.map((snippet) => snippetNameKey(snippet.name)));
  const merged = [...existing];
  for (const snippet of imported) {
    const name = uniqueSnippetName(snippet.name, taken);
    taken.add(snippetNameKey(name));
    merged.push({ ...snippet, name });
  }
  serializeSnippetFile(merged);
  return merged;
}

export function saveOwnSnippet(
  snippets: readonly OwnSnippet[],
  snippet: OwnSnippet,
  previousName: string | null,
): OwnSnippet[] {
  const checked = validateOwnSnippet(snippet);
  const problem = ownSnippetNameProblem(checked.name, snippets, previousName);
  if (problem === 'taken') {
    throw new SnippetFileError('duplicate-name', 'another snippet has this name');
  }
  const previousKey = previousName === null ? null : snippetNameKey(previousName);
  const index =
    previousKey === null
      ? -1
      : snippets.findIndex((entry) => snippetNameKey(entry.name) === previousKey);
  if (previousKey !== null && index < 0) {
    throw new SnippetFileError('invalid', 'the snippet to change no longer exists');
  }
  const next = [...snippets];
  if (index >= 0) next[index] = checked;
  else next.push(checked);
  serializeSnippetFile(next);
  return next;
}

export function deleteOwnSnippet(snippets: readonly OwnSnippet[], name: string): OwnSnippet[] {
  const key = snippetNameKey(name);
  return snippets.filter((snippet) => snippetNameKey(snippet.name) !== key);
}
