import type { PreviewProvenanceOperation } from './api';

export interface RefusalLocation {
  readonly sourceId: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly line: number;
  readonly column: number;
  readonly includeChain: readonly string[];
}

const markerLead = ' [refusal-location ';

const maximumRecordLength = 1_200;
const maximumSourceIdLength = 4_096;
const maximumIncludeChain = 64;

function isCount(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum;
}

function isSourceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumSourceIdLength;
}

export function refusalLocation(value: unknown): RefusalLocation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { sourceId, byteStart, byteEnd, line, column, includeChain } = value as Record<
    string,
    unknown
  >;
  if (!isSourceId(sourceId)) return null;
  if (!isCount(byteStart, 0) || !isCount(byteEnd, 0) || byteEnd < byteStart) return null;
  if (!isCount(line, 1) || !isCount(column, 1)) return null;
  if (!Array.isArray(includeChain) || includeChain.length > maximumIncludeChain) return null;
  if (!includeChain.every(isSourceId)) return null;
  return {
    sourceId,
    byteStart,
    byteEnd,
    line,
    column,
    includeChain: [...(includeChain as string[])],
  };
}

export function withRefusalLocationMarker(text: string, location: RefusalLocation): string {
  const record = (includeChain: readonly string[]) =>
    JSON.stringify({
      sourceId: location.sourceId,
      byteStart: location.byteStart,
      byteEnd: location.byteEnd,
      line: location.line,
      column: location.column,
      includeChain,
    });
  let json = record(location.includeChain);
  if (json.length > maximumRecordLength) json = record([location.sourceId]);
  if (json.length > maximumRecordLength) return text;
  return `${text}${markerLead}${json}]`;
}

function splitMarker(raw: string): { text: string; location: RefusalLocation | null } {
  const index = raw.lastIndexOf(markerLead);
  if (index < 0) return { text: raw, location: null };
  const rest = raw.slice(index + markerLead.length);
  for (let end = rest.indexOf('}]'); end >= 0; end = rest.indexOf('}]', end + 1)) {
    const tail = rest.slice(end + 2);
    if (tail && !tail.startsWith(knownCrashLead) && !desktopSuffixPattern.test(tail)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rest.slice(0, end + 1));
    } catch {
      continue;
    }
    return { text: `${raw.slice(0, index)}${tail}`, location: refusalLocation(parsed) };
  }
  return rest.startsWith('{"sourceId":')
    ? { text: raw.slice(0, index), location: null }
    : { text: raw, location: null };
}

const knownCrashLead = ' [known-crash ';

const desktopSuffixPattern = /^\s\([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+(?: \{.*\})?\)$/su;

export function refusalLocationFromText(raw: string | null | undefined): RefusalLocation | null {
  return raw ? splitMarker(raw).location : null;
}

export function withoutRefusalLocationMarker(raw: string): string {
  return splitMarker(raw).text;
}

export function refusalOperation(
  code: string,
  location: RefusalLocation,
): PreviewProvenanceOperation {
  return {
    sourceId: location.sourceId,
    byteStart: location.byteStart,
    byteEnd: location.byteEnd,
    operationIdentity: '',
    includeChain: [...location.includeChain],
    displayName: code,
  };
}
