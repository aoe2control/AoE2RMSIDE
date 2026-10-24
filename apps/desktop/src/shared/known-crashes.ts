import type { MessageId } from './i18n/translator';
import { wordOutputText, type OutputText } from './output-message';

export type KnownCrashEvidence = 'live' | 'static' | 'inferred';

export interface KnownCrashReference {
  readonly crashId: string;
  readonly evidence: KnownCrashEvidence;
  readonly arguments: Readonly<Record<string, string>>;
}

interface KnownCrashCatalogueEntry {
  readonly quality: KnownCrashEvidence;
  readonly title: MessageId;
  readonly cause: MessageId;
  readonly fix: MessageId | null;
  readonly placeholders: readonly string[];
}

const definedName = ['command', 'word'] as const;

export const knownCrashCatalogue: Readonly<Record<string, KnownCrashCatalogueEntry>> =
  Object.freeze({
    'actor-radius-search-too-small': {
      quality: 'live',
      title: 'known-crash.actor-radius-search-too-small.title',
      cause: 'known-crash.actor-radius-search-too-small.cause',
      fix: 'known-crash.actor-radius-search-too-small.fix',
      placeholders: [],
    },
    'connection-block-missing-terrain': {
      quality: 'live',
      title: 'known-crash.connection-block-missing-terrain.title',
      cause: 'known-crash.connection-block-missing-terrain.cause',
      fix: 'known-crash.connection-block-missing-terrain.fix',
      placeholders: ['word'],
    },
    'connection-to-land-outside-map': {
      quality: 'static',
      title: 'known-crash.connection-to-land-outside-map.title',
      cause: 'known-crash.connection-to-land-outside-map.cause',
      fix: 'known-crash.connection-to-land-outside-map.fix',
      placeholders: [],
    },
    'defined-name-runs-as-cliff-type': {
      quality: 'static',
      title: 'known-crash.defined-name-runs-as-cliff-type.title',
      cause: 'known-crash.defined-name-runs-as-cliff-type.cause',
      fix: 'known-crash.defined-name-runs-as-cliff-type.fix',
      placeholders: definedName,
    },
    'defined-name-runs-as-elevation-terrain': {
      quality: 'static',
      title: 'known-crash.defined-name-runs-as-elevation-terrain.title',
      cause: 'known-crash.defined-name-runs-as-elevation-terrain.cause',
      fix: 'known-crash.defined-name-runs-as-elevation-terrain.fix',
      placeholders: definedName,
    },
    'defined-name-runs-as-global-command': {
      quality: 'static',
      title: 'known-crash.defined-name-runs-as-global-command.title',
      cause: 'known-crash.defined-name-runs-as-global-command.cause',
      fix: 'known-crash.defined-name-runs-as-global-command.fix',
      placeholders: definedName,
    },
    'defined-name-runs-as-guard-state': {
      quality: 'static',
      title: 'known-crash.defined-name-runs-as-guard-state.title',
      cause: 'known-crash.defined-name-runs-as-guard-state.cause',
      fix: 'known-crash.defined-name-runs-as-guard-state.fix',
      placeholders: definedName,
    },
    'defined-name-runs-as-land-base-terrain': {
      quality: 'static',
      title: 'known-crash.defined-name-runs-as-land-base-terrain.title',
      cause: 'known-crash.defined-name-runs-as-land-base-terrain.cause',
      fix: 'known-crash.defined-name-runs-as-land-base-terrain.fix',
      placeholders: definedName,
    },
    'defined-name-runs-as-land-terrain': {
      quality: 'static',
      title: 'known-crash.defined-name-runs-as-land-terrain.title',
      cause: 'known-crash.defined-name-runs-as-land-terrain.cause',
      fix: 'known-crash.defined-name-runs-as-land-terrain.fix',
      placeholders: definedName,
    },
    'defined-name-runs-as-object-terrain': {
      quality: 'static',
      title: 'known-crash.defined-name-runs-as-object-terrain.title',
      cause: 'known-crash.defined-name-runs-as-object-terrain.cause',
      fix: 'known-crash.defined-name-runs-as-object-terrain.fix',
      placeholders: definedName,
    },
    'defined-name-runs-as-terrain-command': {
      quality: 'static',
      title: 'known-crash.defined-name-runs-as-terrain-command.title',
      cause: 'known-crash.defined-name-runs-as-terrain-command.cause',
      fix: 'known-crash.defined-name-runs-as-terrain-command.fix',
      placeholders: definedName,
    },
    'grouped-placement-zero-perimeter': {
      quality: 'inferred',
      title: 'known-crash.grouped-placement-zero-perimeter.title',
      cause: 'known-crash.grouped-placement-zero-perimeter.cause',
      fix: null,
      placeholders: [],
    },
    'object-group-entry-without-object': {
      quality: 'inferred',
      title: 'known-crash.object-group-entry-without-object.title',
      cause: 'known-crash.object-group-entry-without-object.cause',
      fix: 'known-crash.object-group-entry-without-object.fix',
      placeholders: [],
    },
    'object-on-land-outside-map': {
      quality: 'live',
      title: 'known-crash.object-on-land-outside-map.title',
      cause: 'known-crash.object-on-land-outside-map.cause',
      fix: 'known-crash.object-on-land-outside-map.fix',
      placeholders: [],
    },
    'override-map-size-shrinks-after-lands': {
      quality: 'live',
      title: 'known-crash.override-map-size-shrinks-after-lands.title',
      cause: 'known-crash.override-map-size-shrinks-after-lands.cause',
      fix: 'known-crash.override-map-size-shrinks-after-lands.fix',
      placeholders: [],
    },
    'terrain-without-movement-data': {
      quality: 'live',
      title: 'known-crash.terrain-without-movement-data.title',
      cause: 'known-crash.terrain-without-movement-data.cause',
      fix: 'known-crash.terrain-without-movement-data.fix',
      placeholders: ['terrain'],
    },
  } satisfies Record<string, KnownCrashCatalogueEntry>);

const crashIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const argumentNamePattern = /^[a-z][A-Za-z0-9]{0,31}$/u;
const maximumCrashIdBytes = 64;
const maximumKnownCrashArguments = 4;
const maximumArgumentValueBytes = 256;

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function knownCrashEvidence(value: unknown): KnownCrashEvidence {
  return value === 'live' || value === 'static' ? value : 'inferred';
}

export function knownCrashReference(value: unknown): KnownCrashReference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const crashId = candidate.crashId;
  if (
    typeof crashId !== 'string' ||
    !crashIdPattern.test(crashId) ||
    utf8Length(crashId) > maximumCrashIdBytes
  ) {
    return null;
  }
  const raw = candidate.arguments;
  let entries: [unknown, unknown][];
  if (raw === undefined || raw === null) entries = [];
  else if (Array.isArray(raw)) {
    entries = raw.map((entry: unknown) =>
      entry && typeof entry === 'object'
        ? [(entry as Record<string, unknown>).name, (entry as Record<string, unknown>).value]
        : [undefined, undefined],
    );
  } else if (typeof raw === 'object') entries = Object.entries(raw as Record<string, unknown>);
  else return null;
  if (entries.length > maximumKnownCrashArguments) return null;
  const args: Record<string, string> = {};
  for (const [name, argument] of entries) {
    if (
      typeof name !== 'string' ||
      !argumentNamePattern.test(name) ||
      Object.hasOwn(args, name) ||
      typeof argument !== 'string' ||
      utf8Length(argument) > maximumArgumentValueBytes
    ) {
      return null;
    }
    args[name] = argument;
  }
  const sorted = Object.fromEntries(
    Object.entries(args).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  return Object.freeze({
    crashId,
    evidence: knownCrashEvidence(candidate.evidence),
    arguments: Object.freeze(sorted),
  });
}

