import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import type { OwnSnippetSection } from '../shared/own-snippets';
import { wordBasedSuggestionsFor } from './completion-filter';
import { EditorContextMenu } from './editor-context-menu';
import { editorDefaultFontSize, editorFontFamily } from './editor-font';
import { registerEditorMenuScope } from './monaco-context-menu';
import { attachRmsSnippetDocument, configureRmsLanguage } from './monaco-language';
import { containEditorPopupWheel } from './monaco-popup-wheel';
import { bracketColorizationFor } from './rms-language';
import {
  parseShortcutPresses,
  rmsSnippetLanguageId,
  snippetCodeBlockedShortcuts,
  snippetCodeMenuActionIds,
  snippetCodePrefix,
  snippetCodeSelectAllActionId,
  snippetCodeUri,
  type ShortcutPress,
} from './snippet-code';
import { useI18n } from './i18n';

const snippetCodeContextKey = 'rmside.snippetCodeEditor';
const snippetCodeMenuScope = 'snippet-code';
const blockedCommandId = 'rmside.snippetCode.blocked';

let snippetCodeSequence = 0;
let shortcutsBlocked = false;

function monacoKeyCode(key: string): number {
  const name = /^[A-Z]$/u.test(key) ? `Key${key}` : key === '.' ? 'Period' : key;
  const code = (monaco.KeyCode as unknown as Record<string, number | undefined>)[name];
  if (code === undefined) throw new Error(`no Monaco key code for ${key}`);
  return code;
}

function monacoPress(press: ShortcutPress): number {
  return (
    (press.ctrl ? monaco.KeyMod.CtrlCmd : 0) |
    (press.shift ? monaco.KeyMod.Shift : 0) |
    (press.alt ? monaco.KeyMod.Alt : 0) |
    monacoKeyCode(press.key)
  );
}

function blockSnippetCodeShortcuts(): void {
  if (shortcutsBlocked) return;
  shortcutsBlocked = true;
  monaco.editor.addCommand({ id: blockedCommandId, run: () => undefined });
  monaco.editor.addKeybindingRules(
    snippetCodeBlockedShortcuts.map((shortcut) => {
      const [first, second] = parseShortcutPresses(shortcut).map(monacoPress);
      return {
        keybinding: second === undefined ? first! : monaco.KeyMod.chord(first!, second),
        command: blockedCommandId,
        when: snippetCodeContextKey,
      };
    }),
  );
}

