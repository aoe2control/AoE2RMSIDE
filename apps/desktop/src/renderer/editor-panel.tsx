import { outputNote } from '../shared/output-message';
import type { ResolvedTheme, RootExecutionPhase } from '../shared/api';
import { editorTabPressOutcome, type PreviewLayout } from '../shared/preview-layout';
import { SourceStructureRequest } from './source-structure-request';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { PlayIcon, XIcon } from '@animateicons/react/lucide';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Download,
  FilePen,
  FolderOpen,
  Gamepad2,
  LockKeyhole,
  LockKeyholeOpen,
  MonitorPlay,
  Pin,
  Play,
  RotateCcw,
  Save,
  Square,
  Unplug,
  X,
} from 'lucide-react';
import * as monaco from 'monaco-editor';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  IconToggleButton,
  ToggleButton,
  ToggleButtonCheck,
  toggleButtonProps,
} from '@/components/ui/toggle-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type AnimatedIconHandle, playIconAnimation, useAnimatedIconHover } from './animated-icon';
import { CodeXmlIcon, HoverScaleIcon, LayersIcon, MapIcon } from './hover-scale-icon';
import { CopyFeedbackIcon, useCopyFeedback } from './copy-button';
import { rovingKeyTarget } from './keyboard-navigation';
import { useI18n } from './i18n';
import { t as translate } from '../shared/i18n/translator';
import type { LiveControlAction } from './live-control-action';
import { useAppPanelContext } from './app-context';
import { wordBasedSuggestionsFor } from './completion-filter';
import { starlarkCursorContext } from './starlark-call-context';
import { EditorContextMenu, useEditorContextMenuSeam } from './editor-context-menu';
import {
  overrideEditorMenuAction,
  pasteActionId,
  setEditorMenuLanguage,
} from './monaco-context-menu';
import { containEditorPopupWheel } from './monaco-popup-wheel';
import { editorModelSyncAction } from './editor-model-sync';
import {
  attachLanguageDocument,
  configureRmsLanguage,
  includeLinkAtPosition,
  openIncludedFile,
  registerActiveRmsEditor,
  onLanguageAnswersChanged,
  requestRmsSnippets,
  requestRmsSourceStructure,
  requestXsOutlineSymbols,
  rmsConditionalIndentation,
  setIncludedFileOpener,
  setLanguageEditGuard,
} from './monaco-language';
import { cursorOnIncludeContextKey, joinConcurrentOpens } from './include-navigation';
import { readOnlyMessage, saveAsFromReadOnlyMessageCommandId } from './read-only-message';
import {
  insertSnippetActionId,
  insertSnippetAvailable,
  ownEditorSnippet,
  ownSnippetPreview,
  parseSnippetContext,
  parseSnippetList,
  saveSnippetActionId,
  saveSnippetAvailable,
  snippetTextFromSelection,
  subscribeInsertSnippetRequests,
  subscribeSaveSnippetRequests,
  type EditorSnippet,
  type SnippetContext,
} from './insert-snippet';
import { InsertSnippetDialog, type InsertSnippetDialogState } from './insert-snippet-dialog';
import { SaveSnippetDialog, type SaveSnippetDialogState } from './save-snippet-dialog';
import {
  snippetEdit,
  snippetPlacement,
  type SnippetEdit,
  type SnippetPlacement,
  type SnippetPlacementMode,
} from './snippet-placement';
import {
  anySnippetSection,
  isOwnSnippetSection,
  type OwnSnippet,
  type OwnSnippetSection,
} from '../shared/own-snippets';
import { sourceLanguageIdForName } from '../shared/xs-contract';
import { bracketColorizationFor } from './rms-language';
import { editorDefaultFontSize, editorFontFamily } from './editor-font';
import { registerRmsEnter } from './rms-enter';
import { editionCapabilities } from '../shared/edition';
import {
  motionDuration,
  motionEasing,
  motionNumber,
  prefersReducedMotion,
  presenceProps,
  usePresence,
  useHeld,
} from './motion';
import {
  isPreviewScriptName,
  previewSeedControls,
  type PreviewExecutionController,
} from './preview-execution';
import { rewordExecutionFailureNotice, type ExecutionFailureNoticeContent } from './run-outcome';
import { editorNoticeDurationFor, useNoticeAutoDismiss } from './notice-auto-dismiss';
import { OverflowingLabel } from './overflow-label';
import { RunningIndicator } from './running-indicator';
import {
  lineByteRanges,
  lineSpanByteRanges,
  sourceHighlightLineSpans,
  sourceLineScopes,
  touchedLines,
  type SourceByteRange,
  type SourceLineScopes,
  type SourceBlockStructure,
} from './source-highlight';
import { pendingSelectionReveal } from './source-navigation';
import {
  emptyOutline,
  mapTestOutline,
  outlinePathAt,
  outlineRowVisible,
  rmsOutline,
  sameOutlinePath,
  xsOutline,
  type DocumentOutline,
  type OutlineEntry,
  type XsOutlineSymbol,
} from './editor-outline';
import { EditorOutlineRow } from './editor-outline-row';
import {
  TabDrag,
  tabAutoScrollStep,
  tabDragSeparators,
  tabDragStarted,
  type TabDropPlacement,
  type TabSlot,
} from './editor-tab-drag';
import { firstFindMatch, moveEditorFindToNextMatch, openEditorFind } from './monaco-find';
import {
  isMapTestScriptName,
  mapTestWorkerDraft,
  mapTestWorkerMaximum,
  mapTestWorkerSettingFromDraft,
} from '../shared/map-test-contract';
import { mapTestWorkerFieldWords } from '../shared/message-catalog';
import {
  applicationKeyAllowed,
  applicationShortcuts,
  matchesShortcut,
  runShortcutAction,
  shortcutLabel,
} from '../shared/application-shortcuts';
import { isModalSurfaceOpen } from './modal-surfaces';
import { SelectGameFolderButton } from './select-game-folder-button';
import {
  bracketColorKeys,
  codeTokenRules,
  editorBackgrounds,
  editorColorScheme as colorSchemeById,
  editorColorSchemes,
  editorThemeName,
  mapTestTokenRules,
} from './editor-color-schemes';
import type { EditorColorSchemeId } from '../shared/editor-color-scheme';

function editorTheme(
  theme: ResolvedTheme,
  documentName: string,
  scheme: EditorColorSchemeId,
): string {
  return editorThemeName(scheme, theme, isMapTestScriptName(documentName) ? 'map-test' : 'code');
}

const appliedWordBasedSuggestions = new WeakMap<
  monaco.editor.IStandaloneCodeEditor,
  ReturnType<typeof wordBasedSuggestionsFor>
>();

function wordBasedSuggestionsAtCursor(
  instance: monaco.editor.IStandaloneCodeEditor,
  languageId: string,
): ReturnType<typeof wordBasedSuggestionsFor> {
  const model = instance.getModel();
  const position = instance.getPosition();
  if (languageId !== 'starlark' || !model || !position) return wordBasedSuggestionsFor(languageId);
  return wordBasedSuggestionsFor(
    languageId,
    starlarkCursorContext(model.getValue(), model.getOffsetAt(position)).kind,
  );
}

const editorFontSizeNoticeDelayMilliseconds = 2_000;
const editorTabMovementAnimationId = 'rmside-tab-movement';
const editorTabOpenAnimationId = 'rmside-tab-open';

function playEditorTabMovement(tab: HTMLElement, horizontalOffset: number): void {
  for (const animation of tab.getAnimations()) {
    if (animation.id === editorTabMovementAnimationId) animation.cancel();
  }
  const animation = tab.animate(
    [
      { opacity: 0.72, transform: `translateX(${horizontalOffset}px)` },
      { opacity: 1, transform: 'translateX(0)' },
    ],
    {
      duration: motionDuration('--motion-duration-tab-move', 160),
      easing: motionEasing('--motion-ease-move', 'cubic-bezier(0.2, 0, 0, 1)'),
    },
  );
  animation.id = editorTabMovementAnimationId;
}

interface EditorTabPress {
  element: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  pointerX: number;
  pointerY: number;
  drag: TabDrag | null;
  scrollFrame: number | null;
  detach(): void;
}

function EditorTabCloseButton({
  active,
  closing,
  dirty,
  name,
  onClose,
  visible,
}: {
  active: boolean;
  closing: boolean;
  dirty: boolean;
  name: string;
  onClose(): void;
  visible: boolean;
}) {
  const { t } = useI18n();
  const iconRef = useRef<AnimatedIconHandle>(null);
  const wasVisible = useRef(visible);
  useLayoutEffect(() => {
    if (visible && !wasVisible.current) playIconAnimation(iconRef.current);
    if (!visible) iconRef.current?.stopAnimation();
    wasVisible.current = visible;
  }, [visible]);
  return (
    <Button
      aria-disabled={closing}
      aria-label={t('code-editor.tab.close', { name })}
      className="editor-tab-close"
      data-appearance-visible={visible}
      onClick={onClose}
      size="icon-xs"
      tabIndex={active ? 0 : -1}
      variant="ghost"
    >
      <XIcon className="editor-tab-close-glyph" duration={0.25} ref={iconRef} size={10} />
      {dirty ? (
        <span aria-label={t('code-editor.tab.unsaved')} className="dirty-indicator" role="img" />
      ) : null}
    </Button>
  );
}

function MapTestWorkersField({
  previewExecution,
}: {
  previewExecution: PreviewExecutionController;
}) {
  const current = previewExecution.mapTestWorkers ?? 'auto';
  const maximum = mapTestWorkerMaximum(navigator.hardwareConcurrency || 1);
  const words = mapTestWorkerFieldWords(maximum);
  const [draft, setDraft] = useState(() => mapTestWorkerDraft(current));
  const focused = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focused.current) return;
    setDraft(mapTestWorkerDraft(current));
  }, [current]);
  const restoreAutomatic = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDraft('');
    previewExecution.setMapTestWorkers?.('auto');
    field.current?.focus();
  };
  return (
    <div className="preview-run-workers-row">
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="preview-run-workers-label"
              onMouseDown={(event) => event.preventDefault()}
            />
          }
        >
          <Cpu aria-hidden="true" />
          <span>{words.label}</span>
        </TooltipTrigger>
        <TooltipContent>{words.hint}</TooltipContent>
      </Tooltip>
      <Input
        aria-label={words.label}
        className="preview-run-workers"
        inputMode="numeric"
        max={maximum}
        min={1}
        onBlur={() => {
          focused.current = false;
          if (draft === mapTestWorkerDraft(current)) return;
          const setting = mapTestWorkerSettingFromDraft(draft, maximum);
          setDraft(mapTestWorkerDraft(setting ?? current));
        }}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const setting = mapTestWorkerSettingFromDraft(next, maximum);
          if (setting !== null) previewExecution.setMapTestWorkers?.(setting);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation();
        }}
        placeholder={words.automatic}
        ref={field}
        step={1}
        type="number"
        value={draft}
      />
      {draft !== '' ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={words.useAutomatic}
                className="preview-run-workers-automatic"
                onClick={restoreAutomatic}
                size="icon-compact"
                type="button"
                variant="ghost"
              />
            }
          >
            <RotateCcw aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>{words.useAutomatic}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

function PreviewSeedField({
  previewExecution,
}: {
  previewExecution: PreviewExecutionController | null;
}) {
  const { t } = useI18n();
  const { copyable, editable: seedEditable } = previewSeedControls(previewExecution);
  const seed = previewExecution?.seed ?? 0;
  const { checkRef, copied, run: runCopy } = useCopyFeedback(`${copyable}:${seed}`);
  const settingsLoaded = Boolean(previewExecution?.settingsLoaded);
  const [seedDraft, setSeedDraft] = useState(() => (settingsLoaded ? String(seed) : ''));
  const seedFieldFocused = useRef(false);

  useEffect(() => {
    if (seedFieldFocused.current && seedEditable) return;
    if (!settingsLoaded) {
      setSeedDraft('');
      return;
    }
    setSeedDraft((current) =>
      current !== '' && Number(current) === seed ? current : String(seed),
    );
  }, [seed, seedEditable, settingsLoaded]);

  const copySeed = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!copyable) return;
    await runCopy(() => navigator.clipboard.writeText(String(seed)));
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="preview-run-seed-field" data-copyable={copyable || undefined} />}
      >
        <Input
          aria-label={t('code-editor.run-menu.seed')}
          className="preview-run-seed"
          disabled={!seedEditable}
          inputMode="numeric"
          max={0xffff_ffff}
          min={0}
          onBlur={() => {
            seedFieldFocused.current = false;
            const drafted = Number(seedDraft);
            setSeedDraft(
              seedDraft !== '' &&
                Number.isSafeInteger(drafted) &&
                drafted >= 0 &&
                drafted <= 0xffff_ffff
                ? String(drafted)
                : String(seed),
            );
          }}
          onChange={(event) => {
            const draft = event.target.value;
            setSeedDraft(draft);
            if (draft !== '') previewExecution?.setSeed(Number(draft));
          }}
          onFocus={() => {
            seedFieldFocused.current = true;
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation();
          }}
          type="number"
          value={seedDraft}
        />
        {copyable ? (
          <button
            aria-label={
              copied
                ? t('code-editor.run-menu.seed-copied')
                : t('code-editor.run-menu.copy-seed-label', { seed })
            }
            className="preview-run-seed-copy"
            data-copied={copied || undefined}
            onClick={(event) => void copySeed(event)}
            type="button"
          >
            <CopyFeedbackIcon checkRef={checkRef} copied={copied} />
          </button>
        ) : null}
      </TooltipTrigger>
      <TooltipContent>
        {t(copyable ? 'code-editor.run-menu.copy-seed' : 'code-editor.run-menu.seed')}
      </TooltipContent>
    </Tooltip>
  );
}

