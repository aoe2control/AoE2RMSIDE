import { createContext, useContext } from 'react';
import type {
  MapTestReport,
  MapTestRunInput,
  MapTestRunResult,
  PreviewGenerationResult,
} from '../shared/api';
import type { PreviewLook, PreviewPerspective } from '../shared/game-art';
import type { OutputMessage } from '../shared/output-message';
import type { ExecutionProfilerStore } from './execution-profiler';
import type { MapTestProgressStore } from './map-test-progress';
import type { PreviewMapOrigin } from './map-test-preview';
import type { OutputRunHeader } from './output-log';
import type { PreviewCandidateStore } from './preview-candidate-store';
import type { PinnedPreviewSource, PreviewExecutionController } from './preview-execution';
import type { RunOutcome, RunTrigger } from './run-outcome';
import type { SourceHighlightRequest } from './source-highlight';
import type { WorkspaceController } from './workspace-controller';

export interface SourceSelection {
  uri: string;
  utf16StartOffset: number;
  utf16EndOffset: number;
  marker: string;
}

export interface AppPanelContextValue {
  workspace: WorkspaceController;
  map: PreviewGenerationResult | null;
  selection: SourceSelection | null;
  highlightedPreviewOperationIndices: readonly number[];
  highlightPreviewSource(request: SourceHighlightRequest | null): void;
  setEditorPointerInside(inside: boolean): void;
  selectPreviewOperation(operationIndex: number): void;
  commitPreview(map: PreviewGenerationResult, origin?: PreviewMapOrigin): void;
  previewMapOrigin: PreviewMapOrigin;
  mapTestPreviewShown: boolean;
  settleRunOutcome(outcome: RunOutcome, trigger: RunTrigger, runKey?: string): void;
  appendOutput(message: OutputMessage, options?: { runId?: string }): void;
  settleOutputRun(runId: string, header: OutputRunHeader | null): void;
  mapTestResults: MapTestResultsState | null;
  clearMapTestResults(): void;
  publishMapTestResult(scriptUri: string, input: MapTestRunInput, result: MapTestRunResult): void;
  markMapTestRun(activity: 'running' | 'error' | 'cancelled'): void;
  mapTestProgress: MapTestProgressStore;
  sourceInvalid(uri: string): boolean;
  previewExecution: PreviewExecutionController | null;
  setPreviewExecution(controller: PreviewExecutionController | null): void;
  pinnedPreviewSource: PinnedPreviewSource | null;
  setPinnedPreviewSource(source: PinnedPreviewSource | null): void;
  openManagedModDeployment(sourceId: string | null): void;
  openSourceLocation(uri: string, line: number, character: number): Promise<boolean>;
  resolvedTheme: 'light' | 'dark';
  executionProfiler: ExecutionProfilerStore;
  previewCandidates: PreviewCandidateStore;
  liveGenerationStages: boolean;
  gpuMapRendering: boolean;
  previewPerspective: PreviewPerspective;
  setPreviewPerspective(perspective: PreviewPerspective): void;
  previewLook: PreviewLook;
  setPreviewLook(look: PreviewLook): void;
  previewTileGrid: boolean;
  setPreviewTileGrid(enabled: boolean): void;
  gameTexturesNoticeOpen: boolean;
  closeGameTexturesNotice(): void;
  previewExpanded: boolean;
  expandPreview(): void;
  profilerOpen: boolean;
  setProfilerOpen(open: boolean): void;
  outputProfilerHost: HTMLElement | null;
  outputVersionHost: HTMLElement | null;
}

export interface MapTestResultsState {
  report: MapTestReport;
  reportJson: string;
  scriptUri: string | null;
  runInput: MapTestRunInput | null;
  imported: boolean;
}

export const AppPanelContext = createContext<AppPanelContextValue | null>(null);

export function useAppPanelContext(): AppPanelContextValue {
  const value = useContext(AppPanelContext);
  if (!value) throw new Error('panel rendered outside the RMSIDE context');
  return value;
}