export function SnippetCodeEditor({
  initialValue,
  section,
  onChange,
  onEscape,
  labelId,
  label,
  describedBy,
  invalid,
}: {
  initialValue: string;
  section: OwnSnippetSection;
  onChange(value: string): void;
  onEscape(): void;
  labelId: string;
  label: string;
  describedBy: string | undefined;
  invalid: boolean;
}) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement | null>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const languageDocument = useRef<ReturnType<typeof attachRmsSnippetDocument> | null>(null);
  const latest = useRef({ onChange, onEscape, section, label, labelId, describedBy, invalid, t });
  latest.current = { onChange, onEscape, section, label, labelId, describedBy, invalid, t };

  const describe = () => {
    const textbox = host.current?.querySelector<HTMLElement>('[role="textbox"]');
    if (!textbox) return;
    const current = latest.current;
    textbox.setAttribute('aria-labelledby', current.labelId);
    if (current.describedBy) textbox.setAttribute('aria-describedby', current.describedBy);
    else textbox.removeAttribute('aria-describedby');
    if (current.invalid) textbox.setAttribute('aria-invalid', 'true');
    else textbox.removeAttribute('aria-invalid');
  };

  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    configureRmsLanguage();
    blockSnippetCodeShortcuts();
    snippetCodeSequence += 1;
    const model = monaco.editor.createModel(
      initialValue,
      rmsSnippetLanguageId,
      monaco.Uri.parse(snippetCodeUri(snippetCodeSequence)),
    );
    model.setEOL(monaco.editor.EndOfLineSequence.LF);
    model.updateOptions({
      tabSize: 4,
      insertSpaces: true,
      bracketColorizationOptions: bracketColorizationFor('rms'),
    });
    const instance = monaco.editor.create(element, {
      model,
      acceptSuggestionOnEnter: 'smart',
      accessibilitySupport: 'auto',
      ariaLabel: latest.current.label,
      automaticLayout: true,
      bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: false },
      codeLens: false,
      contextmenu: true,
      detectIndentation: false,
      fixedOverflowWidgets: false,
      folding: false,
      fontFamily: editorFontFamily,
      fontSize: editorDefaultFontSize,
      glyphMargin: false,
      guides: { bracketPairs: 'active', highlightActiveBracketPair: true, indentation: false },
      hideCursorInOverviewRuler: true,
      inlayHints: { enabled: 'off' },
      lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off },
      lineDecorationsWidth: 8,
      lineNumbers: 'off',
      lineNumbersMinChars: 0,
      links: false,
      matchBrackets: 'always',
      minimap: { enabled: false },
      mouseWheelZoom: false,
      occurrencesHighlight: 'off',
      overviewRulerBorder: false,
      overviewRulerLanes: 0,
      padding: { top: 6, bottom: 6 },
      renderLineHighlightOnlyWhenFocus: true,
      renderValidationDecorations: 'off',
      scrollBeyondLastLine: false,
      scrollbar: {
        alwaysConsumeMouseWheel: false,
        horizontalScrollbarSize: 10,
        useShadows: false,
        verticalScrollbarSize: 10,
      },
      'semanticHighlighting.enabled': true,
      stickyScroll: { enabled: false },
      useShadowDOM: false,
      wordBasedSuggestions: wordBasedSuggestionsFor('rms'),
      wordWrap: 'off',
    });
    editor.current = instance;
    instance.createContextKey(snippetCodeContextKey, true);
    const selectAll = instance.addAction({
      id: snippetCodeSelectAllActionId,
      label: latest.current.t('app-menu.edit.select-all'),
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyA],
      contextMenuGroupId: '9_cutcopypaste',
      contextMenuOrder: 4,
      run: (current) => current.trigger('rmside.snippet-code', 'editor.action.selectAll', null),
    });
    const escape = instance.addAction({
      id: 'rmside.snippetCode.escape',
      label: latest.current.t('code-editor.save-snippet.close'),
      keybindings: [monaco.KeyCode.Escape],
      keybindingContext: `${snippetCodeContextKey} && editorHasSelection && !editorHasMultipleSelections && !suggestWidgetVisible && !parameterHintsVisible && !inSnippetMode`,
      run: () => latest.current.onEscape(),
    });
    const releaseMenuScope = registerEditorMenuScope(
      snippetCodeMenuScope,
      element,
      snippetCodeMenuActionIds,
    );
    const releasePopupWheel = containEditorPopupWheel(element);
    languageDocument.current = attachRmsSnippetDocument(
      model,
      snippetCodePrefix(latest.current.section),
    );
    const content = model.onDidChangeContent(() => latest.current.onChange(model.getValue()));
    const configuration = instance.onDidChangeConfiguration(() => describe());
    describe();
    return () => {
      content.dispose();
      configuration.dispose();
      selectAll.dispose();
      escape.dispose();
      releaseMenuScope();
      releasePopupWheel();
      languageDocument.current?.dispose();
      languageDocument.current = null;
      editor.current = null;
      instance.dispose();
      model.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    languageDocument.current?.setPrefix(snippetCodePrefix(section));
  }, [section]);

  useEffect(() => {
    editor.current?.updateOptions({ ariaLabel: label });
    describe();
  }, [label, labelId, describedBy, invalid]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div
        className="save-snippet-code"
        data-invalid={invalid || undefined}
        data-testid="save-snippet-code"
        dir="ltr"
        ref={host}
      />
      <EditorContextMenu scope={snippetCodeMenuScope} />
    </>
  );
}