function editorTabDescription(document: { dirty: boolean; readOnly?: boolean }): string | null {
  if (document.dirty && document.readOnly) return translate('code-editor.tab.unsaved-read-only');
  if (document.dirty) return translate('code-editor.tab.unsaved');
  if (document.readOnly) return translate('code-editor.tab.read-only');
  return null;
}

function focusEditorTab(tabList: HTMLElement | null, documentId: string): void {
  const focus = () =>
    tabList
      ?.querySelector<HTMLElement>(
        `.editor-tab[data-document-id="${CSS.escape(documentId)}"] .editor-tab-trigger`,
      )
      ?.focus();
  focus();
  requestAnimationFrame(focus);
}

const passwordMark = '\u0001';

function controlDownloadDescriptionParts(
  words: (password: string) => string,
): [before: string, after: string] {
  const [before = '', after = ''] = words(passwordMark)
    .replace(/\u2068?\u0001\u2069?/u, passwordMark)
    .split(passwordMark);
  return [before, after];
}

function ControlDownloadDescription() {
  const { t } = useI18n();
  const [before, after] = controlDownloadDescriptionParts((password) =>
    t('code-editor.control-download.description', { password }),
  );
  return (
    <>
      {before}
      <strong className="control-download-password">control</strong>
      {after}
    </>
  );
}

function EditorTabTitle({ name }: { name: string }) {
  return (
    <OverflowingLabel
      className="editor-tab-title"
      hoverArea=".editor-tab"
      hoverAreaExcept=".editor-tab-close"
      name={name}
      textClassName="editor-tab-title-text"
    />
  );
}

const editorChromeColors: Record<ResolvedTheme, Record<string, string>> = {
  light: {
    focusBorder: '#00000000',
    'inputOption.activeBorder': '#00000000',
    'editorOverviewRuler.border': '#00000000',
    'editor.background': editorBackgrounds.light,
    'editor.lineHighlightBackground': '#e8e8e8',
    'editor.selectionBackground': '#cacaca',
    'editor.inactiveSelectionBackground': '#d8d8d8',
    'editorWidget.background': '#ededed',
    'editorWidget.border': '#bdbdbd',
    'editorSuggestWidget.background': '#ededed',
    'editorSuggestWidget.border': '#bdbdbd',
    'editorSuggestWidget.selectedBackground': '#e8e8e8',
    'editorHoverWidget.background': '#ededed',
    'editorHoverWidget.border': '#00000000',
    'peekView.border': '#00000000',
    'peekViewEditor.background': '#ebebeb',
    'peekViewEditor.matchHighlightBorder': '#00000000',
    'peekViewEditorGutter.background': '#ebebeb',
    'peekViewEditorStickyScroll.background': '#ebebeb',
    'peekViewEditorStickyScrollGutter.background': '#ebebeb',
    'peekViewResult.background': '#ebebeb',
    'peekViewResult.selectionBackground': '#d8d8d8',
    'peekViewTitle.background': '#ebebeb',
    'scrollbarSlider.background': '#73737333',
    'scrollbarSlider.hoverBackground': '#73737355',
    'scrollbarSlider.activeBackground': '#73737377',
  },
  dark: {
    focusBorder: '#00000000',
    'inputOption.activeBorder': '#00000000',
    'editorOverviewRuler.border': '#00000000',
    'editor.background': editorBackgrounds.dark,
    'editor.lineHighlightBackground': '#262626',
    'editor.selectionBackground': '#525252',
    'editor.inactiveSelectionBackground': '#404040',
    'editorWidget.background': '#0a0a0a',
    'editorWidget.border': '#404040',
    'editorSuggestWidget.background': '#0a0a0a',
    'editorSuggestWidget.border': '#404040',
    'editorSuggestWidget.selectedBackground': '#404040',
    'editorHoverWidget.background': '#0a0a0a',
    'editorHoverWidget.border': '#00000000',
    'peekView.border': '#00000000',
    'peekViewEditor.background': '#0a0a0a',
    'peekViewEditor.matchHighlightBorder': '#00000000',
    'peekViewEditorGutter.background': '#0a0a0a',
    'peekViewEditorStickyScroll.background': '#0a0a0a',
    'peekViewEditorStickyScrollGutter.background': '#0a0a0a',
    'peekViewResult.background': '#0a0a0a',
    'peekViewResult.selectionBackground': '#262626',
    'peekViewTitle.background': '#0a0a0a',
    'scrollbarSlider.background': '#a3a3a333',
    'scrollbarSlider.hoverBackground': '#a3a3a355',
    'scrollbarSlider.activeBackground': '#a3a3a377',
  },
};

function defineRmsideThemes(): void {
  for (const scheme of editorColorSchemes) {
    for (const theme of ['light', 'dark'] as const) {
      const half = scheme[theme];
      const colors = {
        ...editorChromeColors[theme],
        'editor.foreground': half.foreground,
        ...bracketColorKeys(half),
      };
      const base = theme === 'dark' ? 'vs-dark' : 'vs';
      monaco.editor.defineTheme(editorThemeName(scheme.id, theme, 'code'), {
        base,
        inherit: true,
        rules: codeTokenRules(half),
        colors,
      });
      monaco.editor.defineTheme(editorThemeName(scheme.id, theme, 'map-test'), {
        base,
        inherit: true,
        rules: mapTestTokenRules(half),
        colors,
      });
    }
  }
}

function commentLinkAtPosition(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): string | null {
  const line = model.getLineContent(position.lineNumber);
  const commentStart = line.indexOf('#');
  const offset = position.column - 1;
  if (commentStart < 0 || offset <= commentStart) return null;
  const comment = line.slice(commentStart + 1);
  const links = [...comment.matchAll(/https?:\/\/[^\s<>"']+/giu)].map((match) => ({
    start: commentStart + 1 + (match.index ?? 0),
    url: match[0].replace(/[),.;!?]+$/u, ''),
  }));
  return (
    links.find(({ start, url }) => offset >= start && offset <= start + url.length)?.url ??
    (links.length === 1 ? links[0]!.url : null)
  );
}

