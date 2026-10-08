import { documentationPageUrl } from './external-links';

export const mapTestScriptExtension = '.rmstest' as const;

export const mapTestStarterTemplate = `# Map-test scripts (Python-like .rmstest scripts) can run RMS generations across multiple seeds, enabling validation of edge-cases or calculation of averages.
# Example
#
# def main():
#     target = rms.source()  # Uses the pinned RMS; or pass "maps/example.rms".
#     seeds = rms.seeds(start = 1, count = 16)
#
#     for sample in rms.generate(target, seeds, preview = True):
#         gold = sample.map.objects(object_ids = ["GOLD"], owner = 0)
#         sample.expect(
#             len(gold) >= 8,
#             message = "expected at least eight neutral gold objects",
#             values = {"actual": len(gold)},
#         )
#
# main()
#
# For more information, see the Map tests page of the documentation: ${documentationPageUrl('map-tests')}
`;

export const maximumMapTestMaps = 4096;

export const maximumMapTestWorkers = 32;

export const legacyMaximumMapTestWorkers = 4;

export type MapTestWorkerSetting = 'auto' | number;

export function isMapTestWorkerSetting(value: unknown): value is MapTestWorkerSetting {
  return (
    value === 'auto' ||
    (Number.isInteger(value) &&
      (value as number) >= 1 &&
      (value as number) <= maximumMapTestWorkers)
  );
}

export function mapTestWorkerMaximum(logicalProcessors: number): number {
  const offered = Number.isInteger(logicalProcessors) ? logicalProcessors : 1;
  return Math.max(1, Math.min(maximumMapTestWorkers, offered));
}

export function mapTestWorkerSettingFromDraft(
  draft: string,
  maximum: number,
): MapTestWorkerSetting | null {
  const trimmed = draft.trim();
  if (trimmed === '') return 'auto';
  if (!/^\d{1,6}$/u.test(trimmed)) return null;
  const value = Number(trimmed);
  if (value < 1) return null;
  return Math.min(value, Math.max(1, Math.min(maximumMapTestWorkers, maximum)));
}

export function mapTestWorkerDraft(setting: MapTestWorkerSetting): string {
  return setting === 'auto' ? '' : String(setting);
}

export function mapTestWorkerRequest(
  setting: MapTestWorkerSetting,
  automaticSupported: boolean,
  legacyAutomatic: number,
): { workers: number; automaticWorkers: boolean } {
  if (automaticSupported) {
    return setting === 'auto'
      ? { workers: 0, automaticWorkers: true }
      : { workers: setting, automaticWorkers: false };
  }
  const requested = setting === 'auto' ? legacyAutomatic : setting;
  const bounded = Number.isInteger(requested) ? requested : 1;
  return {
    workers: Math.max(1, Math.min(legacyMaximumMapTestWorkers, bounded)),
    automaticWorkers: false,
  };
}

export function isMapTestProgressCounts(completed: unknown, requested: unknown): boolean {
  return (
    Number.isInteger(completed) &&
    Number.isInteger(requested) &&
    (completed as number) >= 0 &&
    (completed as number) <= (requested as number) &&
    (requested as number) <= maximumMapTestMaps
  );
}

export function isMapTestScriptName(name: string): boolean {
  return /\.rmstest$/iu.test(name);
}

export function isRootRmsScriptName(name: string): boolean {
  return /\.(?:rms|rms2)$/iu.test(name);
}

export function isRmsIncludeName(name: string): boolean {
  return /\.(?:inc|def)$/iu.test(name);
}
