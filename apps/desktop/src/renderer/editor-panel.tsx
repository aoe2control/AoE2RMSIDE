import { outputNote } from '../shared/output-message';
import type { RootExecutionPhase } from '../shared/api';
import { SourceStructureRequest } from './source-structure-request';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  CheckIcon as AnimatedCheckIcon,
  MapIcon,
  PlayIcon,
  XIcon,
} from '@animateicons/react/lucide';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Cpu,
  Download,
  Dices,
  FilePen,
  FolderOpen,
  Gamepad2,
  LockKeyhole,
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
import { rovingKeyTarget } from './keyboard-navigation';
import { useI18n } from './i18n';
import { t as translate } from '../shared/i18n/translator';
import type { LiveControlAction } from './live-control-action';
import { useAppPanelContext } from './app-context';
import { wordBasedSuggestionsFor } from './completion-filter';
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
  requestRmsSourceStructure,
  rmsConditionalIndentation,
  setIncludedFileOpener,
  setLanguageEditGuard,
} from './monaco-language';
import { cursorOnIncludeContextKey, joinConcurrentOpens } from './include-navigation';
import { sourceLanguageIdForName } from '../shared/xs-contract';
import { bracketColorizationFor } from './rms-language';
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

const monacoThemes = {
  light: 'rmside-light',
  dark: 'rmside-dark',
} as const;
const mapTestLightModernTheme = 'rmside-map-test-light-modern';
const mapTestDarkModernTheme = 'rmside-map-test-dark-modern';

const visualStudioSyntaxRules = {
  light: [
    { token: '', foreground: '000000' },
    { token: 'comment', foreground: '008000' },
    { token: 'keyword', foreground: '808080' },
    { token: 'control', foreground: '8F08C4' },
    { token: 'namespace', foreground: '2B91AF' },
    { token: 'function', foreground: '74531F' },
    { token: 'property', foreground: '000000' },
    { token: 'number', foreground: '098658' },
    { token: 'string', foreground: 'A31515' },
    { token: 'variable', foreground: '1F377F' },
    { token: 'operator', foreground: '000000' },
    { token: 'keyword.python', foreground: '0000FF' },
    { token: 'comment.python', foreground: '008000' },
    { token: 'string.python', foreground: 'A31515' },
    { token: 'number.python', foreground: '098658' },
  ],
  dark: [
    { token: '', foreground: 'C8C8C8' },
    { token: 'comment', foreground: '57A64A' },
    { token: 'keyword', foreground: '9A9A9A' },
    { token: 'control', foreground: 'D8A0DF' },
    { token: 'namespace', foreground: '4EC9B0' },
    { token: 'function', foreground: 'DCDCAA' },
    { token: 'property', foreground: 'DADADA' },
    { token: 'number', foreground: 'B5CEA8' },
    { token: 'string', foreground: 'D69D85' },
    { token: 'variable', foreground: '9CDCFE' },
    { token: 'operator', foreground: 'B4B4B4' },
    { token: 'keyword.python', foreground: '569CD6' },
    { token: 'comment.python', foreground: '6A9955' },
    { token: 'string.python', foreground: 'CE9178' },
    { token: 'number.python', foreground: 'B5CEA8' },
  ],
} satisfies Record<keyof typeof monacoThemes, monaco.editor.ITokenThemeRule[]>;

const lightModernMapTestSyntaxRules: monaco.editor.ITokenThemeRule[] = [
  { token: '', foreground: '000000' },
  { token: 'function', foreground: '795E26' },
  { token: 'property', foreground: '000000' },
  { token: 'identifier.python', foreground: '001080' },
  { token: 'type.identifier.python', foreground: '267F99' },
  { token: 'tag.python', foreground: '795E26' },
  { token: 'keyword.python', foreground: '0000FF' },
  { token: 'comment.python', foreground: '008000' },
  { token: 'string.python', foreground: 'A31515' },
  { token: 'number.python', foreground: '098658' },
  { token: 'delimiter.python', foreground: '000000' },
  { token: 'operator.python', foreground: '000000' },
  { token: 'invalid.python', foreground: 'CD3131' },
];
const darkModernMapTestSyntaxRules: monaco.editor.ITokenThemeRule[] = [
  { token: '', foreground: 'CCCCCC' },
  { token: 'function', foreground: 'DCDCAA' },
  { token: 'property', foreground: 'DADADA' },
  { token: 'identifier.python', foreground: '9CDCFE' },
  { token: 'type.identifier.python', foreground: '4EC9B0' },
  { token: 'tag.python', foreground: 'DCDCAA' },
  { token: 'keyword.python', foreground: '569CD6' },
  { token: 'comment.python', foreground: '6A9955' },
  { token: 'string.python', foreground: 'CE9178' },
  { token: 'number.python', foreground: 'B5CEA8' },
  { token: 'delimiter.python', foreground: 'CCCCCC' },
  { token: 'operator.python', foreground: 'D4D4D4' },
  { token: 'invalid.python', foreground: 'F44747' },
];

