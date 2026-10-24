import type { MapTestReplayInput, MapTestReport } from '../shared/api';
import type { MapTestResultsState } from './app-context';

export function replayedRunSeed(
  report: Pick<MapTestReport, 'findings'>,
  findingId: string,
): number | null {
  const seed = report.findings.find((entry) => entry.findingId === findingId)?.seed;
  return typeof seed === 'number' && Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffff_ffff
    ? seed
    : null;
}

export function mapTestReplayInput(options: {
  executionId: string;
  results: Pick<MapTestResultsState, 'report' | 'runInput'>;
  script: { uri: string; content: string };
  findingId: string;
}): MapTestReplayInput {
  const { executionId, results, script, findingId } = options;
  return {
    executionId,
    scriptUri: script.uri,
    scriptRevision: results.runInput?.scriptRevision ?? 0,
    scriptSource: script.content,
    report: results.report,
    findingId,
    minimapPalette: results.runInput?.minimapPalette ?? null,
    texturePalette: results.runInput?.texturePalette ?? null,
    versionOrigin: results.runInput?.versionOrigin ?? 'packaged',
  };
}
