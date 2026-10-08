import type { MapTestReplayInput } from '../shared/api';
import type { MapTestResultsState } from './app-context';

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