function editorTheme(theme: keyof typeof monacoThemes, documentName: string): string {
  if (!isMapTestScriptName(documentName)) return monacoThemes[theme];
  return theme === 'dark' ? mapTestDarkModernTheme : mapTestLightModernTheme;
}

const editorDefaultFontSize = 14;
const editorFontSizeNoticeDelayMilliseconds = 2_000;
const editorTabDragMime = 'application/x-rmside-editor-tab';
const editorTabMovementAnimationId = 'rmside-tab-movement';
const editorTabOpenAnimationId = 'rmside-tab-open';
const seedCopiedFeedbackMilliseconds = 1_000;

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
      draggable={false}
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
        <TooltipTrigger render={<span className="preview-run-workers-label" tabIndex={-1} />}>
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
  const checkIconRef = useRef<AnimatedIconHandle>(null);
  const copiedTimer = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
  const { copyable, editable: seedEditable } = previewSeedControls(previewExecution);
  const seed = previewExecution?.seed ?? 0;
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

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  useEffect(() => {
    setCopied(false);
  }, [copyable, seed]);

  useLayoutEffect(() => {
    if (copied) playIconAnimation(checkIconRef.current);
  }, [copied]);

  const copySeed = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!copyable) return;
    try {
      await navigator.clipboard.writeText(String(seed));
    } catch {
      return;
    }
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => {
      copiedTimer.current = null;
      setCopied(false);
    }, seedCopiedFeedbackMilliseconds);
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
            {copied ? (
              <AnimatedCheckIcon aria-hidden="true" ref={checkIconRef} size={14} />
            ) : (
              <Copy aria-hidden="true" size={14} />
            )}
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
      name={name}
      textClassName="editor-tab-title-text"
    />
  );
}

const bracketNestingColors = {
  light: {
    'editorBracketHighlight.foreground1': '#0431FA',
    'editorBracketHighlight.foreground2': '#319331',
    'editorBracketHighlight.foreground3': '#7B3814',
    'editorBracketHighlight.unexpectedBracket.foreground': '#CC0B0B',
  },
  dark: {
    'editorBracketHighlight.foreground1': '#FFD700',
    'editorBracketHighlight.foreground2': '#DA70D6',
    'editorBracketHighlight.foreground3': '#179FFF',
    'editorBracketHighlight.unexpectedBracket.foreground': '#FF1212CC',
  },
} as const;

