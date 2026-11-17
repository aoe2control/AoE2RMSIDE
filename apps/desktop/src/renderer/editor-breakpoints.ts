import * as monaco from 'monaco-editor';
import { t as translate } from '../shared/i18n/translator';
import { breakpointTargetLine, parseBreakpointSites, utf8LineStarts } from './breakpoint-model';
import { breakpointStore, type BreakpointRun, type BreakpointStore } from './breakpoint-store';
import { requestRmsBreakpointSites } from './monaco-language';
import { applicationShortcuts, shortcutLabel } from '../shared/application-shortcuts';
import type { PreviewBreakpointStop } from '../shared/breakpoints';
import type { BreakpointPausedLocation } from './breakpoint-store';
import { sameSourceIdentity } from './source-identity';

const siteRefreshDelayMilliseconds = 150;

export interface EditorBreakpointsOptions {
  accepts(model: monaco.editor.ITextModel): boolean;
  showDocument?(documentKey: string): void;
  store?: BreakpointStore;
}

export function editorBreakpointRun(store: BreakpointStore = breakpointStore): BreakpointRun {
  return store.runBreakpoints((documentKey) => {
    const model = monaco.editor
      .getModels()
      .find((candidate) => breakpointDocumentKey(candidate) === documentKey);
    return model && !model.isDisposed() ? { lineStarts: utf8LineStarts(model.getValue()) } : null;
  });
}

export function breakpointDocumentKeyOfUri(uri: string): string {
  return monaco.Uri.parse(uri).toString();
}

export function breakpointPauseLocation(
  stop: PreviewBreakpointStop,
  entryContent: string,
): BreakpointPausedLocation | null {
  const map = stop.map;
  const operation = map?.provenanceOperations[stop.operationIndices[0] ?? -1];
  if (!map || !operation) return null;
  const model = monaco.editor
    .getModels()
    .find((candidate) => sameSourceIdentity(candidate.uri.toString(), operation.sourceId));
  if (!model || model.isDisposed()) return null;
  const text = sameSourceIdentity(map.documentUri, operation.sourceId)
    ? entryContent
    : model.getValue();
  const starts = utf8LineStarts(text);
  let low = 0;
  let high = starts.length - 2;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= operation.byteStart) low = middle;
    else high = middle - 1;
  }
  return { documentKey: breakpointDocumentKey(model), line: Math.max(0, low) };
}

export function breakpointDocumentKey(model: monaco.editor.ITextModel): string {
  return model.uri.toString();
}