export function presentableKnownCrash(
  reference: KnownCrashReference | null | undefined,
): KnownCrashCatalogueEntry | null {
  if (!reference || reference.evidence === 'inferred') return null;
  const entry = Object.hasOwn(knownCrashCatalogue, reference.crashId)
    ? knownCrashCatalogue[reference.crashId]
    : undefined;
  if (!entry || entry.quality === 'inferred') return null;
  return entry.placeholders.every((name) => Object.hasOwn(reference.arguments, name))
    ? entry
    : null;
}

export interface KnownCrashText {
  crashId: string;
  cause: OutputText;
  fix: OutputText | null;
}

export function knownCrashText(reference: KnownCrashReference): KnownCrashText | null {
  const entry = presentableKnownCrash(reference);
  if (!entry) return null;
  return {
    crashId: reference.crashId,
    cause: { id: entry.cause, args: { ...reference.arguments } },
    fix: entry.fix ? { id: entry.fix } : null,
  };
}

export interface KnownCrashWords {
  crashId: string;
  cause: string;
  fix: string | null;
}

export function knownCrashWords(reference: KnownCrashReference): KnownCrashWords | null {
  const text = knownCrashText(reference);
  if (!text) return null;
  return {
    crashId: text.crashId,
    cause: wordOutputText(text.cause),
    fix: text.fix ? wordOutputText(text.fix) : null,
  };
}

export function knownCrashHeadlineText(code: string | null | undefined): OutputText {
  return { id: code === 'RMS4012' ? 'known-crash.headline.possible' : 'known-crash.headline' };
}

export function generationWarningCrashes(
  warnings: readonly { knownCrash?: unknown }[] | null | undefined,
): KnownCrashReference[] {
  const crashes: KnownCrashReference[] = [];
  const seen = new Set<string>();
  for (const warning of warnings ?? []) {
    const reference = knownCrashReference(warning.knownCrash);
    if (!reference || seen.has(reference.crashId) || !presentableKnownCrash(reference)) continue;
    seen.add(reference.crashId);
    crashes.push(reference);
  }
  return crashes;
}

export function knownCrashDetails(crashes: readonly KnownCrashReference[]): string {
  return crashes
    .map((crash) => knownCrashWords(crash))
    .filter((words): words is KnownCrashWords => words !== null)
    .map((words) => [words.cause, words.fix].filter(Boolean).join(' '))
    .join(' ');
}

const markerLead = ' [known-crash ';

export function withKnownCrashMarker(text: string, reference: KnownCrashReference): string {
  const record = {
    crashId: reference.crashId,
    evidence: reference.evidence,
    arguments: reference.arguments,
  };
  return `${text}${markerLead}${JSON.stringify(record)}]`;
}

function splitMarker(raw: string): { text: string; reference: KnownCrashReference | null } {
  const index = raw.lastIndexOf(markerLead);
  if (index < 0) return { text: raw, reference: null };
  const rest = raw.slice(index + markerLead.length);
  for (let end = rest.indexOf('}]'); end >= 0; end = rest.indexOf('}]', end + 1)) {
    const tail = rest.slice(end + 2);
    if (tail && !desktopSuffixPattern.test(tail)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rest.slice(0, end + 1));
    } catch {
      continue;
    }
    const reference = knownCrashReference(parsed);
    if (!reference) return { text: raw, reference: null };
    return { text: `${raw.slice(0, index)}${tail}`, reference };
  }
  return { text: raw, reference: null };
}

const desktopSuffixPattern = /^\s\([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+(?: \{.*\})?\)$/su;

export function knownCrashFromText(raw: string | null | undefined): KnownCrashReference | null {
  return raw ? splitMarker(raw).reference : null;
}

export function withoutKnownCrashMarker(raw: string): string {
  return splitMarker(raw).text;
}