function defineRmsideThemes(): void {
  monaco.editor.defineTheme(monacoThemes.light, {
    base: 'vs',
    inherit: true,
    rules: visualStudioSyntaxRules.light,
    colors: {
      focusBorder: '#00000000',
      'inputOption.activeBorder': '#00000000',
      'editorOverviewRuler.border': '#00000000',
      'editor.background': '#f1f1f1',
      'editor.foreground': '#000000',
      'editor.lineHighlightBackground': '#e8e8e8',
      'editor.selectionBackground': '#cacaca',
      'editor.inactiveSelectionBackground': '#d8d8d8',
      ...bracketNestingColors.light,
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
  });
  monaco.editor.defineTheme(monacoThemes.dark, {
    base: 'vs-dark',
    inherit: true,
    rules: visualStudioSyntaxRules.dark,
    colors: {
      focusBorder: '#00000000',
      'inputOption.activeBorder': '#00000000',
      'editorOverviewRuler.border': '#00000000',
      'editor.background': '#171717',
      'editor.foreground': '#c8c8c8',
      'editor.lineHighlightBackground': '#262626',
      'editor.selectionBackground': '#525252',
      'editor.inactiveSelectionBackground': '#404040',
      ...bracketNestingColors.dark,
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
  });
  monaco.editor.defineTheme(mapTestLightModernTheme, {
    base: 'vs',
    inherit: true,
    rules: lightModernMapTestSyntaxRules,
    colors: {
      focusBorder: '#00000000',
      'inputOption.activeBorder': '#00000000',
      'editorOverviewRuler.border': '#00000000',
      'editor.background': '#f1f1f1',
      'editor.foreground': '#000000',
      'editor.lineHighlightBackground': '#e8e8e8',
      'editor.selectionBackground': '#cacaca',
      'editor.inactiveSelectionBackground': '#d8d8d8',
      ...bracketNestingColors.light,
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
  });
  monaco.editor.defineTheme(mapTestDarkModernTheme, {
    base: 'vs-dark',
    inherit: true,
    rules: darkModernMapTestSyntaxRules,
    colors: {
      focusBorder: '#00000000',
      'inputOption.activeBorder': '#00000000',
      'editorOverviewRuler.border': '#00000000',
      'editor.background': '#171717',
      'editor.foreground': '#c8c8c8',
      'editor.lineHighlightBackground': '#262626',
      'editor.selectionBackground': '#525252',
      'editor.inactiveSelectionBackground': '#404040',
      ...bracketNestingColors.dark,
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
  });
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

export function EditorPanel({
  inlayHints,
  executionFailureNotice,
  executionFailureSequence,
  onDismissExecutionFailureNotice,
  previewExpanded,
  recoveryNotice,
  onDismissRecoveryNotice,
  onTogglePreview,
}: {
  inlayHints: boolean;
  executionFailureNotice: ExecutionFailureNoticeContent | null;
  executionFailureSequence: number;
  onDismissExecutionFailureNotice(): void;
  previewExpanded: boolean;
  recoveryNotice: string | null;
  onDismissRecoveryNotice(): void;
  onTogglePreview(): void;
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
  const tabCloseTimers = useRef(new Map<string, number>());
  const tabHoverSuppressionAnchor = useRef<{ x: number; y: number } | null>(null);
  const tabReorderPositions = useRef(new Map<string, DOMRect>());
  const tabListLaidOut = useRef(false);
  const sourceHighlightModel = useRef<{
    model: monaco.editor.ITextModel;
    version: number;
    lines: SourceByteRange[];
    scopes: SourceLineScopes | null;
    structure: SourceStructureRequest<SourceBlockStructure>;
  } | null>(null);
  const updateSourceHighlight = useRef<() => void>(() => undefined);
  const [tabScrollState, setTabScrollState] = useState({ left: false, right: false });
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [closingTabIds, setClosingTabIds] = useState<Set<string>>(new Set());
  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null);
  const [tabHoverSuppressed, setTabHoverSuppressed] = useState(false);
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
  const previewIcon = useAnimatedIconHover();
  const previousRunState = useRef(runState);
  const [runCompletionAnimationSequence, setRunCompletionAnimationSequence] = useState(0);
  const [controlDownloadNoticeOpen, setControlDownloadNoticeOpen] = useState(false);

  useLayoutEffect(() => {
    const previous = previousRunState.current;
    previousRunState.current = runState;
    if (previous === 'running' && runState !== 'running') {
      playIconAnimation(runIcon.iconRef.current);
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

  const blockTabDropInEditor = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes(editorTabDragMime)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'none';
      if (event.type === 'drop') finishTabDrag(event.clientX, event.clientY);
    },
    [finishTabDrag],
  );

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
      fontFamily: "'Cascadia Code', Consolas, monospace",
      fontSize: editorDefaultFontSize,
      fixedOverflowWidgets: true,
      minimap: { enabled: false },
      scrollbar: { horizontalScrollbarSize: 10, useShadows: false, verticalScrollbarSize: 10 },
      model: null,
      mouseWheelZoom: true,
      insertSpaces: true,
      padding: { top: 16 },
      'semanticHighlighting.enabled': true,
      theme: editorTheme(resolvedTheme, workspace.activeDocument.name),
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
        const entry: NonNullable<typeof sourceHighlightModel.current> = {
          model,
          version,
          lines: lineByteRanges(model.getValue()),
          scopes: null,
          structure: new SourceStructureRequest<SourceBlockStructure>({
            request: () => requestRmsSourceStructure(model),
            current: () =>
              sourceHighlightModel.current === entry &&
              !model.isDisposed() &&
              model.getVersionId() === entry.version,
            apply: (structure) => {
              entry.scopes = sourceLineScopes(structure, model.getLineCount());
              if (instance.getModel() === model) refreshSourceHighlight();
            },
            delays: sourceStructureRetryDelays,
            setTimer: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
            clearTimer: (timer) => window.clearTimeout(timer as number),
          }),
        };
        sourceHighlightModel.current = entry;
        current = entry;
        entry.structure.start();
      } else if (current.scopes === null) {
        current.structure.poke();
      }
      const spans = sourceHighlightLineSpans(
        (instance.getSelections() ?? []).map(touchedLines),
        current.scopes,
      );
      highlightPreviewSourceRef.current({
        sourceId: sourceDocument.uri,
        byteRanges: lineSpanByteRanges(current.lines, spans),
      });
    };
    updateSourceHighlight.current = refreshSourceHighlight;
    instance.onDidChangeCursorSelection(refreshSourceHighlight);
    const languageAnswersSubscription = onLanguageAnswersChanged(() => {
      const current = sourceHighlightModel.current;
      if (current && current.scopes === null) current.structure.poke();
    });
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
    editor.current?.updateOptions({
      wordBasedSuggestions: wordBasedSuggestionsFor(editorLanguageId),
      bracketPairColorization: {
        enabled: bracketPairs,
        independentColorPoolPerBracketType: false,
      },
      guides: { bracketPairs: bracketPairs ? 'active' : false, highlightActiveBracketPair: true },
      matchBrackets: 'always',
      readOnly: workspace.activeDocument.readOnly,
      readOnlyMessage: { value: t('code-editor.read-only-message') },
    });
  }, [t, workspace.activeDocument, workspace.activeDocumentId, workspace.documents]);

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
    return () => openIncludeAction.dispose();
  }, [t]);

  useEffect(() => {
    monaco.editor.setTheme(editorTheme(resolvedTheme, workspace.activeDocument.name));
  }, [resolvedTheme, workspace.activeDocument.name]);

  useEffect(() => {
    editor.current?.updateOptions({
      inlayHints: { enabled: inlayHints ? 'on' : 'offUnlessPressed', padding: true },
    });
  }, [inlayHints]);

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
      onPointerEnter={() => setEditorPointerInside(true)}
      onPointerLeave={() => setEditorPointerInside(false)}
    >
      <div className="editor-tabs-shell">
        <div className="editor-tabs-viewport">
          <ContextMenu>
            <ContextMenuTrigger
              aria-label={t('code-editor.tabs.label')}
              className="editor-tabs"
              data-suppress-hover={tabHoverSuppressed || undefined}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(editorTabDragMime)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                if (!event.dataTransfer.types.includes(editorTabDragMime)) return;
                event.preventDefault();
                event.stopPropagation();
                finishTabDrag(event.clientX, event.clientY);
              }}
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
              onScroll={updateTabScrollState}
              ref={tabList}
              role="tablist"
            >
              {workspace.documents.map((document) => (
                <div
                  className="editor-tab"
                  data-active={document.id === workspace.activeDocumentId}
                  data-dirty={document.dirty}
                  data-document-id={document.id}
                  data-dragging={draggingTabId === document.id || undefined}
                  data-closing={closingTabIds.has(document.id) || undefined}
                  data-preview={document.preview}
                  draggable={!closingTabIds.has(document.id)}
                  key={document.id}
                  onContextMenu={() => workspace.setActiveDocument(document.id)}
                  onDragEnd={(event) => finishTabDrag(event.clientX, event.clientY)}
                  onDragOver={(event) => {
                    const sourceId = draggedTabId.current;
                    if (!sourceId || sourceId === document.id) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const placement =
                      event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after';
                    const sourceIndex = workspace.documents.findIndex(
                      (entry) => entry.id === sourceId,
                    );
                    const targetIndex = workspace.documents.findIndex(
                      (entry) => entry.id === document.id,
                    );
                    const alreadyPlaced =
                      (placement === 'before' && sourceIndex === targetIndex - 1) ||
                      (placement === 'after' && sourceIndex === targetIndex + 1);
                    if (alreadyPlaced) return;
                    captureTabPositions();
                    workspace.reorderDocument(sourceId, document.id, placement);
                  }}
                  onDragStart={(event) => {
                    draggedTabId.current = document.id;
                    tabHoverSuppressionAnchor.current = null;
                    setDraggingTabId(document.id);
                    setTabHoverSuppressed(true);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData(editorTabDragMime, document.id);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    finishTabDrag(event.clientX, event.clientY);
                  }}
                  onPointerEnter={() => setHoveredTabId(document.id)}
                  onPointerLeave={() =>
                    setHoveredTabId((current) => (current === document.id ? null : current))
                  }
                >
                  <Button
                    aria-description={editorTabDescription(document) ?? undefined}
                    aria-selected={document.id === workspace.activeDocumentId}
                    className="editor-tab-trigger"
                    onClick={() => workspace.setActiveDocument(document.id)}
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
                      const target = rovingKeyTarget(event.key, index, workspace.documents.length);
                      if (target === null) return;
                      event.preventDefault();
                      const next = workspace.documents[target];
                      if (!next) return;
                      workspace.setActiveDocument(next.id);
                      focusEditorTab(tabList.current, next.id);
                    }}
                    role="tab"
                    tabIndex={document.id === workspace.activeDocumentId ? 0 : -1}
                    title={document.path ?? document.name}
                    variant="ghost"
                  >
                    {document.readOnly ? <LockKeyhole aria-hidden="true" /> : null}
                    {document.id === pinnedPreviewSource?.id ? (
                      <Play aria-hidden="true" className="editor-tab-pinned-preview" />
                    ) : null}
                    <EditorTabTitle name={document.name} />
                  </Button>
                  <EditorTabCloseButton
                    active={document.id === workspace.activeDocumentId}
                    closing={closingTabIds.has(document.id)}
                    dirty={document.dirty}
                    name={document.name}
                    onClose={() => closeTab(document.id)}
                    visible={
                      document.dirty ||
                      document.id === workspace.activeDocumentId ||
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
              <ContextMenuItem onClick={() => void workspace.saveActive()}>
                {t(
                  workspace.activeDocument.readOnly
                    ? 'code-editor.tab-menu.clone-save-as'
                    : 'code-editor.tab-menu.save',
                )}
              </ContextMenuItem>
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
                    <PlayIcon aria-hidden="true" ref={runIcon.iconRef} size={14} />
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
                                : 'code-editor.run-menu.seed-randomize',
                            )}
                            className="preview-run-seed-mode"
                            data-randomize={!previewSeedLocked || undefined}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (!previewSeedControls(previewExecution).modeToggleable) return;
                              previewExecution?.toggleSeedMode();
                            }}
                            pressed={!previewSeedLocked}
                            size="icon-compact"
                          />
                        }
                      >
                        {previewSeedLocked ? (
                          <LockKeyhole aria-hidden="true" />
                        ) : (
                          <Dices aria-hidden="true" />
                        )}
                      </TooltipTrigger>
                      <TooltipContent>
                        {t(
                          previewSeedLocked
                            ? 'code-editor.run-menu.seed-locked'
                            : 'code-editor.run-menu.seed-randomize',
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
                    aria-expanded={previewExpanded}
                    aria-label={t(
                      previewExpanded
                        ? 'code-editor.preview.collapse'
                        : 'code-editor.preview.expand',
                    )}
                    className="preview-toggle"
                    data-expanded={previewExpanded}
                    onClick={onTogglePreview}
                    size="icon-compact"
                    variant="ghost"
                  />
                }
              >
                <MapIcon aria-hidden="true" ref={previewIcon.iconRef} size={14} />
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t(
                  previewExpanded
                    ? 'code-editor.preview.collapse-tooltip'
                    : 'code-editor.preview.expand-tooltip',
                )}
              </TooltipContent>
            </Tooltip>
          </>
        ) : null}
      </div>
      <div
        className="monaco-host"
        onDragOverCapture={blockTabDropInEditor}
        onMouseDownCapture={openCommentLink}
        onDropCapture={blockTabDropInEditor}
      >
        <div className="monaco-editor-mount" dir="ltr" ref={container} />
        <EditorContextMenu />
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
      <output hidden data-testid="source-reveal">
        {selection
          ? `${selection.uri} — ${selection.marker}`
          : workspace.activeDocument.readOnly
            ? 'Read-only protected source — use Clone / Save As to edit'
            : workspace.activeDocument.path
              ? workspace.activeDocument.name
              : 'Unsaved file'}
      </output>
    </section>
  );
}