function singleCommentLinkInRenderedLine(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const line = target.closest('.view-line')?.textContent ?? '';
  const commentStart = line.indexOf('#');
  if (commentStart < 0) return null;
  const links = [...line.slice(commentStart + 1).matchAll(/https?:\/\/[^\s<>"']+/giu)].map(
    (match) => match[0].replace(/[),.;!?]+$/u, ''),
  );
  return links.length === 1 ? links[0]! : null;
}

const sourceStructureRetryDelays = [100, 250, 500, 1_000, 2_000] as const;
const outlineCursorDelayMilliseconds = 60;
const outlineContentDelayMilliseconds = 300;

const editorOutlineRowHeight = 24;

const previewLayoutButtons = {
  'side-by-side': {
    labelId: 'code-editor.preview.layout.side-by-side',
    renderIcon: (ref: Ref<AnimatedIconHandle>) => (
      <MapIcon aria-hidden="true" ref={ref} size={14} />
    ),
  },
  'behind-editor': {
    labelId: 'code-editor.preview.layout.behind-editor',
    renderIcon: (ref: Ref<AnimatedIconHandle>) => (
      <LayersIcon aria-hidden="true" ref={ref} size={14} />
    ),
  },
  'editor-only': {
    labelId: 'code-editor.preview.layout.editor-only',
    renderIcon: (ref: Ref<AnimatedIconHandle>) => (
      <CodeXmlIcon aria-hidden="true" ref={ref} size={14} />
    ),
  },
} as const satisfies Record<
  PreviewLayout,
  { labelId: string; renderIcon(ref: Ref<AnimatedIconHandle>): ReactNode }
>;

export function EditorPanel({
  inlayHints,
  outlineRow,
  executionFailureNotice,
  executionFailureSequence,
  onDismissExecutionFailureNotice,
  previewExpanded,
  previewLayout,
  editorShown,
  onHideEditor,
  onShowEditor,
  recoveryNotice,
  onDismissRecoveryNotice,
  onCyclePreviewLayout,
}: {
  inlayHints: boolean;
  outlineRow: boolean;
  executionFailureNotice: ExecutionFailureNoticeContent | null;
  executionFailureSequence: number;
  onDismissExecutionFailureNotice(): void;
  previewExpanded: boolean;
  previewLayout: PreviewLayout;
  editorShown: boolean;
  onHideEditor(): void;
  onShowEditor(): void;
  recoveryNotice: string | null;
  onDismissRecoveryNotice(): void;
  onCyclePreviewLayout(): void;
}) {
  const { t } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  useEditorContextMenuSeam();
  const tabList = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor>(null);
  const models = useRef(new Map<string, monaco.editor.ITextModel>());
  const modelSubscriptions = useRef(new Map<string, monaco.IDisposable>());
  const languageSubscriptions = useRef(new Map<string, monaco.IDisposable>());
  const programmaticUpdates = useRef(new Set<string>());
  const locallyEditedDocuments = useRef(new Set<string>());
  const workspaceModelSync = useRef(false);
  const viewStateTimer = useRef<number | null>(null);
  const fontSizeNoticeTimer = useRef<number | null>(null);
  const commandHintAlignmentFrame = useRef<number | null>(null);
  const findHintAlignmentFrame = useRef<number | null>(null);
  const draggedTabId = useRef<string | null>(null);
  const tabPress = useRef<EditorTabPress | null>(null);
  const tabClickSuppressed = useRef(false);
  const tabCloseTimers = useRef(new Map<string, number>());
  const tabHoverSuppressionAnchor = useRef<{ x: number; y: number } | null>(null);
  const tabReorderPositions = useRef(new Map<string, DOMRect>());
  const tabListLaidOut = useRef(false);
  const sourceHighlightModel = useRef<{
    model: monaco.editor.ITextModel;
    version: number;
    content: string;
    lines: SourceByteRange[];
    scopes: SourceLineScopes | null;
    provisional: boolean;
    blocks: SourceBlockStructure | null;
    structure: SourceStructureRequest<SourceBlockStructure>;
  } | null>(null);
  const answeredSourceScopes = useRef(
    new WeakMap<
      monaco.editor.ITextModel,
      {
        version: number;
        lineCount: number;
        scopes: SourceLineScopes;
        blocks: SourceBlockStructure;
      }
    >(),
  );
  const updateSourceHighlight = useRef<() => void>(() => undefined);
  const outlineRowShown = useRef(outlineRow);
  outlineRowShown.current = outlineRow;
  const rebuildOutline = useRef<() => void>(() => undefined);
  const [outlineView, setOutlineView] = useState<{
    outline: DocumentOutline;
    path: readonly OutlineEntry[];
    visible: boolean;
  }>({ outline: emptyOutline, path: [], visible: false });
  const outlineRowPresent = outlineRow && outlineView.visible;
  const [tabScrollState, setTabScrollState] = useState({ left: false, right: false });
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [closingTabIds, setClosingTabIds] = useState<Set<string>>(new Set());
  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null);
  const [tabHoverSuppressed, setTabHoverSuppressed] = useState(false);
  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  const [fontSizeNotice, setFontSizeNotice] = useState({
    fontSize: editorDefaultFontSize,
    visible: false,
  });
  const {
    closeGameTexturesNotice,
    gameTexturesNoticeOpen,
    appendOutput,
    highlightPreviewSource,
    openManagedModDeployment,
    openSourceLocation,
    pinnedPreviewSource,
    previewExecution,
    resolvedTheme,
    editorColorScheme,
    selection,
    setEditorPointerInside,
    setPinnedPreviewSource,
    workspace,
  } = useAppPanelContext();
  const editorNotice = executionFailureNotice
    ? 'execution-failure'
    : recoveryNotice
      ? 'recovery'
      : gameTexturesNoticeOpen
        ? 'game-textures'
        : null;
  const editorNoticePresence = usePresence(editorNotice !== null);
  const shownEditorNotice = useHeld(editorNotice, editorNoticePresence.closing);
  const heldExecutionFailure = useHeld(executionFailureNotice, editorNoticePresence.closing);
  const shownExecutionFailure = heldExecutionFailure
    ? rewordExecutionFailureNotice(heldExecutionFailure)
    : null;
  const executionFailureNoticeHold = useNoticeAutoDismiss(
    executionFailureNotice,
    onDismissExecutionFailureNotice,
    editorNoticeDurationFor(
      executionFailureNotice
        ? `${executionFailureNotice.title} ${executionFailureNotice.detail ?? ''}`
        : '',
    ),
  );
  const recoveryNoticeHold = useNoticeAutoDismiss(recoveryNotice, onDismissRecoveryNotice);
  const gameTexturesNoticeHold = useNoticeAutoDismiss(
    gameTexturesNoticeOpen || null,
    closeGameTexturesNotice,
  );
  const workspaceRef = useRef(workspace);
  const focusAfterSaveAs = useRef(false);
  const openSourceLocationRef = useRef(openSourceLocation);
  openSourceLocationRef.current = openSourceLocation;
  workspaceRef.current = workspace;
  const highlightPreviewSourceRef = useRef(highlightPreviewSource);
  highlightPreviewSourceRef.current = highlightPreviewSource;
  const documentOrder = workspace.documents.map((document) => document.id).join('\u0000');
  const activeDocumentCanBePinned = isPreviewScriptName(workspace.activeDocument.name);
  const displayedExecutionName = isMapTestScriptName(workspace.activeDocument.name)
    ? workspace.activeDocument.name
    : (pinnedPreviewSource?.name ?? workspace.activeDocument.name);
  const previewSeedLocked = previewExecution?.seedLocked ?? false;
  const runState = previewExecution?.runState ?? 'idle';
  const executionActive = previewExecution?.executionState.phase !== 'idle';
  const liveTestOnRun = previewExecution?.liveTestOnRun ?? false;
  const liveControl = previewExecution?.control;
  const liveControlAction: LiveControlAction = previewExecution?.controlAction ?? {
    kind: 'remove',
    available: true,
  };
  const liveControlActionLabel = t(
    liveControlAction.kind === 'detach' ? 'run-menu.control.detach' : 'run-menu.control.remove',
  );
  const liveControlActionTooltip = liveControlAction.available
    ? liveControlActionLabel
    : t(
        liveControlAction.wait === 'connecting'
          ? 'run-menu.control.connecting'
          : liveControlAction.wait === 'detaching'
            ? 'run-menu.control.detaching'
            : 'run-menu.control.busy',
      );
  const controlSelectionBusy = previewExecution?.controlSelectionBusy ?? false;
  const gameInstallationBusy = previewExecution?.gameInstallationBusy ?? true;
  const gameInstallationReady = previewExecution?.gameInstallationReady ?? false;
  const gameInstallationSelectionBusy = previewExecution?.gameInstallationSelectionBusy ?? false;
  const liveControlReady = Boolean(
    gameInstallationReady && liveControl?.configured && liveControl.staticallyValid,
  );
  const runActionLabel = t(
    executionActive
      ? 'code-editor.run.stop'
      : liveTestOnRun
        ? 'code-editor.run.preview-and-live-test'
        : isMapTestScriptName(workspace.activeDocument.name)
          ? 'code-editor.run.map-test'
          : 'code-editor.run.preview',
  );
  const runActionTooltip = executionActive
    ? t('code-editor.run.stop-tooltip', { shortcut: shortcutLabel(applicationShortcuts.stop) })
    : liveTestOnRun
      ? t('code-editor.run.preview-and-live-test-tooltip', {
          shortcut: shortcutLabel(applicationShortcuts.run),
        })
      : t('code-editor.run.tooltip', { shortcut: shortcutLabel(applicationShortcuts.run) });
  const seedAdoptionReason =
    previewExecution?.adoptMatchSeedBlockingReason ??
    (!previewExecution?.canAdoptMatchSeed ? t('code-editor.run-menu.adopt-seed-required') : null);
  const runIcon = useAnimatedIconHover();
  const runSwitchIcon = useRef<AnimatedIconHandle>(null);
  const previewIcon = useAnimatedIconHover();
  const previousRunState = useRef(runState);
  const [runCompletionAnimationSequence, setRunCompletionAnimationSequence] = useState(0);
  const [controlDownloadNoticeOpen, setControlDownloadNoticeOpen] = useState(false);

  useLayoutEffect(() => {
    const previous = previousRunState.current;
    previousRunState.current = runState;
    if (previous === 'running' && runState !== 'running') {
      playIconAnimation(runSwitchIcon.current);
      setRunCompletionAnimationSequence((current) => current + 1);
    }
  }, [runState]);

  const confirmRemoveControl = useCallback(async () => {
    if (!previewExecution?.forgetControl) return;
    const choice = await workspace.requestConfirmation({
      title: t('code-editor.control.remove.title'),
      description: t('code-editor.control.remove.description'),
      primaryLabel: t('code-editor.control.remove.confirm'),
    });
    if (choice === 'primary') previewExecution.forgetControl();
  }, [previewExecution, t, workspace]);

  const openControlReleases = useCallback(async () => {
    try {
      await window.rmside.openExternalLink('control-releases');
      setControlDownloadNoticeOpen(true);
    } catch {
      appendOutput(
        outputNote(
          'Live test',
          'live.releases-link-failed',
          { id: 'code-editor.control.releases-failed' },
          { severity: 'error' },
        ),
      );
    }
  }, [appendOutput]);

  const announcedExecutionPhase = useRef<RootExecutionPhase | null>(null);
  useEffect(() => {
    if (!editionCapabilities.preview) return undefined;
    return window.rmside.onExecutionState((state) => {
      announcedExecutionPhase.current = state.phase;
    });
  }, []);

  useEffect(() => {
    if (!editionCapabilities.preview) return undefined;
    const handleRunShortcut = (event: KeyboardEvent) => {
      const stopOnly = matchesShortcut(event, applicationShortcuts.stop);
      if (!stopOnly && !matchesShortcut(event, applicationShortcuts.run)) return;
      event.preventDefault();
      if (event.repeat || !previewExecution || !applicationKeyAllowed(isModalSurfaceOpen())) return;
      const action = runShortcutAction({
        stopOnly,
        announcedPhase: announcedExecutionPhase.current,
        renderedPhase: previewExecution.executionState.phase,
        canRun: previewExecution.canRun,
      });
      if (action === 'stop') previewExecution.stop();
      else if (action === 'run') previewExecution.run();
      else if (action === 'explain') previewExecution.explainBlockedRun?.();
    };
    window.addEventListener('keydown', handleRunShortcut, true);
    return () => window.removeEventListener('keydown', handleRunShortcut, true);
  }, [previewExecution]);

  const updateTabScrollState = useCallback(() => {
    const element = tabList.current;
    if (!element) return;
    const remaining = element.scrollWidth - element.clientWidth - element.scrollLeft;
    const next = {
      left: element.scrollLeft > 1,
      right: remaining > 2,
    };
    setTabScrollState((current) =>
      current.left === next.left && current.right === next.right ? current : next,
    );
  }, []);

  useEffect(() => {
    const element = tabList.current;
    if (!element) return undefined;
    const frame = window.requestAnimationFrame(updateTabScrollState);
    const observer = new ResizeObserver(updateTabScrollState);
    observer.observe(element);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [updateTabScrollState, workspace.documents.length]);

  const scrollTabs = (direction: -1 | 1) => {
    const element = tabList.current;
    if (!element) return;
    const maximum = Math.max(0, element.scrollWidth - element.clientWidth);
    const target = Math.min(maximum, Math.max(0, element.scrollLeft + direction * 96));
    element.scrollTo({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      left: target,
    });
  };

  const finishTabDrag = useCallback((clientX: number, clientY: number) => {
    draggedTabId.current = null;
    tabHoverSuppressionAnchor.current = { x: clientX, y: clientY };
    setDraggingTabId(null);
    setTabHoverSuppressed(true);
  }, []);

  const editorTabElements = useCallback(
    () => [...(tabList.current?.querySelectorAll<HTMLElement>('.editor-tab') ?? [])],
    [],
  );

  const drawTabDrag = useCallback(() => {
    const drag = tabPress.current?.drag;
    const list = tabList.current;
    const press = tabPress.current;
    if (!drag || !list || !press) return;
    const frame = drag.move(press.pointerX, list.scrollLeft);
    const tabs = new Map(editorTabElements().map((tab) => [tab.dataset.documentId, tab]));
    const activeIds = new Set(
      [...tabs.values()].flatMap((tab) =>
        tab.dataset.active === 'true' && tab.dataset.documentId ? [tab.dataset.documentId] : [],
      ),
    );
    const separators = tabDragSeparators(
      drag.slots,
      drag.draggedIndex,
      frame.targetIndex,
      activeIds,
    );
    drag.slots.forEach((slot, index) => {
      const tab = tabs.get(slot.id);
      if (!tab) return;
      const shift = frame.shifts[index] ?? 0;
      tab.style.transform = Math.abs(shift) < 0.01 ? '' : `translateX(${shift}px)`;
      if (separators[index]) tab.dataset.dragSeparator = 'true';
      else delete tab.dataset.dragSeparator;
    });
  }, [editorTabElements]);

  const runTabAutoScroll = useCallback(() => {
    const press = tabPress.current;
    const list = tabList.current;
    if (!press?.drag || !list || press.scrollFrame !== null) return;
    const step = () => {
      press.scrollFrame = null;
      if (tabPress.current !== press) return;
      const bounds = list.getBoundingClientRect();
      const delta = tabAutoScrollStep(press.pointerX, bounds.left, bounds.right);
      if (delta === 0) return;
      const before = list.scrollLeft;
      list.scrollLeft = before + delta;
      if (list.scrollLeft === before) return;
      drawTabDrag();
      press.scrollFrame = window.requestAnimationFrame(step);
    };
    press.scrollFrame = window.requestAnimationFrame(step);
  }, [drawTabDrag]);

  const beginTabDrag = useCallback(
    (press: EditorTabPress): boolean => {
      const list = tabList.current;
      const id = press.element.dataset.documentId;
      if (!list || !id) return false;
      const tabs = editorTabElements();
      if (tabs.some((tab) => tab.dataset.closing)) return false;
      for (const tab of tabs) {
        for (const animation of tab.getAnimations()) {
          if (
            animation.id === editorTabMovementAnimationId ||
            animation.id === editorTabOpenAnimationId
          ) {
            animation.finish();
          }
        }
      }
      const contentLeft = list.getBoundingClientRect().left - list.scrollLeft;
      const slots: TabSlot[] = tabs.flatMap((tab) => {
        const documentId = tab.dataset.documentId;
        if (!documentId) return [];
        const bounds = tab.getBoundingClientRect();
        return [{ id: documentId, left: bounds.left - contentLeft, width: bounds.width }];
      });
      const draggedIndex = slots.findIndex((slot) => slot.id === id);
      if (draggedIndex < 0) return false;
      press.drag = new TabDrag(slots, draggedIndex, press.startX, list.scrollLeft);
      draggedTabId.current = id;
      tabHoverSuppressionAnchor.current = null;
      list.dataset.tabDragging = 'true';
      press.element.dataset.dragging = 'true';
      try {
        press.element.setPointerCapture(press.pointerId);
      } catch {}
      setDraggingTabId(id);
      setTabHoverSuppressed(true);
      return true;
    },
    [editorTabElements],
  );

  const endTabPress = useCallback(
    (outcome: 'commit' | 'cancel' | 'abort') => {
      const press = tabPress.current;
      if (!press) return;
      tabPress.current = null;
      press.detach();
      if (press.scrollFrame !== null) window.cancelAnimationFrame(press.scrollFrame);
      const drag = press.drag;
      if (!drag) return;
      if (press.element.hasPointerCapture(press.pointerId)) {
        press.element.releasePointerCapture(press.pointerId);
      }
      let placement: TabDropPlacement | null = null;
      if (outcome === 'commit') placement = drag.release();
      else drag.cancel();
      tabClickSuppressed.current = true;
      const tabs = editorTabElements();
      const drawn = new Map<string, DOMRect>();
      for (const tab of tabs) {
        const id = tab.dataset.documentId;
        if (id) drawn.set(id, tab.getBoundingClientRect());
      }
      delete tabList.current?.dataset.tabDragging;
      delete press.element.dataset.dragging;
      for (const tab of tabs) {
        tab.style.transform = '';
        delete tab.dataset.dragSeparator;
      }
      finishTabDrag(press.pointerX, press.pointerY);
      if (outcome === 'abort') return;
      if (placement) {
        tabReorderPositions.current = drawn;
        workspaceRef.current.reorderDocument(
          placement.sourceId,
          placement.targetId,
          placement.placement,
        );
        return;
      }
      if (prefersReducedMotion()) return;
      for (const tab of tabs) {
        const before = drawn.get(tab.dataset.documentId ?? '');
        if (!before) continue;
        const offset = before.left - tab.getBoundingClientRect().left;
        if (Math.abs(offset) >= 0.5) playEditorTabMovement(tab, offset);
      }
    },
    [editorTabElements, finishTabDrag],
  );

  const pressEditorTab = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      tabClickSuppressed.current = false;
      if (event.button !== 0 || !event.isPrimary || tabPress.current) return;
      const element = event.currentTarget;
      if (element.dataset.closing) return;
      if (event.target instanceof Element && event.target.closest('.editor-tab-close')) return;
      const press: EditorTabPress = {
        element,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        pointerX: event.clientX,
        pointerY: event.clientY,
        drag: null,
        scrollFrame: null,
        detach: () => undefined,
      };
      const move = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== press.pointerId || tabPress.current !== press) return;
        press.pointerX = moveEvent.clientX;
        press.pointerY = moveEvent.clientY;
        if (!press.drag) {
          if (!tabDragStarted(press.pointerX - press.startX, press.pointerY - press.startY)) return;
          if (!beginTabDrag(press)) return;
        }
        moveEvent.preventDefault();
        drawTabDrag();
        runTabAutoScroll();
      };
      const release = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== press.pointerId) return;
        press.pointerX = upEvent.clientX;
        press.pointerY = upEvent.clientY;
        endTabPress('commit');
      };
      const cancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId === press.pointerId) endTabPress('cancel');
      };
      const escape = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== 'Escape' || !press.drag) return;
        keyEvent.preventDefault();
        keyEvent.stopImmediatePropagation();
        endTabPress('cancel');
      };
      const blur = () => endTabPress('cancel');
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', release, true);
      window.addEventListener('pointercancel', cancel, true);
      window.addEventListener('keydown', escape, true);
      window.addEventListener('blur', blur);
      press.detach = () => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', release, true);
        window.removeEventListener('pointercancel', cancel, true);
        window.removeEventListener('keydown', escape, true);
        window.removeEventListener('blur', blur);
      };
      tabPress.current = press;
    },
    [beginTabDrag, drawTabDrag, endTabPress, runTabAutoScroll],
  );

  useEffect(() => () => endTabPress('abort'), [endTabPress]);

  const openCommentLink = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!event.ctrlKey || event.button !== 0) return;
    const instance = editor.current;
    const model = instance?.getModel();
    const position = instance?.getTargetAtClientPoint(event.clientX, event.clientY)?.position;
    const url =
      (model && position ? commentLinkAtPosition(model, position) : null) ??
      singleCommentLinkInRenderedLine(event.target);
    if (!url) return;
    event.preventDefault();
    event.stopPropagation();
    void window.rmside.openDocumentLink(url);
  }, []);

  const alignCommandPaletteHint = useCallback((row: HTMLElement) => {
    if (commandHintAlignmentFrame.current !== null) {
      window.cancelAnimationFrame(commandHintAlignmentFrame.current);
    }
    const deadline = window.performance.now() + 1_000;
    const align = () => {
      commandHintAlignmentFrame.current = null;
      if (!row.isConnected || !row.matches(':hover')) return;
      const hint = container.current?.querySelector<HTMLElement>(
        '.monaco-hover.workbench-hover.with-pointer',
      );
      const wrapper = hint?.closest<HTMLElement>('.context-view.monaco-component');
      if (!hint || !wrapper || hint.offsetParent === null) {
        if (window.performance.now() < deadline) {
          commandHintAlignmentFrame.current = window.requestAnimationFrame(align);
        }
        return;
      }
      wrapper.style.translate = '';
      const offset = row.getBoundingClientRect().top - hint.getBoundingClientRect().top;
      if (Math.abs(offset) > 0.5) wrapper.style.translate = `0 ${offset}px`;
    };
    commandHintAlignmentFrame.current = window.requestAnimationFrame(align);
  }, []);

  const alignFindWidgetHint = useCallback((button: HTMLElement) => {
    if (findHintAlignmentFrame.current !== null) {
      window.cancelAnimationFrame(findHintAlignmentFrame.current);
    }
    const deadline = window.performance.now() + 1_000;
    const align = () => {
      findHintAlignmentFrame.current = null;
      if (!button.isConnected) return;
      const label = button.getAttribute('aria-label')?.trim();
      const hint = [
        ...document.querySelectorAll<HTMLElement>('.monaco-hover.workbench-hover'),
      ].find(
        (candidate) =>
          candidate.offsetParent !== null && (!label || candidate.textContent?.trim() === label),
      );
      const wrapper = hint?.closest<HTMLElement>('.context-view.monaco-component');
      if (!hint || !wrapper) {
        if (window.performance.now() < deadline) {
          findHintAlignmentFrame.current = window.requestAnimationFrame(align);
        }
        return;
      }
      wrapper.style.translate = '';
      const findBounds = button.closest<HTMLElement>('.find-widget')?.getBoundingClientRect();
      const hintBounds = hint.getBoundingClientRect();
      const editorBounds = container.current?.getBoundingClientRect();
      if (!editorBounds || !findBounds) return;
      const gap = 4;
      const above = findBounds.top - gap - hintBounds.height;
      const below = findBounds.bottom + gap;
      const targetTop =
        above >= editorBounds.top + gap
          ? above
          : below + hintBounds.height <= editorBounds.bottom - gap
            ? below
            : Math.max(editorBounds.top + gap, editorBounds.bottom - gap - hintBounds.height);
      const offset = targetTop - hintBounds.top;
      if (Math.abs(offset) > 0.5) wrapper.style.translate = `0 ${offset}px`;
    };
    findHintAlignmentFrame.current = window.requestAnimationFrame(align);
  }, []);

  useEffect(() => {
    const handleMouseOver = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const findButton = event.target.closest<HTMLElement>('.find-widget .button[role="button"]');
      if (findButton) alignFindWidgetHint(findButton);
      const row = event.target.closest<HTMLElement>('.quick-input-widget .monaco-list-row');
      if (row) alignCommandPaletteHint(row);
    };
    document.addEventListener('mouseover', handleMouseOver, true);
    return () => {
      document.removeEventListener('mouseover', handleMouseOver, true);
      if (commandHintAlignmentFrame.current !== null) {
        window.cancelAnimationFrame(commandHintAlignmentFrame.current);
        commandHintAlignmentFrame.current = null;
      }
      if (findHintAlignmentFrame.current !== null) {
        window.cancelAnimationFrame(findHintAlignmentFrame.current);
        findHintAlignmentFrame.current = null;
      }
    };
  }, [alignCommandPaletteHint, alignFindWidgetHint]);

  const captureTabPositions = useCallback(() => {
    const positions = tabReorderPositions.current;
    positions.clear();
    for (const tab of tabList.current?.querySelectorAll<HTMLElement>('.editor-tab') ?? []) {
      const id = tab.dataset.documentId;
      if (id) positions.set(id, tab.getBoundingClientRect());
    }
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      if (tabCloseTimers.current.has(id)) return;
      captureTabPositions();
      for (const tab of tabList.current?.querySelectorAll<HTMLElement>('.editor-tab') ?? []) {
        if (tab.dataset.documentId !== id) continue;
        for (const animation of tab.getAnimations()) {
          if (animation.id === editorTabOpenAnimationId) animation.cancel();
        }
      }
      setClosingTabIds((current) => new Set(current).add(id));
      const timer = window.setTimeout(
        () => {
          tabCloseTimers.current.delete(id);
          void workspaceRef.current.closeDocumentById(id).finally(() => {
            setClosingTabIds((current) => {
              const next = new Set(current);
              next.delete(id);
              return next;
            });
          });
        },
        motionDuration('--motion-duration-tab-close', 90),
      );
      tabCloseTimers.current.set(id, timer);
    },
    [captureTabPositions],
  );

  useEffect(
    () => () => {
      for (const timer of tabCloseTimers.current.values()) window.clearTimeout(timer);
      tabCloseTimers.current.clear();
    },
    [],
  );

  useLayoutEffect(() => {
    endTabPress('abort');
  }, [documentOrder, endTabPress]);

  useLayoutEffect(() => {
    drawTabDrag();
  }, [workspace.activeDocumentId, drawTabDrag]);

  useLayoutEffect(() => {
    const previousPositions = tabReorderPositions.current;
    const tabs = [...(tabList.current?.querySelectorAll<HTMLElement>('.editor-tab') ?? [])];
    const currentPositions = new Map<string, DOMRect>();
    for (const tab of tabs) {
      const id = tab.dataset.documentId;
      if (id) currentPositions.set(id, tab.getBoundingClientRect());
    }
    const reduceMotion = prefersReducedMotion();
    const laidOut = tabListLaidOut.current;
    tabListLaidOut.current = true;
    for (const tab of tabs) {
      const id = tab.dataset.documentId;
      if (!id || id === draggedTabId.current || reduceMotion) continue;
      const previous = previousPositions.get(id);
      if (!previous) {
        if (!laidOut || tab.dataset.closing) continue;
        const distance = motionNumber('--motion-distance-tab', 2);
        const scale = motionNumber('--motion-scale-tab', 0.94);
        const animation = tab.animate(
          [
            { opacity: 0, transform: `translateY(${-distance}px) scaleX(${scale})` },
            { opacity: 1, transform: 'none' },
          ],
          {
            duration: motionDuration('--motion-duration-tab-open', 120),
            easing: motionEasing('--motion-ease-out', 'cubic-bezier(0.16, 1, 0.3, 1)'),
            fill: 'backwards',
          },
        );
        animation.id = editorTabOpenAnimationId;
        continue;
      }
      const current = currentPositions.get(id);
      if (!current) continue;
      const horizontalOffset = previous.left - current.left;
      if (Math.abs(horizontalOffset) < 0.5) continue;
      playEditorTabMovement(tab, horizontalOffset);
    }
    tabReorderPositions.current = currentPositions;
    updateTabScrollState();
  }, [documentOrder, updateTabScrollState]);

  useEffect(() => {
    if (!container.current) return undefined;
    configureRmsLanguage();
    defineRmsideThemes();
    const instance = monaco.editor.create(container.current, {
      acceptSuggestionOnEnter: 'smart',
      accessibilitySupport: 'auto',
      automaticLayout: true,
      bracketPairColorization: { enabled: false },
      inlayHints: { enabled: 'offUnlessPressed', padding: true },
      detectIndentation: false,
      fontFamily: editorFontFamily,
      fontSize: editorDefaultFontSize,
      fixedOverflowWidgets: true,
      minimap: { enabled: false },
      scrollbar: { horizontalScrollbarSize: 10, useShadows: false, verticalScrollbarSize: 10 },
      model: null,
      mouseWheelZoom: true,
      insertSpaces: true,
      padding: { top: 16 },
      'semanticHighlighting.enabled': true,
      theme: editorTheme(resolvedTheme, workspace.activeDocument.name, editorColorScheme),
      tabSize: 4,
      useShadowDOM: false,
    });
    document.body.classList.add('rmside-monaco-056');
    const releasePopupWheel = containEditorPopupWheel(container.current);
    const rmsEditorRegistration = registerActiveRmsEditor(instance);
    const rmsEnterRegistration = registerRmsEnter(instance, monaco, rmsConditionalIndentation);
    const editGuardRegistration = setLanguageEditGuard((uri) => {
      const target = monaco.Uri.parse(uri).toString();
      const document = workspaceRef.current.documents.find(
        (entry) => monaco.Uri.parse(entry.uri).toString() === target,
      );
      return document?.readOnly
        ? translate('code-editor.rename.protected-file', { name: document.name })
        : null;
    });
    const configurationSubscription = instance.onDidChangeConfiguration((event) => {
      if (!event.hasChanged(monaco.editor.EditorOption.fontSize)) return;
      if (fontSizeNoticeTimer.current !== null) {
        window.clearTimeout(fontSizeNoticeTimer.current);
      }
      setFontSizeNotice({
        fontSize: instance.getOption(monaco.editor.EditorOption.fontSize),
        visible: true,
      });
      fontSizeNoticeTimer.current = window.setTimeout(() => {
        fontSizeNoticeTimer.current = null;
        setFontSizeNotice((current) => ({ ...current, visible: false }));
      }, editorFontSizeNoticeDelayMilliseconds);
    });
    const persistViewState = () => {
      if (viewStateTimer.current !== null) window.clearTimeout(viewStateTimer.current);
      viewStateTimer.current = window.setTimeout(() => {
        viewStateTimer.current = null;
        const model = instance.getModel();
        const document = workspaceRef.current.documents.find(
          (entry) => models.current.get(entry.id) === model,
        );
        const viewState = instance.saveViewState();
        if (document && viewState)
          workspaceRef.current.setDocumentViewState(document.id, viewState);
      }, 180);
    };
    const commentLinkSubscription = instance.onMouseDown((event) => {
      const browserEvent = event.event.browserEvent;
      const model = instance.getModel();
      const position = event.target.position;
      if (!browserEvent.ctrlKey || browserEvent.button !== 0 || !model || !position) return;
      const url = commentLinkAtPosition(model, position);
      if (!url) return;
      browserEvent.preventDefault();
      browserEvent.stopPropagation();
      void window.rmside.openDocumentLink(url);
    });
    instance.onDidChangeModel(() => {
      if (workspaceModelSync.current) return;
      const activeModel = instance.getModel();
      const document = workspaceRef.current.documents.find(
        (entry) => models.current.get(entry.id) === activeModel,
      );
      if (document) workspaceRef.current.setActiveDocument(document.id);
    });
    instance.onDidChangeCursorPosition(() => {
      persistViewState();
      if (instance.getModel()?.getLanguageId() !== 'starlark') return;
      const words = wordBasedSuggestionsAtCursor(instance, 'starlark');
      if (appliedWordBasedSuggestions.get(instance) !== words) {
        appliedWordBasedSuggestions.set(instance, words);
        instance.updateOptions({ wordBasedSuggestions: words });
      }
    });
    const refreshSourceHighlight = () => {
      const model = instance.getModel();
      const sourceDocument = model
        ? workspaceRef.current.documents.find((entry) => models.current.get(entry.id) === model)
        : undefined;
      if (!model || !sourceDocument || model.getLanguageId() !== 'rms') {
        highlightPreviewSourceRef.current(null);
        return;
      }
      const version = model.getVersionId();
      let current = sourceHighlightModel.current;
      if (current?.model !== model || current.version !== version) {
        current?.structure.stop();
        const content = model.getValue();
        const lineCount = model.getLineCount();
        const answered = answeredSourceScopes.current.get(model);
        const answeredNow = answered?.version === version;
        const reusable = answered && (answeredNow || answered.lineCount === lineCount);
        const entry: NonNullable<typeof sourceHighlightModel.current> = {
          model,
          version,
          content,
          lines: lineByteRanges(content),
          scopes: reusable ? answered.scopes : null,
          provisional: Boolean(reusable && !answeredNow),
          blocks: answeredNow ? answered.blocks : null,
          structure: new SourceStructureRequest<SourceBlockStructure>({
            request: () => requestRmsSourceStructure(model),
            current: () =>
              sourceHighlightModel.current === entry &&
              !model.isDisposed() &&
              model.getVersionId() === entry.version,
            apply: (structure) => {
              entry.scopes = sourceLineScopes(structure, model.getLineCount());
              entry.provisional = false;
              entry.blocks = structure;
              answeredSourceScopes.current.set(model, {
                version: entry.version,
                lineCount: model.getLineCount(),
                scopes: entry.scopes,
                blocks: structure,
              });
              if (instance.getModel() === model) {
                refreshSourceHighlight();
                rebuildOutline.current();
              }
            },
            delays: sourceStructureRetryDelays,
            setTimer: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
            clearTimer: (timer) => window.clearTimeout(timer as number),
          }),
        };
        sourceHighlightModel.current = entry;
        current = entry;
        if (answeredNow) entry.structure.stop();
        else entry.structure.start();
      } else if (current.scopes === null || current.provisional) {
        current.structure.poke();
      }
      const spans = sourceHighlightLineSpans(
        (instance.getSelections() ?? []).map(touchedLines),
        current.scopes,
      );
      highlightPreviewSourceRef.current({
        sourceId: sourceDocument.uri,
        byteRanges: lineSpanByteRanges(current.lines, spans),
        content: current.content,
      });
    };
    updateSourceHighlight.current = refreshSourceHighlight;
    instance.onDidChangeCursorSelection(refreshSourceHighlight);
    const languageAnswersSubscription = onLanguageAnswersChanged(() => {
      const current = sourceHighlightModel.current;
      if (current && (current.scopes === null || current.provisional)) current.structure.poke();
      xsOutlineRequest?.request.poke();
    });
    const outlineSources = new WeakMap<
      monaco.editor.ITextModel,
      { version: number; outline: DocumentOutline }
    >();
    let xsOutlineRequest: {
      model: monaco.editor.ITextModel;
      version: number;
      request: SourceStructureRequest<XsOutlineSymbol[]>;
    } | null = null;
    let outlineCursorTimer: number | null = null;
    let outlineContentTimer: number | null = null;
    const publishOutline = () => {
      const model = instance.getModel();
      const source =
        model && outlineRowShown.current ? outlineSources.get(model)?.outline : undefined;
      const pending =
        source === undefined &&
        model !== null &&
        outlineRowShown.current &&
        (model.getLanguageId() === 'rms' || model.getLanguageId() === 'xs');
      const outline = source ?? emptyOutline;
      const position = instance.getPosition();
      const path = position ? outlinePathAt(outline, position.lineNumber - 1) : [];
      setOutlineView((current) => {
        const visible = outlineRowVisible(pending ? null : outline, current.visible);
        return current.outline === outline &&
          current.visible === visible &&
          sameOutlinePath(current.path, path)
          ? current
          : { outline, path, visible };
      });
    };
    const requestXsOutline = (model: monaco.editor.ITextModel, version: number) => {
      if (xsOutlineRequest?.model === model && xsOutlineRequest.version === version) {
        xsOutlineRequest.request.poke();
        return;
      }
      xsOutlineRequest?.request.stop();
      const entry: NonNullable<typeof xsOutlineRequest> = {
        model,
        version,
        request: new SourceStructureRequest<XsOutlineSymbol[]>({
          request: () => requestXsOutlineSymbols(model),
          current: () =>
            xsOutlineRequest === entry &&
            outlineRowShown.current &&
            !model.isDisposed() &&
            model.getVersionId() === version,
          apply: (symbols) => {
            outlineSources.set(model, { version, outline: xsOutline(symbols) });
            if (instance.getModel() === model) publishOutline();
          },
          delays: sourceStructureRetryDelays,
          setTimer: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
          clearTimer: (timer) => window.clearTimeout(timer as number),
        }),
      };
      xsOutlineRequest = entry;
      entry.request.start();
    };
    const updateOutlineSource = () => {
      const model = instance.getModel();
      if (!model || !outlineRowShown.current) return;
      const version = model.getVersionId();
      if (outlineSources.get(model)?.version === version) return;
      const languageId = model.getLanguageId();
      if (languageId === 'rms') {
        const highlight = sourceHighlightModel.current;
        if (highlight?.model === model && highlight.version === version && highlight.blocks) {
          outlineSources.set(model, {
            version,
            outline: rmsOutline(highlight.blocks, model.getLineCount(), (line) =>
              model.getLineContent(line + 1),
            ),
          });
        }
      } else if (languageId === 'starlark') {
        outlineSources.set(model, { version, outline: mapTestOutline(model.getLinesContent()) });
      } else if (languageId === 'xs') {
        requestXsOutline(model, version);
      }
    };
    rebuildOutline.current = () => {
      if (outlineContentTimer !== null) window.clearTimeout(outlineContentTimer);
      outlineContentTimer = null;
      updateOutlineSource();
      publishOutline();
    };
    const outlineSubscriptions = [
      instance.onDidChangeCursorPosition(() => {
        if (!outlineRowShown.current) return;
        if (outlineCursorTimer !== null) window.clearTimeout(outlineCursorTimer);
        outlineCursorTimer = window.setTimeout(() => {
          outlineCursorTimer = null;
          publishOutline();
        }, outlineCursorDelayMilliseconds);
      }),
      instance.onDidChangeModelContent(() => {
        if (!outlineRowShown.current) return;
        if (outlineContentTimer !== null) window.clearTimeout(outlineContentTimer);
        outlineContentTimer = window.setTimeout(
          () => rebuildOutline.current(),
          outlineContentDelayMilliseconds,
        );
      }),
      instance.onDidChangeModel(() => rebuildOutline.current()),
      instance.onDidChangeModelLanguage(() => {
        const model = instance.getModel();
        if (model) outlineSources.delete(model);
        rebuildOutline.current();
      }),
    ];
    instance.onDidScrollChange(persistViewState);
    const openSourceLocationOnce = joinConcurrentOpens(
      (uri: string, line: number, character: number) =>
        openSourceLocationRef.current(uri, line, character),
      (uri) => monaco.Uri.parse(uri).toString(),
    );
    const revealResource = (
      source: monaco.editor.ICodeEditor,
      resource: monaco.Uri,
      selectionOrPosition: monaco.IRange | monaco.IPosition | null | undefined,
    ): boolean | Promise<boolean> => {
      const target = [...models.current.values()].find(
        (model) => model.uri.toString() === resource.toString(),
      );
      if (!target) {
        const start = !selectionOrPosition
          ? { lineNumber: 1, column: 1 }
          : monaco.Range.isIRange(selectionOrPosition)
            ? {
                lineNumber: selectionOrPosition.startLineNumber,
                column: selectionOrPosition.startColumn,
              }
            : selectionOrPosition;
        return openSourceLocationOnce(resource.toString(), start.lineNumber - 1, start.column - 1);
      }
      source.setModel(target);
      if (selectionOrPosition && monaco.Range.isIRange(selectionOrPosition)) {
        source.setSelection(selectionOrPosition);
        source.revealRangeInCenter(selectionOrPosition);
      } else if (selectionOrPosition) {
        source.setPosition(selectionOrPosition);
        source.revealPositionInCenter(selectionOrPosition);
      }
      source.focus();
      return true;
    };
    const editorOpener = monaco.editor.registerEditorOpener({
      openCodeEditor: revealResource,
    });
    const includedFileOpener = setIncludedFileOpener((uri) =>
      revealResource(instance, monaco.Uri.parse(uri), { lineNumber: 1, column: 1 }),
    );
    const cursorOnInclude = instance.createContextKey<boolean>(cursorOnIncludeContextKey, false);
    let includeContextRequest = 0;
    let includeContextTimer: number | null = null;
    const updateIncludeContext = () => {
      const request = (includeContextRequest += 1);
      const model = instance.getModel();
      const position = instance.getPosition();
      if (!model || !position) {
        cursorOnInclude.set(false);
        return;
      }
      void includeLinkAtPosition(model, position).then((link) => {
        if (request === includeContextRequest) cursorOnInclude.set(link !== null);
      });
    };
    const refreshIncludeContext = (immediate: boolean) => {
      if (includeContextTimer !== null) window.clearTimeout(includeContextTimer);
      includeContextTimer = null;
      if (immediate) updateIncludeContext();
      else includeContextTimer = window.setTimeout(updateIncludeContext, 200);
    };
    const includeContextSubscriptions = [
      instance.onDidChangeCursorPosition((event) =>
        refreshIncludeContext(event.source === 'mouse'),
      ),
      instance.onDidChangeModel(() => refreshIncludeContext(true)),
    ];
    const releaseMenuLanguage = setEditorMenuLanguage(
      () => instance.getModel()?.getLanguageId() ?? null,
    );
    const releasePasteOverride = overrideEditorMenuAction(pasteActionId, () =>
      window.rmside.pasteIntoEditor(),
    );
    editor.current = instance;
    return () => {
      releaseMenuLanguage();
      releasePasteOverride();
      releasePopupWheel();
      configurationSubscription.dispose();
      commentLinkSubscription.dispose();
      rmsEditorRegistration.dispose();
      rmsEnterRegistration.dispose();
      editGuardRegistration.dispose();
      editorOpener.dispose();
      includedFileOpener.dispose();
      for (const subscription of includeContextSubscriptions) subscription.dispose();
      if (includeContextTimer !== null) window.clearTimeout(includeContextTimer);
      if (viewStateTimer.current !== null) window.clearTimeout(viewStateTimer.current);
      if (fontSizeNoticeTimer.current !== null) {
        window.clearTimeout(fontSizeNoticeTimer.current);
        fontSizeNoticeTimer.current = null;
      }
      updateSourceHighlight.current = () => undefined;
      rebuildOutline.current = () => undefined;
      for (const subscription of outlineSubscriptions) subscription.dispose();
      if (outlineCursorTimer !== null) window.clearTimeout(outlineCursorTimer);
      if (outlineContentTimer !== null) window.clearTimeout(outlineContentTimer);
      xsOutlineRequest?.request.stop();
      xsOutlineRequest = null;
      languageAnswersSubscription.dispose();
      sourceHighlightModel.current?.structure.stop();
      sourceHighlightModel.current = null;
      highlightPreviewSourceRef.current(null);
      instance.dispose();
      for (const subscription of modelSubscriptions.current.values()) subscription.dispose();
      for (const subscription of languageSubscriptions.current.values()) subscription.dispose();
      for (const model of models.current.values()) model.dispose();
      modelSubscriptions.current.clear();
      languageSubscriptions.current.clear();
      models.current.clear();
      locallyEditedDocuments.current.clear();
      editor.current = null;
      document.body.classList.remove('rmside-monaco-056');
    };
  }, []);

  useEffect(() => {
    const documentIds = new Set(workspace.documents.map((document) => document.id));
    for (const [id, model] of models.current) {
      if (documentIds.has(id)) continue;
      modelSubscriptions.current.get(id)?.dispose();
      languageSubscriptions.current.get(id)?.dispose();
      modelSubscriptions.current.delete(id);
      languageSubscriptions.current.delete(id);
      locallyEditedDocuments.current.delete(id);
      models.current.delete(id);
      model.dispose();
    }
    for (const document of workspace.documents) {
      let model = models.current.get(document.id);
      if (model && model.getLanguageId() !== sourceLanguageIdForName(document.name)) {
        const languageId = sourceLanguageIdForName(document.name);
        languageSubscriptions.current.get(document.id)?.dispose();
        monaco.editor.setModelLanguage(model, languageId);
        model.updateOptions({ bracketColorizationOptions: bracketColorizationFor(languageId) });
        languageSubscriptions.current.set(document.id, attachLanguageDocument(model, languageId));
      }
      if (!model) {
        const languageId = sourceLanguageIdForName(document.name);
        model = monaco.editor.createModel(
          document.content,
          languageId,
          monaco.Uri.parse(document.uri),
        );
        model.updateOptions({
          tabSize: 4,
          insertSpaces: true,
          bracketColorizationOptions: bracketColorizationFor(languageId),
        });
        models.current.set(document.id, model);
        modelSubscriptions.current.set(
          document.id,
          model.onDidChangeContent(() => {
            if (programmaticUpdates.current.has(document.id)) return;
            locallyEditedDocuments.current.add(document.id);
            const currentWorkspace = workspaceRef.current;
            if (
              editor.current?.getModel() === model &&
              currentWorkspace.activeDocumentId !== document.id
            ) {
              currentWorkspace.setActiveDocument(document.id);
            }
            currentWorkspace.setDocumentContent(document.id, model?.getValue() ?? '');
          }),
        );
        languageSubscriptions.current.set(document.id, attachLanguageDocument(model, languageId));
        workspaceRef.current.adoptEditorText(document.id, document.content, model.getValue());
      } else {
        const action = editorModelSyncAction(
          model.getValue(),
          document,
          workspace.latestDocument(document.id),
          locallyEditedDocuments.current.has(document.id),
        );
        if (action.kind === 'settle') {
          locallyEditedDocuments.current.delete(document.id);
        } else if (action.kind === 'replace') {
          locallyEditedDocuments.current.delete(document.id);
          programmaticUpdates.current.add(document.id);
          model.setValue(action.content);
          programmaticUpdates.current.delete(document.id);
          workspaceRef.current.adoptEditorText(document.id, action.content, model.getValue());
        }
      }
    }

    const activeModel = models.current.get(workspace.activeDocumentId) ?? null;
    if (editor.current?.getModel() !== activeModel) {
      const previousModel = editor.current?.getModel();
      const previousDocument = workspace.documents.find(
        (document) => models.current.get(document.id) === previousModel,
      );
      const previousState = editor.current?.saveViewState();
      if (previousDocument && previousState) {
        workspace.setDocumentViewState(previousDocument.id, previousState);
      }
      workspaceModelSync.current = true;
      try {
        const activeLanguageId = sourceLanguageIdForName(workspace.activeDocument.name);
        if (activeModel && activeModel.getLanguageId() !== activeLanguageId) {
          monaco.editor.setModelLanguage(activeModel, activeLanguageId);
        }
        editor.current?.setModel(activeModel);
        if (workspace.activeDocument.viewState) {
          editor.current?.restoreViewState(
            workspace.activeDocument.viewState as unknown as monaco.editor.ICodeEditorViewState,
          );
        }
      } finally {
        workspaceModelSync.current = false;
      }
    }
    const editorLanguageId = sourceLanguageIdForName(workspace.activeDocument.name);
    const bracketPairs = editorLanguageId !== 'xs';
    const words = editor.current
      ? wordBasedSuggestionsAtCursor(editor.current, editorLanguageId)
      : wordBasedSuggestionsFor(editorLanguageId);
    if (editor.current) appliedWordBasedSuggestions.set(editor.current, words);
    editor.current?.updateOptions({
      wordBasedSuggestions: words,
      bracketPairColorization: {
        enabled: bracketPairs,
        independentColorPoolPerBracketType: false,
      },
      guides: { bracketPairs: bracketPairs ? 'active' : false, highlightActiveBracketPair: true },
      matchBrackets: 'always',
      readOnly: workspace.activeDocument.readOnly,
      readOnlyMessage: readOnlyMessage(workspace.activeDocument.protectedReason),
    });
    if (focusAfterSaveAs.current) {
      focusAfterSaveAs.current = false;
      editor.current?.focus();
    }
  }, [t, workspace.activeDocument, workspace.activeDocumentId, workspace.documents]);

  useEffect(() => {
    const command = monaco.editor.registerCommand(saveAsFromReadOnlyMessageCommandId, () => {
      const documentId = workspaceRef.current.activeDocumentId;
      void workspaceRef.current.saveActiveAs().finally(() => {
        if (!workspaceRef.current.latestDocument(documentId)) focusAfterSaveAs.current = true;
        editor.current?.focus();
      });
    });
    return () => command.dispose();
  }, []);

  const [snippetDialog, setSnippetDialog] = useState<InsertSnippetDialogState>({
    id: 0,
    open: false,
    status: 'loading',
    snippets: [],
  });
  const snippetTarget = useRef<{
    model: monaco.editor.ITextModel;
    selection: monaco.Selection;
    version: number;
    context: SnippetContext | null;
  } | null>(null);
  const snippetChoice = useRef<{ snippet: EditorSnippet; mode: SnippetPlacementMode } | null>(null);
  const snippetDialogSequence = useRef(0);
  const loadSnippets = useCallback(
    async (id: number, ownSnippets?: readonly OwnSnippet[]): Promise<void> => {
      const target = snippetTarget.current;
      if (!target) return;
      const own = ownSnippets ?? (await window.rmside.listOwnSnippets().catch(() => []));
      const previews = own.map((snippet) => ownSnippetPreview(snippet.body));
      const sent =
        previews.reduce((total, preview) => total + preview.length, 0) <= maximumColoredPreviews
          ? previews
          : [];
      const answer = await requestRmsSnippets(
        target.model,
        target.selection.getStartPosition(),
        sent,
      );
      const builtIn = parseSnippetList(answer);
      const context = parseSnippetContext(answer, sent.length);
      if (snippetDialogSequence.current !== id || snippetTarget.current !== target) return;
      target.context = context;
      const snippets = [
        ...own.map((snippet, index) =>
          ownEditorSnippet(snippet, context.caret, context.previewTokens[index]),
        ),
        ...builtIn,
      ];
      setSnippetDialog((current) =>
        current.id === id ? { ...current, status: 'ready', snippets } : current,
      );
    },
    [],
  );
  const openInsertSnippet = useCallback(() => {
    const instance = editor.current;
    const model = instance?.getModel();
    const selection = instance?.getSelection();
    if (!instance || !model || !selection) return;
    if (
      !insertSnippetAvailable(model.getLanguageId(), workspaceRef.current.activeDocument.readOnly)
    )
      return;
    const id = ++snippetDialogSequence.current;
    snippetTarget.current = {
      model,
      selection,
      version: model.getAlternativeVersionId(),
      context: null,
    };
    snippetChoice.current = null;
    setSnippetDialog({ id, open: true, status: 'loading', snippets: [] });
    loadSnippets(id).catch(() => {
      setSnippetDialog((current) =>
        current.id === id ? { ...current, status: 'failed' } : current,
      );
    });
  }, [loadSnippets]);
  const closeSnippetDialog = useCallback(
    (choice: { snippet: EditorSnippet; mode: SnippetPlacementMode } | null) => {
      snippetChoice.current = choice;
      setSnippetDialog((current) => (current.open ? { ...current, open: false } : current));
    },
    [],
  );
  const snippetPlacementFor = useCallback((snippet: EditorSnippet): SnippetPlacement => {
    const context = snippetTarget.current?.context;
    return context
      ? snippetPlacement(snippet.sections, context.caret, context.sections)
      : { kind: 'caret' };
  }, []);
  const ownSnippetsChanged = useCallback(
    (own: OwnSnippet[]) => {
      const id = snippetDialogSequence.current;
      const caret = snippetTarget.current?.context?.caret ?? { section: null, statement: true };
      setSnippetDialog((current) =>
        current.id === id
          ? {
              ...current,
              snippets: [
                ...own.map((snippet) => ownEditorSnippet(snippet, caret)),
                ...current.snippets.filter((snippet) => !snippet.own),
              ],
            }
          : current,
      );
      void loadSnippets(id, own).catch(() => undefined);
    },
    [loadSnippets],
  );

  const [saveSnippetDialog, setSaveSnippetDialog] = useState<SaveSnippetDialogState>({
    id: 0,
    open: false,
    previousName: null,
    initial: { name: '', section: anySnippetSection, description: '', body: '' },
    existing: [],
  });
  const openSaveSnippet = useCallback(async () => {
    const instance = editor.current;
    const model = instance?.getModel();
    const selection = instance?.getSelection();
    if (!instance || !model || !selection) return;
    if (!saveSnippetAvailable(model.getLanguageId(), workspaceRef.current.activeDocument.readOnly))
      return;
    const body = selection.isEmpty()
      ? ''
      : snippetTextFromSelection(
          model.getValueInRange(selection, monaco.editor.EndOfLinePreference.LF),
          model.getValueInRange({
            startLineNumber: selection.startLineNumber,
            startColumn: 1,
            endLineNumber: selection.startLineNumber,
            endColumn: selection.startColumn,
          }),
        );
    const [existing, section] = await Promise.all([
      window.rmside.listOwnSnippets().catch(() => [] as OwnSnippet[]),
      selectionSection(model, selection.getStartPosition()),
    ]);
    if (editor.current !== instance || instance.getModel() !== model) return;
    setSaveSnippetDialog((current) => ({
      id: current.id + 1,
      open: true,
      previousName: null,
      initial: { name: '', section, description: '', body },
      existing,
    }));
  }, []);
  const closeSaveSnippetDialog = useCallback(() => {
    setSaveSnippetDialog((current) => (current.open ? { ...current, open: false } : current));
    editor.current?.focus();
  }, []);

  useEffect(() => {
    const instance = editor.current;
    if (!instance) return undefined;
    const openIncludeAction = instance.addAction({
      id: 'rmside.openIncludedFileAtCursor',
      label: t('code-editor.context-menu.open-included-file'),
      precondition: cursorOnIncludeContextKey,
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0.5,
      run: async (current) => {
        const model = current.getModel();
        const position = current.getPosition();
        if (!model || !position) return;
        const link = await includeLinkAtPosition(model, position);
        if (link?.target) {
          await openIncludedFile(link.target);
        } else if (link) {
          current.trigger('rmside.open-included-file', 'editor.action.showHover', null);
        }
      },
    });
    const insertSnippetAction = instance.addAction({
      id: insertSnippetActionId,
      label: t('code-editor.context-menu.insert-snippet'),
      precondition: "editorLangId == 'rms' && !editorReadonly",
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1.4,
      run: () => openInsertSnippet(),
    });
    const saveSnippetAction = instance.addAction({
      id: saveSnippetActionId,
      label: t('code-editor.context-menu.save-snippet'),
      precondition: "editorLangId == 'rms' && !editorReadonly",
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1.5,
      run: () => void openSaveSnippet(),
    });
    return () => {
      openIncludeAction.dispose();
      insertSnippetAction.dispose();
      saveSnippetAction.dispose();
    };
  }, [openInsertSnippet, openSaveSnippet, t]);

  const snippetsAvailable = insertSnippetAvailable(
    sourceLanguageIdForName(workspace.activeDocument.name),
    workspace.activeDocument.readOnly,
  );
  useEffect(() => {
    void window.rmside.syncInsertSnippetAvailable(snippetsAvailable).catch(() => undefined);
  }, [snippetsAvailable]);
  useEffect(() => subscribeInsertSnippetRequests(openInsertSnippet), [openInsertSnippet]);
  useEffect(() => subscribeSaveSnippetRequests(() => void openSaveSnippet()), [openSaveSnippet]);

  const activeReadOnly = workspace.activeDocument.readOnly;
  useEffect(() => {
    const instance = editor.current;
    if (!instance) return undefined;
    let synced: boolean | null = null;
    const sync = () => {
      const available = saveSnippetAvailable(
        instance.getModel()?.getLanguageId() ?? null,
        activeReadOnly,
      );
      if (available === synced) return;
      synced = available;
      void window.rmside.syncSaveSnippetAvailable(available).catch(() => undefined);
    };
    sync();
    const subscriptions = [
      instance.onDidChangeModel(sync),
      instance.onDidChangeModelLanguage(sync),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
    };
  }, [activeReadOnly]);

  useEffect(() => {
    if (snippetDialog.open || snippetDialog.id === 0) return;
    const instance = editor.current;
    const target = snippetTarget.current;
    const choice = snippetChoice.current;
    snippetTarget.current = null;
    snippetChoice.current = null;
    if (!instance) return;
    instance.focus();
    if (!choice || !target || target.model.isDisposed() || instance.getModel() !== target.model) {
      return;
    }
    const { snippet, mode } = choice;
    const placement: SnippetPlacement =
      mode !== 'caret' && target.context
        ? snippetPlacement(snippet.sections, target.context.caret, target.context.sections)
        : { kind: 'caret' };
    if (
      placement.kind === 'caret' ||
      target.version !== target.model.getAlternativeVersionId() ||
      !target.context
    ) {
      insertEditorSnippet(instance, target.selection, snippet.insertText);
      return;
    }
    insertEditorSnippetAt(
      instance,
      snippetEdit(
        target.model.getLinesContent(),
        target.context.sections,
        placement.section,
        mode === 'create-section' ? 'create-section' : 'section-end',
        snippet.insertText,
      ),
    );
  }, [snippetDialog.id, snippetDialog.open]);

  useEffect(() => {
    monaco.editor.setTheme(
      editorTheme(resolvedTheme, workspace.activeDocument.name, editorColorScheme),
    );
  }, [editorColorScheme, resolvedTheme, workspace.activeDocument.name]);

  useEffect(() => {
    editor.current?.updateOptions({
      inlayHints: { enabled: inlayHints ? 'on' : 'offUnlessPressed', padding: true },
    });
  }, [inlayHints]);

  useEffect(() => {
    rebuildOutline.current();
  }, [outlineRow]);

  const revealOutlineEntry = useCallback((entry: OutlineEntry) => {
    const instance = editor.current;
    const model = instance?.getModel();
    if (!instance || !model) return;
    const lineNumber = Math.min(Math.max(1, entry.line + 1), model.getLineCount());
    const position = {
      lineNumber,
      column: Math.min(Math.max(1, entry.character + 1), model.getLineMaxColumn(lineNumber)),
    };
    instance.setPosition(position, 'outline-row');
    instance.revealPositionInCenter(position);
    instance.focus();
  }, []);
  const focusEditorAfterOutline = useCallback(() => editor.current?.focus(), []);

  const outlineRowLaidOut = useRef(outlineRowPresent);
  useLayoutEffect(() => {
    if (outlineRowLaidOut.current === outlineRowPresent) return;
    outlineRowLaidOut.current = outlineRowPresent;
    const instance = editor.current;
    const position = instance?.getPosition();
    if (!instance || !position) return;
    const caretInView = instance
      .getVisibleRanges()
      .some((range) => range.containsPosition(position));
    instance.layout();
    if (caretInView) instance.revealPosition(position, monaco.editor.ScrollType.Immediate);
  }, [outlineRowPresent]);

  const outlineRowFloats = previewLayout === 'behind-editor' && outlineRowPresent;
  useEffect(() => {
    editor.current?.updateOptions({
      padding: { top: 16, bottom: outlineRowFloats ? editorOutlineRowHeight : 0 },
    });
  }, [outlineRowFloats]);

  const onShowEditorRef = useRef(onShowEditor);
  onShowEditorRef.current = onShowEditor;
  const editorShownRef = useRef(editorShown);
  editorShownRef.current = editorShown;
  const shownRevealSequence = useRef(workspace.revealSequence);
  useEffect(() => {
    if (shownRevealSequence.current === workspace.revealSequence) return;
    shownRevealSequence.current = workspace.revealSequence;
    if (!editorShownRef.current) onShowEditorRef.current();
  }, [workspace.revealSequence]);
  const shownSelection = useRef(selection);
  useEffect(() => {
    if (shownSelection.current === selection) return;
    shownSelection.current = selection;
    if (selection && !editorShownRef.current) onShowEditorRef.current();
  }, [selection]);
  const focusEditorWhenShown = useRef(false);
  useLayoutEffect(() => {
    if (!editorShown) return;
    editor.current?.layout();
    if (!focusEditorWhenShown.current) return;
    focusEditorWhenShown.current = false;
    editor.current?.focus();
  }, [editorShown]);
  const pressEditorTabTrigger = (documentId: string) => {
    const outcome = editorTabPressOutcome(
      previewLayout,
      editorShown,
      documentId === workspace.activeDocumentId,
    );
    if (outcome === 'hide-editor') {
      onHideEditor();
      focusEditorTab(tabList.current, documentId);
      return;
    }
    workspace.setActiveDocument(documentId);
    if (outcome === 'show-editor') {
      focusEditorWhenShown.current = true;
      onShowEditor();
    }
  };

  useEffect(() => {
    updateSourceHighlight.current();
  }, [workspace.activeDocument.uri, workspace.activeDocument.name, workspace.activeDocumentId]);

  useEffect(() => () => setEditorPointerInside(false), [setEditorPointerInside]);

  const revealedSelection = useRef<typeof selection>(null);
  useEffect(() => {
    const instance = editor.current;
    const model = instance?.getModel();
    const pending = pendingSelectionReveal(
      selection,
      revealedSelection.current,
      model?.uri.toString() ?? null,
      (uri) => monaco.Uri.parse(uri).toString(),
    );
    if (!instance || !model || !pending) return;
    revealedSelection.current = pending;
    if (pending.find) {
      if (pending.findNext) {
        const find = pending.find;
        instance.focus();
        void moveEditorFindToNextMatch(instance, find).then((moved) => {
          if (instance.getModel() !== model) return;
          if (!moved) {
            const next = model.findNextMatch(
              find.query,
              instance.getSelection()?.getEndPosition() ?? { lineNumber: 1, column: 1 },
              false,
              find.matchCase,
              find.wholeWord ? instance.getOption(monaco.editor.EditorOption.wordSeparators) : null,
              false,
            );
            if (next) instance.setSelection(next.range);
          }
          const selected = instance.getSelection();
          if (selected) instance.revealRangeInCenter(selected);
        });
        return;
      }
      const range =
        firstFindMatch(
          model,
          pending.find,
          instance.getOption(monaco.editor.EditorOption.wordSeparators),
        ) ?? new monaco.Range(1, 1, 1, 1);
      instance.setSelection(range);
      instance.revealRangeInCenter(range);
      instance.focus();
      void openEditorFind(instance, pending.find);
      return;
    }
    const start = model.getPositionAt(pending.utf16StartOffset);
    const end = model.getPositionAt(pending.utf16EndOffset);
    instance.setSelection(
      new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
    );
    instance.revealPositionInCenter(start);
    instance.focus();
  }, [selection, workspace.activeDocumentId]);

  return (
    <section
      className="panel editor-panel"
      aria-label={t('code-editor.panel.label')}
      data-execution-failure-sequence={executionFailureSequence}
      data-outline-row={outlineRowPresent || undefined}
    >
      <div className="editor-tabs-shell">
        <div className="editor-tabs-viewport">
          <ContextMenu onOpenChange={setTabMenuOpen}>
            <ContextMenuTrigger
              aria-label={t('code-editor.tabs.label')}
              className="editor-tabs"
              data-suppress-hover={tabHoverSuppressed || undefined}
              data-tab-dragging={draggingTabId ? 'true' : undefined}
              onPointerLeave={() => {
                if (draggedTabId.current) return;
                tabHoverSuppressionAnchor.current = null;
                setTabHoverSuppressed(false);
              }}
              onPointerMove={(event) => {
                const anchor = tabHoverSuppressionAnchor.current;
                if (!tabHoverSuppressed || draggedTabId.current || !anchor) return;
                if (Math.hypot(event.clientX - anchor.x, event.clientY - anchor.y) <= 4) return;
                tabHoverSuppressionAnchor.current = null;
                setTabHoverSuppressed(false);
              }}
              onScroll={() => {
                updateTabScrollState();
                drawTabDrag();
              }}
              ref={tabList}
              role="tablist"
            >
              {workspace.documents.map((document) => (
                <div
                  className="editor-tab"
                  data-active={editorShown && document.id === workspace.activeDocumentId}
                  data-dirty={document.dirty}
                  data-document-id={document.id}
                  data-dragging={draggingTabId === document.id || undefined}
                  data-closing={closingTabIds.has(document.id) || undefined}
                  data-preview={document.preview}
                  key={document.id}
                  onClickCapture={(event) => {
                    if (!tabClickSuppressed.current || event.detail === 0) return;
                    tabClickSuppressed.current = false;
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onContextMenu={() => workspace.setActiveDocument(document.id)}
                  onPointerDown={pressEditorTab}
                  onPointerEnter={() => setHoveredTabId(document.id)}
                  onPointerLeave={() =>
                    setHoveredTabId((current) => (current === document.id ? null : current))
                  }
                >
                  <Tooltip
                    disabled={draggingTabId !== null || tabMenuOpen || tabHoverSuppressed}
                    disableHoverablePopup
                  >
                    <TooltipTrigger
                      render={
                        <Button
                          aria-description={editorTabDescription(document) ?? undefined}
                          aria-selected={editorShown && document.id === workspace.activeDocumentId}
                          className="editor-tab-trigger"
                          onClick={() => pressEditorTabTrigger(document.id)}
                          onDoubleClick={() => workspace.promoteDocument(document.id)}
                          onKeyDown={(event) => {
                            if (event.ctrlKey || event.metaKey || event.altKey) return;
                            if (event.key === 'Delete') {
                              event.preventDefault();
                              closeTab(document.id);
                              return;
                            }
                            const index = workspace.documents.findIndex(
                              (entry) => entry.id === document.id,
                            );
                            const target = rovingKeyTarget(
                              event.key,
                              index,
                              workspace.documents.length,
                            );
                            if (target === null) return;
                            event.preventDefault();
                            const next = workspace.documents[target];
                            if (!next) return;
                            if (editorShown) workspace.setActiveDocument(next.id);
                            focusEditorTab(tabList.current, next.id);
                          }}
                          role="tab"
                          tabIndex={document.id === workspace.activeDocumentId ? 0 : -1}
                          variant="ghost"
                        />
                      }
                    >
                      {document.readOnly ? <LockKeyhole aria-hidden="true" /> : null}
                      {document.id === pinnedPreviewSource?.id ? (
                        <Play aria-hidden="true" className="editor-tab-pinned-preview" />
                      ) : null}
                      <EditorTabTitle name={document.name} />
                    </TooltipTrigger>
                    <TooltipContent className="path-tooltip">
                      {document.path ?? document.name}
                    </TooltipContent>
                  </Tooltip>
                  <EditorTabCloseButton
                    active={editorShown && document.id === workspace.activeDocumentId}
                    closing={closingTabIds.has(document.id)}
                    dirty={document.dirty}
                    name={document.name}
                    onClose={() => closeTab(document.id)}
                    visible={
                      document.dirty ||
                      (editorShown && document.id === workspace.activeDocumentId) ||
                      (!tabHoverSuppressed && hoveredTabId === document.id)
                    }
                  />
                </div>
              ))}
            </ContextMenuTrigger>
            <ContextMenuContent>
              {editionCapabilities.deployment &&
              isPreviewScriptName(workspace.activeDocument.name) ? (
                <>
                  <ContextMenuItem
                    onClick={() => openManagedModDeployment(workspace.activeDocument.id)}
                  >
                    {t('code-editor.tab-menu.deploy')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              ) : null}
              {workspace.activeDocument.readOnly ? null : (
                <ContextMenuItem onClick={() => void workspace.saveActive()}>
                  {t('code-editor.tab-menu.save')}
                </ContextMenuItem>
              )}
              <ContextMenuItem onClick={() => void workspace.saveActiveAs()}>
                {t('code-editor.tab-menu.save-as')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => {
                  closeTab(workspace.activeDocumentId);
                }}
              >
                {t('code-editor.tab-menu.close')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          {tabScrollState.left ? (
            <div className="editor-tabs-scroll-overlay editor-tabs-scroll-overlay-left">
              <Button
                aria-label={t('code-editor.tabs.scroll-left')}
                className="editor-tabs-scroll"
                onClick={() => scrollTabs(-1)}
                size="icon-compact"
                variant="ghost"
              >
                <ChevronLeft />
              </Button>
            </div>
          ) : null}
          {tabScrollState.right ? (
            <div className="editor-tabs-scroll-overlay editor-tabs-scroll-overlay-right">
              <Button
                aria-label={t('code-editor.tabs.scroll-right')}
                className="editor-tabs-scroll"
                onClick={() => scrollTabs(1)}
                size="icon-compact"
                variant="ghost"
              >
                <ChevronRight />
              </Button>
            </div>
          ) : null}
        </div>
        {editionCapabilities.preview ? (
          <>
            <div className="preview-run-controls">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      {...(previewExecution?.canRun && !executionActive
                        ? runIcon.animationHandlers
                        : {})}
                      aria-disabled={!executionActive && !previewExecution?.canRun}
                      aria-label={runActionLabel}
                      className="preview-run-button"
                      data-completion-animation-sequence={runCompletionAnimationSequence}
                      data-running={executionActive || undefined}
                      data-stopping={
                        previewExecution?.executionState.phase === 'stopping' || undefined
                      }
                      onClick={() => {
                        if (!previewExecution) return;
                        if (executionActive) previewExecution.stop();
                        else if (previewExecution.canRun) previewExecution.run();
                        else previewExecution.explainBlockedRun?.();
                      }}
                      size="icon-compact"
                      variant="ghost"
                    />
                  }
                >
                  {executionActive ? (
                    <>
                      <RunningIndicator
                        className="preview-run-spinner"
                        ref={runIcon.iconRef}
                        size={14}
                        testId="preview-run-spinner"
                      />
                      <Square
                        aria-hidden="true"
                        className="preview-run-stop"
                        data-testid="preview-run-stop"
                        fill="none"
                        size={11}
                      />
                    </>
                  ) : (
                    <HoverScaleIcon ref={runIcon.iconRef}>
                      <PlayIcon aria-hidden="true" ref={runSwitchIcon} size={14} />
                    </HoverScaleIcon>
                  )}
                </TooltipTrigger>
                <TooltipContent side="bottom">{runActionTooltip}</TooltipContent>
              </Tooltip>
              <DropdownMenu key={workspace.activeDocument.id} modal={false}>
                <DropdownMenuTrigger
                  render={
                    <Button
                      aria-label={t('code-editor.run-menu.label')}
                      className="preview-run-menu-trigger"
                      size="icon-compact"
                      variant="ghost"
                    />
                  }
                >
                  <ChevronDown aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="preview-run-menu">
                  <div className="preview-run-automation-row">
                    <ToggleButton
                      check={false}
                      checked={previewExecution?.runOnSave ?? false}
                      className="preview-run-automation preview-run-on-save"
                      onClick={(event) => {
                        event.stopPropagation();
                        previewExecution?.toggleRunOnSave();
                      }}
                    >
                      <span className="preview-run-automation-label">
                        <Save aria-hidden="true" />
                        <OverflowingLabel
                          className="preview-run-automation-text"
                          name={t('run-menu.run-on-save')}
                          revealOnParentFocus
                          textClassName="preview-run-automation-text-inner"
                        />
                      </span>
                    </ToggleButton>
                    <ToggleButton
                      check={false}
                      checked={previewExecution?.runOnEdit ?? false}
                      className="preview-run-automation preview-run-on-edit"
                      onClick={(event) => {
                        event.stopPropagation();
                        previewExecution?.toggleRunOnEdit();
                      }}
                    >
                      <span className="preview-run-automation-label">
                        <FilePen aria-hidden="true" />
                        <OverflowingLabel
                          className="preview-run-automation-text"
                          name={t('run-menu.run-on-edit')}
                          revealOnParentFocus
                          textClassName="preview-run-automation-text-inner"
                        />
                      </span>
                    </ToggleButton>
                  </div>
                  <div className="preview-run-source-row">
                    <div className="preview-run-source-field">
                      <Input
                        aria-label={t('code-editor.run-menu.executed-script')}
                        className="preview-run-source"
                        disabled
                        value={displayedExecutionName}
                      />
                      <OverflowingLabel
                        className="preview-run-source-label"
                        name={displayedExecutionName}
                        textClassName="preview-run-source-label-text"
                      />
                    </div>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <IconToggleButton
                            aria-disabled={!pinnedPreviewSource && !activeDocumentCanBePinned}
                            aria-label={t('code-editor.run-menu.pin')}
                            className="preview-run-pin"
                            data-pinned={Boolean(pinnedPreviewSource)}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (!pinnedPreviewSource && !activeDocumentCanBePinned) return;
                              setPinnedPreviewSource(
                                pinnedPreviewSource
                                  ? null
                                  : {
                                      id: workspace.activeDocument.id,
                                      uri: workspace.activeDocument.uri,
                                      name: workspace.activeDocument.name,
                                      content: workspace.activeDocument.content,
                                    },
                              );
                            }}
                            pressed={Boolean(pinnedPreviewSource)}
                            size="icon-compact"
                          />
                        }
                      >
                        <Pin aria-hidden="true" />
                      </TooltipTrigger>
                      <TooltipContent>{t('code-editor.run-menu.pin')}</TooltipContent>
                    </Tooltip>
                  </div>
                  <div className="preview-run-seed-row">
                    <PreviewSeedField previewExecution={previewExecution} />
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <IconToggleButton
                            aria-disabled={!previewSeedControls(previewExecution).modeToggleable}
                            aria-label={t(
                              previewSeedLocked
                                ? 'code-editor.run-menu.seed-locked'
                                : 'code-editor.run-menu.seed-lock',
                            )}
                            className="preview-run-seed-mode"
                            data-randomize={!previewSeedLocked || undefined}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (!previewSeedControls(previewExecution).modeToggleable) return;
                              previewExecution?.toggleSeedMode();
                            }}
                            pressed={previewSeedLocked}
                            size="icon-compact"
                          />
                        }
                      >
                        {previewSeedLocked ? (
                          <LockKeyhole aria-hidden="true" />
                        ) : (
                          <LockKeyholeOpen aria-hidden="true" />
                        )}
                      </TooltipTrigger>
                      <TooltipContent>
                        {t(
                          previewSeedLocked
                            ? 'code-editor.run-menu.seed-locked'
                            : 'code-editor.run-menu.seed-lock',
                        )}
                      </TooltipContent>
                    </Tooltip>
                    {liveControlReady ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              aria-disabled={!previewExecution?.canAdoptMatchSeed}
                              aria-label={t('code-editor.run-menu.adopt-seed')}
                              className="preview-run-adopt-seed"
                              onClick={(event) => {
                                event.stopPropagation();
                                if (previewExecution?.canAdoptMatchSeed) {
                                  previewExecution.adoptMatchSeed?.();
                                }
                              }}
                              size="icon-compact"
                              type="button"
                              variant="ghost"
                            />
                          }
                        >
                          <Gamepad2 aria-hidden="true" />
                        </TooltipTrigger>
                        <TooltipContent>
                          {seedAdoptionReason ?? t('code-editor.run-menu.adopt-seed')}
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                  </div>
                  {isMapTestScriptName(workspace.activeDocument.name) ? (
                    previewExecution?.setMapTestWorkers ? (
                      <MapTestWorkersField previewExecution={previewExecution} />
                    ) : null
                  ) : (
                    <div className="preview-run-live-row">
                      {!gameInstallationReady ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <SelectGameFolderButton
                                aria-disabled={gameInstallationBusy}
                                className="preview-run-select-game"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (!gameInstallationBusy) previewExecution?.selectGameFolder?.();
                                }}
                                selecting={gameInstallationSelectionBusy}
                              />
                            }
                          />
                          <TooltipContent>
                            {t(
                              gameInstallationSelectionBusy
                                ? 'code-editor.run-menu.game-folder.selecting'
                                : gameInstallationBusy
                                  ? 'code-editor.run-menu.game-folder.looking'
                                  : 'code-editor.run-menu.game-folder.select',
                            )}
                          </TooltipContent>
                        </Tooltip>
                      ) : liveControl?.configured ? (
                        <>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  {...toggleButtonProps({
                                    checked: liveTestOnRun,
                                    className: 'preview-run-automation preview-run-live-toggle',
                                  })}
                                  aria-disabled={!liveControlReady}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    if (liveControlReady) previewExecution?.toggleLiveTestOnRun();
                                  }}
                                />
                              }
                            >
                              <span className="preview-run-automation-label">
                                <MonitorPlay aria-hidden="true" />
                                <OverflowingLabel
                                  className="preview-run-automation-text"
                                  name={t('code-editor.run-menu.live-test-on-run')}
                                  revealOnParentFocus
                                  textClassName="preview-run-automation-text-inner"
                                />
                              </span>
                              <ToggleButtonCheck checked={liveTestOnRun} />
                            </TooltipTrigger>
                            <TooltipContent>
                              {liveControlReady
                                ? t('code-editor.run-menu.live-test-on-run.tooltip')
                                : (liveControl.detail ?? t('code-editor.run-menu.control.invalid'))}
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  aria-disabled={!liveControlAction.available || undefined}
                                  aria-label={liveControlActionLabel}
                                  className="preview-run-live-action"
                                  data-control-action={liveControlAction.kind}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    if (!liveControlAction.available) return;
                                    if (liveControlAction.kind === 'detach') {
                                      previewExecution?.detachControl?.();
                                    } else {
                                      void confirmRemoveControl();
                                    }
                                  }}
                                  size="icon-compact"
                                  type="button"
                                  variant="ghost"
                                />
                              }
                            >
                              {liveControlAction.kind === 'detach' ? (
                                <Unplug aria-hidden="true" />
                              ) : (
                                <X aria-hidden="true" />
                              )}
                            </TooltipTrigger>
                            <TooltipContent>{liveControlActionTooltip}</TooltipContent>
                          </Tooltip>
                        </>
                      ) : (
                        <>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  aria-disabled={controlSelectionBusy}
                                  className="preview-run-automation preview-run-select-control"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    if (!controlSelectionBusy) previewExecution?.selectControl?.();
                                  }}
                                  size="sm"
                                  type="button"
                                  variant="ghost"
                                />
                              }
                            >
                              <span className="preview-run-automation-label">
                                <FolderOpen aria-hidden="true" />
                                <span>
                                  {t(
                                    controlSelectionBusy
                                      ? 'code-editor.run-menu.control.selecting'
                                      : 'code-editor.run-menu.control.select',
                                  )}
                                </span>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {t(
                                controlSelectionBusy
                                  ? 'code-editor.run-menu.control.selecting-tooltip'
                                  : 'code-editor.run-menu.control.select-tooltip',
                              )}
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  aria-label={t('code-editor.run-menu.control.download')}
                                  className="preview-run-live-action"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void openControlReleases();
                                  }}
                                  size="icon-compact"
                                  type="button"
                                  variant="ghost"
                                />
                              }
                            >
                              <Download aria-hidden="true" />
                            </TooltipTrigger>
                            <TooltipContent>
                              {t('code-editor.run-menu.control.releases')}
                            </TooltipContent>
                          </Tooltip>
                        </>
                      )}
                    </div>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <AlertDialog
                onOpenChange={setControlDownloadNoticeOpen}
                open={controlDownloadNoticeOpen}
              >
                <AlertDialogContent initialFocus={true}>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('code-editor.control-download.title')}</AlertDialogTitle>
                    <AlertDialogDescription>
                      <ControlDownloadDescription />
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogAction onClick={() => setControlDownloadNoticeOpen(false)}>
                      {t('code-editor.control-download.confirm')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    {...previewIcon.animationHandlers}
                    aria-label={t(previewLayoutButtons[previewLayout].labelId)}
                    className="preview-toggle"
                    data-expanded={previewExpanded}
                    data-layout={previewLayout}
                    onClick={onCyclePreviewLayout}
                    size="icon-compact"
                    variant="ghost"
                  />
                }
              >
                {previewLayoutButtons[previewLayout].renderIcon(previewIcon.iconRef)}
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t(previewLayoutButtons[previewLayout].labelId)}
              </TooltipContent>
            </Tooltip>
          </>
        ) : null}
      </div>
      <div
        className="editor-body"
        data-shown={editorShown}
        data-testid="editor-body"
        inert={!editorShown ? true : undefined}
      >
        <div className="monaco-host" onMouseDownCapture={openCommentLink}>
          <div
            className="monaco-editor-mount"
            dir="ltr"
            onPointerEnter={() => setEditorPointerInside(true)}
            onPointerLeave={() => setEditorPointerInside(false)}
            ref={container}
          />
          <EditorContextMenu />
          <InsertSnippetDialog
            colors={colorSchemeById(editorColorScheme)[resolvedTheme]}
            onClose={() => closeSnippetDialog(null)}
            onInsert={(snippet, mode) => closeSnippetDialog({ snippet, mode })}
            onOwnSnippetsChanged={ownSnippetsChanged}
            placementFor={snippetPlacementFor}
            state={snippetDialog}
          />
          <SaveSnippetDialog
            onClose={closeSaveSnippetDialog}
            onSaved={closeSaveSnippetDialog}
            state={saveSnippetDialog}
          />
          {editorNoticePresence.mounted &&
          shownEditorNotice === 'execution-failure' &&
          shownExecutionFailure ? (
            <Alert
              className="recovery-notice execution-failure-notice motion-surface"
              data-motion-from="bottom"
              data-testid="execution-failure-notice"
              ref={editorNoticePresence.ref}
              variant="destructive"
              {...executionFailureNoticeHold}
              {...presenceProps(editorNoticePresence.closing)}
            >
              <AlertTitle>{shownExecutionFailure.title}</AlertTitle>
              {shownExecutionFailure.detail ? (
                <AlertDescription data-testid="execution-failure-detail">
                  {shownExecutionFailure.detail}
                </AlertDescription>
              ) : null}
              <Button
                aria-label={t('code-editor.notice.execution-failure.dismiss')}
                onClick={onDismissExecutionFailureNotice}
                size="icon"
                variant="ghost"
              >
                <X />
              </Button>
            </Alert>
          ) : editorNoticePresence.mounted && shownEditorNotice === 'game-textures' ? (
            <Alert
              className="recovery-notice motion-surface"
              data-motion-from="bottom"
              data-testid="game-textures-notice"
              ref={editorNoticePresence.ref}
              {...gameTexturesNoticeHold}
              {...presenceProps(editorNoticePresence.closing)}
            >
              <AlertTitle>{t('code-editor.notice.game-textures')}</AlertTitle>
            </Alert>
          ) : editorNoticePresence.mounted && shownEditorNotice === 'recovery' ? (
            <Alert
              className="recovery-notice motion-surface"
              data-motion-from="bottom"
              data-testid="recovery-notice"
              ref={editorNoticePresence.ref}
              {...recoveryNoticeHold}
              {...presenceProps(editorNoticePresence.closing)}
            >
              <AlertTitle>{t('code-editor.notice.recovery')}</AlertTitle>
              <Button
                aria-label={t('code-editor.notice.recovery.dismiss')}
                onClick={onDismissRecoveryNotice}
                size="icon"
                variant="ghost"
              >
                <X />
              </Button>
            </Alert>
          ) : null}
          <output
            aria-atomic="true"
            aria-label={t('code-editor.font-size.label')}
            aria-live="polite"
            className="editor-font-size-indicator"
            data-visible={fontSizeNotice.visible}
          >
            {t('code-editor.font-size.value', {
              percent: Math.round((fontSizeNotice.fontSize / editorDefaultFontSize) * 100),
            })}
          </output>
        </div>
        {outlineRowPresent ? (
          <EditorOutlineRow
            focusEditor={focusEditorAfterOutline}
            onChoose={revealOutlineEntry}
            outline={outlineView.outline}
            path={outlineView.path}
          />
        ) : null}
      </div>
      <output hidden data-testid="source-reveal">
        {selection
          ? `${selection.uri} — ${selection.marker}`
          : workspace.activeDocument.readOnly
            ? 'Read-only protected source — use Save As to edit'
            : workspace.activeDocument.path
              ? workspace.activeDocument.name
              : 'Unsaved file'}
      </output>
    </section>
  );
}

