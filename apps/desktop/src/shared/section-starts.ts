export const rmsSectionNames = [
  'player_setup',
  'land_generation',
  'elevation_generation',
  'cliff_generation',
  'terrain_generation',
  'connection_generation',
  'objects_generation',
] as const;
export type RmsSectionName = (typeof rmsSectionNames)[number];

export const maximumSectionStarts = 16;

export interface PreviewSectionStart {
  section: RmsSectionName;
  operationIndex: number;
}

export function validSectionStarts(
  starts: readonly { section: string; firstOperationIndex: number }[],
  operationCount: number,
): PreviewSectionStart[] | undefined {
  if (starts.length > maximumSectionStarts) return undefined;
  const seen = new Set<string>();
  let previous = -1;
  const valid: PreviewSectionStart[] = [];
  for (const start of starts) {
    const index = start.firstOperationIndex;
    if (
      !(rmsSectionNames as readonly string[]).includes(start.section) ||
      seen.has(start.section) ||
      !Number.isSafeInteger(index) ||
      index <= previous ||
      index >= operationCount
    ) {
      return undefined;
    }
    seen.add(start.section);
    previous = index;
    valid.push({ section: start.section as RmsSectionName, operationIndex: index });
  }
  return valid;
}