export function attachEditorBreakpoints(
  editor: monaco.editor.IStandaloneCodeEditor,
  options: EditorBreakpointsOptions,
): monaco.IDisposable {
  const store = options.store ?? breakpointStore;
  const breakpointDecorations = editor.createDecorationsCollection();
  const ghostDecoration = editor.createDecorationsCollection();
  const pausedDecoration = editor.createDecorationsCollection();
  let ghostLine: number | null = null;
  let revealedPause: unknown = null;
  let shownPause: unknown = null;
  let refreshTimer: number | null = null;
  let rendering = false;

  const model = () => {
    const current = editor.getModel();
    return current && options.accepts(current) ? current : null;
  };

  const hover = (text: string): monaco.IMarkdownString => ({ value: text, isTrusted: false });

  const render = () => {
    const current = model();
    rendering = true;
    try {
      if (!current) {
        breakpointDecorations.clear();
        ghostDecoration.clear();
        pausedDecoration.clear();
        return;
      }
      const key = breakpointDocumentKey(current);
      const lineCount = current.getLineCount();
      breakpointDecorations.set(
        store
          .linesOf(key)
          .filter((line) => line < lineCount)
          .map((line) => {
            const unreached = store.isUnreached(key, line);
            return {
              range: new monaco.Range(line + 1, 1, line + 1, 1),
              options: {
                glyphMarginClassName: unreached
                  ? 'editor-breakpoint editor-breakpoint-unreached'
                  : 'editor-breakpoint',
                glyphMarginHoverMessage: hover(
                  translate(
                    unreached ? 'code-editor.breakpoint.unreached' : 'code-editor.breakpoint.set',
                    { shortcut: shortcutLabel(applicationShortcuts.toggleBreakpoint) },
                  ),
                ),
                stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
              },
            };
          }),
      );
      const paused = store.pausedLocation();
      const pause = store.currentPause();
      if (paused && pause && pause !== revealedPause) {
        if (paused.documentKey === key) {
          revealedPause = pause;
          if (paused.line < lineCount) editor.revealLineInCenterIfOutsideViewport(paused.line + 1);
        } else if (pause !== shownPause) {
          shownPause = pause;
          options.showDocument?.(paused.documentKey);
        }
      }
      pausedDecoration.set(
        paused && paused.documentKey === key && paused.line < lineCount
          ? [
              {
                range: new monaco.Range(paused.line + 1, 1, paused.line + 1, 1),
                options: {
                  isWholeLine: true,
                  className: 'editor-breakpoint-current-line',
                  glyphMarginClassName: 'editor-breakpoint-current',
                  glyphMarginHoverMessage: hover(translate('code-editor.breakpoint.paused')),
                  stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                },
              },
            ]
          : [],
      );
      const ghostShown =
        ghostLine !== null && !store.linesOf(key).includes(ghostLine) && ghostLine < lineCount;
      ghostDecoration.set(
        ghostShown
          ? [
              {
                range: new monaco.Range(ghostLine! + 1, 1, ghostLine! + 1, 1),
                options: {
                  glyphMarginClassName: 'editor-breakpoint-ghost',
                  glyphMarginHoverMessage: hover(
                    translate('code-editor.breakpoint.add', {
                      shortcut: shortcutLabel(applicationShortcuts.toggleBreakpoint),
                    }),
                  ),
                },
              },
            ]
          : [],
      );
    } finally {
      rendering = false;
    }
  };

  const refreshSites = () => {
    const current = model();
    if (!current) return;
    void requestRmsBreakpointSites(current).then((answer) => {
      const sites = parseBreakpointSites(answer);
      if (!sites || current.isDisposed()) return;
      store.setSites(breakpointDocumentKey(current), sites);
    });
  };

  const scheduleSiteRefresh = () => {
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      refreshSites();
    }, siteRefreshDelayMilliseconds);
  };

  const targetLine = (line: number): number | null => {
    const current = model();
    if (!current) return null;
    const sites = store.sitesOf(breakpointDocumentKey(current));
    return sites ? breakpointTargetLine(sites, line) : null;
  };

  const toggleAt = (line: number) => {
    const current = model();
    const target = targetLine(line);
    if (!current || target === null) return;
    store.toggle(breakpointDocumentKey(current), target);
  };

  const isGlyphMargin = (target: monaco.editor.IMouseTarget) =>
    target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;

  const subscriptions: monaco.IDisposable[] = [
    editor.onMouseMove((event) => {
      const line = event.target.position?.lineNumber;
      const next = isGlyphMargin(event.target) && line ? targetLine(line - 1) : null;
      if (next === ghostLine) return;
      ghostLine = next;
      render();
    }),
    editor.onMouseLeave(() => {
      if (ghostLine === null) return;
      ghostLine = null;
      render();
    }),
    editor.onMouseDown((event) => {
      const line = event.target.position?.lineNumber;
      if (!isGlyphMargin(event.target) || !line || event.event.browserEvent.button !== 0) return;
      event.event.preventDefault();
      toggleAt(line - 1);
    }),
    editor.onDidChangeModel(() => {
      ghostLine = null;
      render();
      refreshSites();
    }),
    editor.onDidChangeModelContent(() => {
      const current = model();
      if (current && !rendering) {
        const lines = breakpointDecorations.getRanges().map((range) => range.startLineNumber - 1);
        store.setLines(breakpointDocumentKey(current), lines);
      }
      scheduleSiteRefresh();
    }),
  ];
  const toggleCommand = editor.addAction({
    id: 'rmside.toggleBreakpoint',
    label: translate('code-editor.breakpoint.toggle-action'),
    keybindings: [monaco.KeyCode.F9],
    precondition: undefined,
    run: () => {
      const position = editor.getPosition();
      if (position) toggleAt(position.lineNumber - 1);
    },
  });
  const unsubscribe = store.subscribe(render);
  render();
  refreshSites();
  return {
    dispose: () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      for (const subscription of subscriptions) subscription.dispose();
      toggleCommand.dispose();
      unsubscribe();
      breakpointDecorations.clear();
      ghostDecoration.clear();
      pausedDecoration.clear();
    },
  };
}