const maximumColoredPreviews = 1_000_000;

async function selectionSection(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Promise<OwnSnippetSection> {
  try {
    const answer = await Promise.race([
      requestRmsSnippets(model, position),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2_000)),
    ]);
    const section = parseSnippetContext(answer, 0).caret.section;
    return section && section !== anySnippetSection && isOwnSnippetSection(section)
      ? section
      : anySnippetSection;
  } catch {
    return anySnippetSection;
  }
}

function insertEditorSnippetAt(
  instance: monaco.editor.IStandaloneCodeEditor,
  edit: SnippetEdit,
): void {
  const model = instance.getModel();
  if (!model) return;
  const position = model.validatePosition({ lineNumber: edit.lineNumber, column: edit.column });
  instance.setSelection(
    new monaco.Selection(
      position.lineNumber,
      position.column,
      position.lineNumber,
      position.column,
    ),
  );
  const controller = instance.getContribution('snippetController2') as unknown as {
    insert(template: string, options?: { undoStopBefore?: boolean; undoStopAfter?: boolean }): void;
  } | null;
  controller?.insert(edit.template, { undoStopBefore: true, undoStopAfter: true });
  const selection = instance.getSelection();
  if (selection) instance.revealRangeInCenterIfOutsideViewport(selection);
}

function insertEditorSnippet(
  instance: monaco.editor.IStandaloneCodeEditor,
  selection: monaco.Selection,
  text: string,
): void {
  const model = instance.getModel();
  if (!model) return;
  const range = model.validateRange(selection);
  instance.setSelection(
    new monaco.Selection(
      range.startLineNumber,
      range.startColumn,
      range.endLineNumber,
      range.endColumn,
    ),
  );
  const controller = instance.getContribution('snippetController2') as unknown as {
    insert(template: string, options?: { undoStopBefore?: boolean; undoStopAfter?: boolean }): void;
  } | null;
  controller?.insert(text, { undoStopBefore: true, undoStopAfter: true });
  instance.revealPositionInCenterIfOutsideViewport(range.getStartPosition());
}
