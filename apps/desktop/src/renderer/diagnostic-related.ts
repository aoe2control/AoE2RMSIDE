import { isLspRangeValue, type LspRangeValue } from './editor-answers';
import { validIncludeTarget } from './include-navigation';

export const maximumRelatedLocations = 8;
export const maximumRelatedMessageLength = 512;

export interface RelatedLocation {
  uri: string;
  range: LspRangeValue;
  message: string;
}

function validRange(range: unknown): range is LspRangeValue {
  if (!isLspRangeValue(range)) return false;
  const values = [range.start.line, range.start.character, range.end.line, range.end.character];
  return (
    values.every((value) => Number.isInteger(value) && value >= 0) &&
    (range.start.line < range.end.line ||
      (range.start.line === range.end.line && range.start.character <= range.end.character))
  );
}

export function relatedLocationsFromLsp(
  diagnostic: unknown,
  documentUri: string,
): RelatedLocation[] {
  const related = (diagnostic as { relatedInformation?: unknown } | null)?.relatedInformation;
  if (!Array.isArray(related)) return [];
  const locations: RelatedLocation[] = [];
  for (const entry of related) {
    if (locations.length >= maximumRelatedLocations) break;
    const value = entry as {
      location?: { uri?: unknown; range?: unknown } | null;
      message?: unknown;
    } | null;
    const uri = value?.location?.uri;
    const range = value?.location?.range;
    const message = value?.message;
    if (
      typeof uri !== 'string' ||
      !(uri === documentUri || validIncludeTarget(uri)) ||
      !validRange(range) ||
      typeof message !== 'string' ||
      message.length === 0
    ) {
      continue;
    }
    locations.push({
      uri,
      range: {
        start: { line: range.start.line, character: range.start.character },
        end: { line: range.end.line, character: range.end.character },
      },
      message:
        message.length > maximumRelatedMessageLength
          ? `${message.slice(0, maximumRelatedMessageLength - 1)}…`
          : message,
    });
  }
  return locations;
}
