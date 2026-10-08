import * as monaco from 'monaco-editor';
import {
  conf as pythonLanguageConfiguration,
  language as pythonMonarchLanguage,
} from 'monaco-editor/languages/definitions/python/python.js';
import type { LanguageServerDiagnostic, LocalPresentationNames } from '../shared/api';
import { editionCapabilities } from '../shared/edition';
import { t } from '../shared/i18n/translator';
import { inlineErrorText } from '../shared/message-catalog';
import type { OutputText } from '../shared/output-message';
import { disableRmsLintRuleCommandId, isRmsLintCode } from '../shared/rms-lint-rules';
import { xsFormatterConvention, type SourceLanguageId } from '../shared/xs-contract';
import {
  includeFromHover,
  includeHoverParts,
  includeLinkAt,
  includeLinksFromLsp,
  includeTargetFromCommandArguments,
  openIncludedFileCommandId,
  openIncludedFileCommandUri,
  type IncludeLink,
} from './include-navigation';
import type { SourceBlockStructure } from './source-highlight';
import { semanticTokensForVersion, type SemanticTokensResult } from './semantic-tokens';
import { xsLanguageConfiguration, xsMonarchLanguage } from './xs-language';
import { rmsLanguageConfigurationFor, rmsMonarchLanguage } from './rms-language';
import { rmsInlayHintsFromLsp } from './rms-inlay-hints';
import { definitionLocationsFromLsp, documentHighlightsFromLsp } from './language-navigation';
import {
  completionFilter,
  completionList,
  resolvesDocumentation,
  xsCallInsertion,
  type LspCompletionItem,
  type LspCompletionList,
} from './completion-filter';
import { relatedLocationsFromLsp } from './diagnostic-related';
import {
  localContentNameAvailability,
  lspCompletionContext,
  rmsCompletionCommand,
  rmsCompletionEdit,
  rmsCompletionTriggerCharacters,
  rmsContentKindOf,
  rmsContentSuggestions,
  rmsSignatureHelpTriggerCharacters,
  signatureParameters,
  type LspSignatureParameter,
} from './rms-completion';
import { onGameInstallationChanged } from './game-installation';
import { hoverlessAt, PublishedCodeActions } from './editor-answers';

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspLocation {
  uri: string;
  range: LspRange;
}

interface LspCodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  diagnostics?: LanguageServerDiagnostic[];
  edit?: { changes?: Record<string, LspTextEdit[]> };
  command?: { title?: unknown; command?: unknown; arguments?: unknown };
}

interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

interface LspTextEdit {
  range: LspRange;
  newText: string;
}

interface AttachedDocument {
  languageId: SourceLanguageId;
  model: monaco.editor.ITextModel;
  pendingSync: Promise<string | null>;
  syncFailure: string | null;
  version: number;
}

const attachedDocuments = new Map<string, AttachedDocument>();
const rmsFormatterConvention = 2;
let rmsIndentConditionals = true;
let languageEditGuard: (uri: string) => string | null = () => null;

export function setLanguageEditGuard(guard: (uri: string) => string | null): monaco.IDisposable {
  languageEditGuard = guard;
  return {
    dispose: () => {
      if (languageEditGuard === guard) languageEditGuard = () => null;
    },
  };
}

let includedFileOpener: ((uri: string) => boolean | Promise<boolean>) | null = null;

export function setIncludedFileOpener(
  opener: (uri: string) => boolean | Promise<boolean>,
): monaco.IDisposable {
  includedFileOpener = opener;
  return {
    dispose: () => {
      if (includedFileOpener === opener) includedFileOpener = null;
    },
  };
}

export async function openIncludedFile(uri: string): Promise<boolean> {
  return (await includedFileOpener?.(uri)) ?? false;
}

const includeLinkCache = new Map<string, { version: number; links: Promise<IncludeLink[]> }>();

export function requestIncludeLinks(model: monaco.editor.ITextModel): Promise<IncludeLink[]> {
  const languageId = model.getLanguageId();
  if (languageId !== 'rms' && languageId !== 'xs') return Promise.resolve([]);
  const key = model.uri.toString();
  const version = model.getVersionId();
  const cached = includeLinkCache.get(key);
  if (cached?.version === version) return cached.links;
  const links = requestLanguage<unknown>(
    'textDocument/documentLink',
    textDocumentParams(model),
  ).then(includeLinksFromLsp);
  includeLinkCache.set(key, { version, links });
  return links;
}

export async function includeLinkAtPosition(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
): Promise<IncludeLink | null> {
  const links = await requestIncludeLinks(model);
  return includeLinkAt(links, {
    line: position.lineNumber - 1,
    character: position.column - 1,
  });
}

function markerOwner(languageId: string): string {
  return languageId === 'starlark' ? 'starlark-lsp' : 'rms-ls';
}
const semanticTokensChanged = new monaco.Emitter<void>();
const languageAnswersChanged = new monaco.Emitter<void>();

export const onLanguageAnswersChanged = languageAnswersChanged.event;

export function notifyLanguageContextChanged(): void {
  languageAnswersChanged.fire();
}
const starlarkSemanticTokenLegend: monaco.languages.SemanticTokensLegend = {
  tokenTypes: ['function', 'property'],
  tokenModifiers: [],
};
let activeRmsEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let configured = false;

export interface RmsFormattingOutcome {
  status: 'formatted' | 'unchanged' | 'skipped' | 'stale' | 'cancelled';
  content: string;
  reason?: string;
  reasonText?: OutputText;
}

class FormattingRefusal extends Error {
  readonly text: OutputText;

  constructor(message: string, text: OutputText) {
    super(message);
    this.text = text;
  }
}

export function rmsConditionalIndentation(): boolean {
  return rmsIndentConditionals;
}

export function setRmsConditionalIndentation(enabled: boolean): void {
  if (enabled === rmsIndentConditionals) return;
  rmsIndentConditionals = enabled;
  if (configured) {
    monaco.languages.setLanguageConfiguration('rms', rmsLanguageConfigurationFor(enabled));
  }
}

export function configureRmsLanguage(): void {
  if (configured) return;
  configured = true;
  monaco.languages.register({ id: 'rms', extensions: ['.rms', '.rms2', '.inc', '.def'] });
  monaco.languages.register({ id: 'starlark', extensions: ['.rmstest'] });
  monaco.languages.register({ id: 'xs', extensions: ['.xs'], aliases: ['XS'] });
  monaco.languages.setLanguageConfiguration('xs', xsLanguageConfiguration);
  monaco.languages.setMonarchTokensProvider('xs', xsMonarchLanguage);
  monaco.languages.setLanguageConfiguration(
    'rms',
    rmsLanguageConfigurationFor(rmsIndentConditionals),
  );
  monaco.languages.setMonarchTokensProvider('rms', rmsMonarchLanguage);
  monaco.languages.setLanguageConfiguration('starlark', {
    ...pythonLanguageConfiguration,
    comments: { lineComment: '#' },
    indentationRules: {
      increaseIndentPattern: /^\s*(?:def|for|if|elif|else)\b.*:\s*(?:#.*)?$/u,
      decreaseIndentPattern: /^\s*(?:elif|else)\b/u,
    },
  });
  monaco.languages.setMonarchTokensProvider('starlark', pythonMonarchLanguage);
  monaco.editor.registerLinkOpener({
    open: (resource) => {
      const url = resource.toString(true);
      if (!/^https?:\/\//iu.test(url)) return false;
      void window.rmside.openDocumentLink(url);
      return true;
    },
  });
  monaco.editor.registerCommand(openIncludedFileCommandId, (_accessor, ...args: unknown[]) => {
    const target = includeTargetFromCommandArguments(args);
    if (target) void openIncludedFile(target);
  });
  monaco.editor.registerCommand(disableRmsLintRuleCommandId, (_accessor, ...args: unknown[]) => {
    const [code] = args;
    if (isRmsLintCode(code)) void window.rmside.disableRmsLintRule(code).catch(() => undefined);
  });
  const forgetContentNames = () => {
    rmsContentNames = null;
    rmsContentNamesSnapshot = null;
    inlayHintsChanged.fire();
  };
  onGameInstallationChanged(forgetContentNames);
  window.rmside.onLocaleChanged(forgetContentNames);
  registerProviders('rms');
  registerProviders('starlark');
  registerProviders('xs');
  registerMapTestHostProviders();
  window.rmside.onLanguageServerEvent((event) => {
    if (event.method !== 'textDocument/publishDiagnostics') return;
    const params = event.params as {
      uri?: unknown;
      diagnostics?: unknown;
    };
    if (typeof params?.uri !== 'string' || !Array.isArray(params.diagnostics)) return;
    includeLinkCache.delete(monaco.Uri.parse(params.uri).toString());
    rememberPublishedCodeActions(params);
    const model = monaco.editor.getModel(monaco.Uri.parse(params.uri));
    if (!model) return;
    const markers = params.diagnostics.filter(isLanguageDiagnostic).map((diagnostic) => {
      const tags = markerTags(diagnostic);
      const related = relatedLocationsFromLsp(diagnostic, params.uri as string).map((location) => ({
        resource: monaco.Uri.parse(location.uri),
        message: location.message,
        ...toMonacoRange(location.range),
      }));
      return {
        ...toMonacoRange(diagnostic.range),
        severity: markerSeverity(diagnostic.severity),
        code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
        source: 'rms-ls',
        message: diagnostic.message,
        ...(tags.length > 0 ? { tags } : {}),
        ...(related.length > 0 ? { relatedInformation: related } : {}),
      };
    });
    monaco.editor.setModelMarkers(
      model,
      markerOwner(model.getLanguageId()),
      markers.map((marker) => ({
        ...marker,
        source: model.getLanguageId() === 'starlark' ? 'rms-test' : 'rms-ls',
      })),
    );
    if (model.getLanguageId() === 'xs') xsInlayHintsChanged.fire();
    languageAnswersChanged.fire();
  });
  window.rmside.onNativeEvent((status) => {
    if (status.name === 'rms-ls' && status.state === 'running') {
      semanticTokensChanged.fire();
      languageAnswersChanged.fire();
    }
  });
}

export function attachRmsLanguageDocument(model: monaco.editor.ITextModel): monaco.IDisposable {
  return attachLanguageDocument(model, 'rms');
}

export function attachLanguageDocument(
  model: monaco.editor.ITextModel,
  languageId: SourceLanguageId,
): monaco.IDisposable {
  const uri = model.uri.toString();
  const document: AttachedDocument = {
    languageId,
    model,
    pendingSync: Promise.resolve(null),
    syncFailure: null,
    version: 1,
  };
  attachedDocuments.set(uri, document);
  const track = (pending: Promise<string | null>) => {
    document.syncFailure = null;
    document.pendingSync = pending;
    void pending.then((failure) => {
      if (document.pendingSync === pending) document.syncFailure = failure;
    });
  };
  track(
    notifyOpen(document).then((failure) => {
      if (!failure) semanticTokensChanged.fire();
      return failure;
    }),
  );
  const subscription = model.onDidChangeContent(() => {
    document.version += 1;
    track(
      syncLanguageDocument(
        window.rmside.notifyLanguageServer('textDocument/didChange', {
          textDocument: { uri, version: document.version },
          contentChanges: [{ text: model.getValue() }],
        }),
      ),
    );
  });
  return {
    dispose: () => {
      subscription.dispose();
      attachedDocuments.delete(uri);
      includeLinkCache.delete(uri);
      publishedCodeActions.forget(uri);
      void window.rmside
        .notifyLanguageServer('textDocument/didClose', { textDocument: { uri } })
        .catch(() => undefined);
      monaco.editor.setModelMarkers(model, markerOwner(languageId), []);
    },
  };
}

export async function requestRmsSourceStructure(
  model: monaco.editor.ITextModel,
): Promise<SourceBlockStructure | null> {
  const version = model.getVersionId();
  const [symbols, folds] = await Promise.all([
    requestLanguage<unknown[]>('textDocument/documentSymbol', textDocumentParams(model)),
    requestLanguage<unknown[]>('textDocument/foldingRange', textDocumentParams(model)),
  ]);
  if (model.isDisposed() || model.getVersionId() !== version) return null;
  if (!Array.isArray(symbols) || !Array.isArray(folds)) return null;
  return {
    symbols: symbols
      .filter(isLspDocumentSymbol)
      .map((symbol) => ({ kind: symbol.kind, line: symbol.range.start.line, name: symbol.name })),
    folds: folds.flatMap((fold) => {
      const value = fold as { startLine?: unknown; endLine?: unknown; kind?: unknown } | null;
      return typeof value?.startLine === 'number' &&
        typeof value.endLine === 'number' &&
        value.kind !== 'comment'
        ? [{ startLine: value.startLine, endLine: value.endLine }]
        : [];
    }),
  };
}

export function registerActiveRmsEditor(
  editor: monaco.editor.IStandaloneCodeEditor,
): monaco.IDisposable {
  activeRmsEditor = editor;
  return {
    dispose: () => {
      if (activeRmsEditor === editor) activeRmsEditor = null;
    },
  };
}

export function runEditorHistoryCommand(command: 'undo' | 'redo'): void {
  if (activeRmsEditor?.hasTextFocus()) {
    activeRmsEditor.trigger('rmside.application-menu', command, null);
    return;
  }
  document.execCommand(command);
}

export function canonicalLanguageDocumentUri(uri: string): string {
  return monaco.Uri.parse(uri).toString();
}

export async function waitForRmsLanguageDocument(uri: string): Promise<string> {
  return waitForLanguageDocument(uri, 'rms');
}

export async function waitForLanguageDocument(
  uri: string,
  expectedLanguageId?: SourceLanguageId,
): Promise<string> {
  const key = monaco.Uri.parse(uri).toString();
  for (;;) {
    const document = attachedDocuments.get(key);
    if (!document || document.model.isDisposed()) {
      throw new Error('the language document is not attached');
    }
    if (expectedLanguageId && document.languageId !== expectedLanguageId) {
      throw new Error(`the ${expectedLanguageId} language document is not attached`);
    }
    const pending = document.pendingSync;
    const failure = await pending;
    if (failure) throw new Error(failure);
    if (
      attachedDocuments.get(key) === document &&
      !document.model.isDisposed() &&
      pending === document.pendingSync
    ) {
      return document.model.uri.toString();
    }
  }
}

export async function formatRmsDocument(
  uri: string,
  expectedContent: string,
  cancellationToken?: monaco.CancellationToken,
): Promise<RmsFormattingOutcome> {
  return formatLanguageDocument(uri, expectedContent, 'rms', cancellationToken);
}

export async function formatStarlarkDocument(
  uri: string,
  expectedContent: string,
  cancellationToken?: monaco.CancellationToken,
): Promise<RmsFormattingOutcome> {
  return formatLanguageDocument(uri, expectedContent, 'starlark', cancellationToken);
}

export async function formatXsDocument(
  uri: string,
  expectedContent: string,
  cancellationToken?: monaco.CancellationToken,
): Promise<RmsFormattingOutcome> {
  return formatLanguageDocument(uri, expectedContent, 'xs', cancellationToken);
}

export async function formatSourceDocument(
  uri: string,
  name: string,
  expectedContent: string,
): Promise<RmsFormattingOutcome> {
  if (/\.rmstest$/iu.test(name)) return formatStarlarkDocument(uri, expectedContent);
  if (/\.xs$/iu.test(name)) return formatXsDocument(uri, expectedContent);
  return formatRmsDocument(uri, expectedContent);
}

async function formatLanguageDocument(
  uri: string,
  expectedContent: string,
  languageId: SourceLanguageId,
  cancellationToken?: monaco.CancellationToken,
): Promise<RmsFormattingOutcome> {
  const document = attachedDocuments.get(monaco.Uri.parse(uri).toString());
  if (!document || document.model.isDisposed()) {
    return {
      status: 'skipped',
      content: expectedContent,
      reason: 'the editor model is unavailable',
      reasonText: { id: 'code-editor.format.reason.model-unavailable' },
    };
  }
  if (document.languageId !== languageId) {
    return {
      status: 'skipped',
      content: expectedContent,
      reason: 'the language identity changed',
      reasonText: { id: 'code-editor.format.reason.language-changed' },
    };
  }
  if (document.model.getValue() !== expectedContent) {
    return {
      status: 'stale',
      content: document.model.getValue(),
      reason: 'the document changed before formatting began',
      reasonText: { id: 'code-editor.format.reason.changed-before' },
    };
  }

  const requestedVersion = document.version;
  const syncFailure = await document.pendingSync;
  if (syncFailure) {
    return { status: 'skipped', content: expectedContent, reason: syncFailure };
  }
  if (cancellationToken?.isCancellationRequested) {
    return {
      status: 'cancelled',
      content: expectedContent,
      reason: 'the request was cancelled',
      reasonText: { id: 'code-editor.format.reason.cancelled' },
    };
  }

  let edits: LspTextEdit[];
  try {
    edits = await requestFormattingEdits(document, requestedVersion);
  } catch (error) {
    if (document.version !== requestedVersion || document.model.getValue() !== expectedContent) {
      return {
        status: 'stale',
        content: document.model.getValue(),
        reason: 'the document changed while formatting was pending',
        reasonText: { id: 'code-editor.format.reason.changed-while-pending' },
      };
    }
    return {
      status: 'skipped',
      content: expectedContent,
      reason: conciseFormattingError(error),
      ...(error instanceof FormattingRefusal ? { reasonText: error.text } : {}),
    };
  }

  if (cancellationToken?.isCancellationRequested) {
    return {
      status: 'cancelled',
      content: expectedContent,
      reason: 'the request was cancelled',
      reasonText: { id: 'code-editor.format.reason.cancelled' },
    };
  }
  if (document.version !== requestedVersion || document.model.getValue() !== expectedContent) {
    return {
      status: 'stale',
      content: document.model.getValue(),
      reason: 'the document changed while formatting was pending',
      reasonText: { id: 'code-editor.format.reason.changed-while-pending' },
    };
  }
  if (edits.length === 0) return { status: 'unchanged', content: expectedContent };

  const operations = edits.map(toMonacoEditOperation);
  const editor = activeRmsEditor?.getModel() === document.model ? activeRmsEditor : null;
  const selections = editor?.getSelections() ?? [];
  const transformedSelections = selections.map((selection) =>
    transformSelectionOffsets(document.model, selection, operations),
  );
  if (editor) {
    editor.pushUndoStop();
    editor.executeEdits('rmside.format-document', operations);
    editor.setSelections(
      transformedSelections.map(({ anchorOffset, activeOffset }) => {
        const anchor = document.model.getPositionAt(anchorOffset);
        const active = document.model.getPositionAt(activeOffset);
        return new monaco.Selection(
          anchor.lineNumber,
          anchor.column,
          active.lineNumber,
          active.column,
        );
      }),
    );
    editor.pushUndoStop();
  } else {
    document.model.pushStackElement();
    document.model.pushEditOperations([], operations, () => null);
    document.model.pushStackElement();
  }
  return { status: 'formatted', content: document.model.getValue() };
}

function notifyOpen(document: AttachedDocument): Promise<string | null> {
  return syncLanguageDocument(
    window.rmside.notifyLanguageServer('textDocument/didOpen', {
      textDocument: {
        uri: document.model.uri.toString(),
        languageId: document.languageId,
        version: document.version,
        text: document.model.getValue(),
      },
    }),
  );
}

const completionTriggerCharacters: Record<SourceLanguageId, string[]> = {
  rms: [...rmsCompletionTriggerCharacters],
  xs: ['.'],
  starlark: ['.', '(', ','],
};

const resolvableCompletions = new WeakMap<monaco.languages.CompletionItem, LspCompletionItem>();

function registerProviders(languageId: SourceLanguageId): void {
  monaco.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: completionTriggerCharacters[languageId],
    provideCompletionItems: async (model, position, context) => {
      const rms = languageId === 'rms';
      if (rms) void contentNamesSnapshot();
      const localNames = rms ? rmsContentNamesSnapshot : null;
      const params =
        languageId === 'xs'
          ? {
              ...positionParams(model, position),
              rmsCompletion: completionFilter(
                model.getLineContent(position.lineNumber),
                completionReplacementRange(model, position, languageId).startColumn,
                position.column,
              ),
            }
          : rms
            ? {
                ...positionParams(model, position),
                context: lspCompletionContext(context),
                rmsContext: localContentNameAvailability(localNames),
              }
            : positionParams(model, position);
      const result = await requestLanguage<LspCompletionList>('textDocument/completion', params);
      const range = completionReplacementRange(model, position, languageId);
      const textAfter =
        languageId === 'xs'
          ? model.getLineContent(position.lineNumber).slice(range.endColumn - 1)
          : null;
      const list = completionList(result, (item) => {
        const edit = rms ? rmsCompletionEdit(item) : null;
        const call = textAfter === null ? null : xsCallInsertion(item, textAfter);
        const command = rms ? rmsCompletionCommand(item) : (call?.command ?? null);
        const suggestion: monaco.languages.CompletionItem = {
          label: item.label,
          kind: completionKind(item.kind),
          detail: item.detail,
          documentation: markdownDocumentation(item.documentation),
          insertText: call?.insertText ?? edit?.text ?? item.insertText ?? item.label,
          ...(item.insertTextFormat === 2 || call
            ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
            : {}),
          ...(item.filterText === undefined ? {} : { filterText: item.filterText }),
          ...(item.sortText === undefined ? {} : { sortText: item.sortText }),
          range: edit ? toMonacoRangeObject(edit.range) : range,
          ...(command ? { command } : {}),
          ...(item.tags?.includes(1)
            ? { tags: [monaco.languages.CompletionItemTag.Deprecated] }
            : {}),
        };
        if (resolvesDocumentation(item)) resolvableCompletions.set(suggestion, item);
        return suggestion;
      });
      const contentKind = rms ? rmsContentKindOf(result) : null;
      if (contentKind && localNames) {
        const listed = new Set(list.suggestions.map((suggestion) => String(suggestion.label)));
        for (const name of rmsContentSuggestions(localNames, contentKind, listed)) {
          list.suggestions.push({
            label: name.label,
            kind: monaco.languages.CompletionItemKind.Constant,
            detail: name.detail,
            insertText: name.label,
            sortText: name.sortText,
            range,
          });
        }
      }
      return list;
    },
    resolveCompletionItem: async (suggestion) => {
      const item = resolvableCompletions.get(suggestion);
      if (!item) return suggestion;
      const resolved = await requestLanguage<LspCompletionItem>('completionItem/resolve', item);
      const documentation = markdownDocumentation(resolved?.documentation);
      return documentation === undefined ? suggestion : { ...suggestion, documentation };
    },
  });

  monaco.languages.registerSignatureHelpProvider(languageId, {
    signatureHelpTriggerCharacters:
      languageId === 'rms' ? [...rmsSignatureHelpTriggerCharacters] : ['(', ','],
    provideSignatureHelp: async (model, position) => {
      const result = await requestLanguage<{
        signatures?: Array<{
          label: string;
          documentation?: string | { value?: string };
          parameters?: LspSignatureParameter[];
        }>;
        activeSignature?: number;
        activeParameter?: number;
      }>('textDocument/signatureHelp', positionParams(model, position));
      if (!result?.signatures?.length) return null;
      return {
        value: {
          signatures: result.signatures.map((signature) => ({
            label: signature.label,
            documentation: markdownDocumentation(signature.documentation),
            parameters: signatureParameters(signature.parameters),
          })),
          activeSignature: result.activeSignature ?? 0,
          activeParameter: result.activeParameter ?? 0,
        },
        dispose: () => undefined,
      };
    },
  });

  monaco.languages.registerHoverProvider(languageId, {
    provideHover: async (model, position) => {
      if (hoverlessAt(model.getLineContent(position.lineNumber), position.column)) return null;
      const result = await requestLanguage<{
        contents?: string | { value?: string } | Array<string | { value?: string }>;
        range?: LspRange;
      }>('textDocument/hover', positionParams(model, position));
      if (!result?.contents) return null;
      const values = (Array.isArray(result.contents) ? result.contents : [result.contents]).map(
        (value) => (typeof value === 'string' ? value : (value.value ?? '')),
      );
      const include = includeFromHover(result);
      return {
        range: result.range ? toMonacoRangeObject(result.range) : undefined,
        contents: include ? includeHoverParts(include, values) : values.map((value) => ({ value })),
      };
    },
  });

  if (languageId === 'rms' || languageId === 'xs') {
    monaco.languages.registerLinkProvider(languageId, {
      provideLinks: async (model) => ({
        links: (await requestIncludeLinks(model)).flatMap((link) =>
          link.target ? [{ range: toMonacoRangeObject(link.range), target: link.target }] : [],
        ),
      }),
      resolveLink: (link) => {
        const target = (link as { target?: unknown }).target;
        return typeof target === 'string'
          ? { ...link, url: openIncludedFileCommandUri(target) }
          : null;
      },
    });
  }

  monaco.languages.registerDefinitionProvider(languageId, {
    provideDefinition: async (model, position) => {
      const result = await requestLanguage<unknown>(
        'textDocument/definition',
        positionParams(model, position),
      );
      const locations = definitionLocationsFromLsp(result);
      return locations.length === 0 ? null : locations.map(toMonacoLocation);
    },
  });

  if (languageId !== 'starlark') {
    monaco.languages.registerReferenceProvider(languageId, {
      provideReferences: async (model, position) => {
        const result = await requestLanguage<LspLocation[]>('textDocument/references', {
          ...positionParams(model, position),
          context: { includeDeclaration: true },
        });
        return (result ?? []).map(toMonacoLocation);
      },
    });
  }

  if (languageId === 'rms' || languageId === 'xs') {
    monaco.languages.registerDocumentHighlightProvider(languageId, {
      provideDocumentHighlights: async (model, position) => {
        const result = await requestLanguage<unknown>(
          'textDocument/documentHighlight',
          positionParams(model, position),
        );
        return documentHighlightsFromLsp(result).map((highlight) => ({
          range: toMonacoRangeObject(highlight.range),
          kind:
            highlight.kind === 'write'
              ? monaco.languages.DocumentHighlightKind.Write
              : highlight.kind === 'read'
                ? monaco.languages.DocumentHighlightKind.Read
                : monaco.languages.DocumentHighlightKind.Text,
        }));
      },
    });
  }

  monaco.languages.registerDocumentSymbolProvider(languageId, {
    provideDocumentSymbols: async (model) => {
      if (languageId === 'starlark') return mapTestDocumentSymbols(model);
      const result = await requestLanguage<LspDocumentSymbol[]>(
        'textDocument/documentSymbol',
        textDocumentParams(model),
      );
      return Array.isArray(result) ? result.filter(isLspDocumentSymbol).map(toMonacoSymbol) : [];
    },
  });

  monaco.languages.registerFoldingRangeProvider(languageId, {
    provideFoldingRanges: async (model) => {
      const result = await requestLanguage<
        Array<{
          startLine: number;
          startCharacter?: number;
          endLine: number;
          endCharacter?: number;
          kind?: string;
        }>
      >('textDocument/foldingRange', textDocumentParams(model));
      return (result ?? []).map((fold) => ({
        start: fold.startLine + 1,
        end: fold.endLine + 1,
        kind: fold.kind === 'comment' ? monaco.languages.FoldingRangeKind.Comment : undefined,
      }));
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider(languageId, {
    provideDocumentFormattingEdits: async (model, _options, cancellationToken) => {
      const document = attachedDocuments.get(model.uri.toString());
      if (!document) return [];
      const requestedVersion = document.version;
      const syncFailure = await document.pendingSync;
      if (
        syncFailure ||
        cancellationToken.isCancellationRequested ||
        document.version !== requestedVersion
      ) {
        return [];
      }
      try {
        const result = await requestFormattingEdits(document, requestedVersion);
        if (cancellationToken.isCancellationRequested || document.version !== requestedVersion) {
          return [];
        }
        return result.map(toMonacoTextEdit);
      } catch {
        return [];
      }
    },
  });

  if (languageId !== 'starlark') {
    monaco.languages.registerRenameProvider(languageId, {
      resolveRenameLocation: async (model, position) => {
        let result: { range?: LspRange; placeholder?: string } | null;
        try {
          result = await requestLanguageOrThrow(
            'textDocument/prepareRename',
            positionParams(model, position),
          );
        } catch (error) {
          return {
            range: new monaco.Range(1, 1, 1, 1),
            text: '',
            rejectReason: languageErrorText(error, t('code-editor.rename.unsafe')),
          };
        }
        if (!result?.range) {
          return {
            range: new monaco.Range(1, 1, 1, 1),
            text: '',
            rejectReason: t('code-editor.rename.unsafe'),
          };
        }
        return {
          range: toMonacoRangeObject(result.range),
          text: result.placeholder ?? model.getValueInRange(toMonacoRangeObject(result.range)),
        };
      },
      provideRenameEdits: async (model, position, newName) => {
        try {
          const result = await requestLanguageOrThrow<{
            changes?: Record<string, LspTextEdit[]>;
          }>('textDocument/rename', {
            ...positionParams(model, position),
            newName,
          });
          const edits: monaco.languages.IWorkspaceTextEdit[] = [];
          for (const [uri, changes] of Object.entries(result?.changes ?? {})) {
            const refusal = languageEditGuard(uri);
            if (refusal) return { edits: [], rejectReason: refusal };
            for (const edit of changes) {
              edits.push({
                resource: monaco.Uri.parse(uri),
                textEdit: toMonacoTextEdit(edit),
                versionId: undefined,
              });
            }
          }
          return { edits };
        } catch (error) {
          return {
            edits: [],
            rejectReason: languageErrorText(error, t('code-editor.rename.not-proven')),
          };
        }
      },
    });
  }

  if (languageId === 'rms' || languageId === 'xs') {
    monaco.languages.registerInlayHintsProvider(languageId, {
      onDidChangeInlayHints: (languageId === 'rms' ? inlayHintsChanged : xsInlayHintsChanged).event,
      provideInlayHints: async (model, range, cancellationToken) => {
        const version = model.getVersionId();
        const result = await requestLanguage<unknown>('textDocument/inlayHint', {
          ...textDocumentParams(model),
          range: {
            start: { line: range.startLineNumber - 1, character: 0 },
            end: { line: range.endLineNumber, character: 0 },
          },
        });
        const hints = rmsInlayHintsFromLsp(
          result,
          languageId === 'rms' && Array.isArray(result) && result.some(hasContentData)
            ? await contentNames()
            : null,
        );
        if (cancellationToken.isCancellationRequested || model.getVersionId() !== version) {
          return { hints: [], dispose: () => undefined };
        }
        return {
          hints: hints.map((hint) => ({
            position: { lineNumber: hint.line + 1, column: hint.character + 1 },
            label: hint.label,
            kind:
              hint.kind === 'parameter'
                ? monaco.languages.InlayHintKind.Parameter
                : monaco.languages.InlayHintKind.Type,
            paddingLeft: hint.paddingLeft,
            paddingRight: hint.paddingRight,
          })),
          dispose: () => undefined,
        };
      },
    });
  }

  if (languageId === 'xs' || languageId === 'rms') {
    monaco.languages.registerCodeActionProvider(
      languageId,
      {
        provideCodeActions: async (model, range) => {
          const lspRange = {
            start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
            end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
          };
          const result =
            publishedCodeActionsFor(model, lspRange) ??
            (await requestLanguage<LspCodeAction[]>('textDocument/codeAction', {
              ...textDocumentParams(model),
              range: lspRange,
              context: { diagnostics: [] },
            }));
          const actions = (Array.isArray(result) ? result : []).flatMap((action) =>
            codeActionFromLsp(model, action),
          );
          return { actions, dispose: () => undefined };
        },
      },
      { providedCodeActionKinds: ['quickfix'] },
    );
  }

  if (languageId === 'rms' || languageId === 'xs')
    monaco.languages.registerDocumentSemanticTokensProvider(languageId, {
      onDidChange: semanticTokensChanged.event,
      getLegend: () => ({
        tokenTypes: [
          'comment',
          'keyword',
          'namespace',
          'function',
          'property',
          'number',
          'string',
          'variable',
          'operator',
          'control',
        ],
        tokenModifiers: [],
      }),
      provideDocumentSemanticTokens: async (model) => {
        const version = model.getVersionId();
        const result = await requestLanguage<SemanticTokensResult>(
          'textDocument/semanticTokens/full',
          textDocumentParams(model),
        );
        return semanticTokensForVersion(model, version, result);
      },
      releaseDocumentSemanticTokens: () => undefined,
    });
}

let rmsContentNames: Promise<LocalPresentationNames | null> | null = null;
let rmsContentNamesSnapshot: LocalPresentationNames | null = null;
const inlayHintsChanged = new monaco.Emitter<void>();
const xsInlayHintsChanged = new monaco.Emitter<void>();

function contentNames(): Promise<LocalPresentationNames | null> {
  if (!editionCapabilities.sourceCatalog) return Promise.resolve(null);
  rmsContentNames ??= window.rmside.getLocalPresentationNames().catch(() => null);
  return rmsContentNames;
}

function contentNamesSnapshot(): Promise<void> {
  const pending = contentNames();
  return pending.then((names) => {
    if (rmsContentNames === pending) rmsContentNamesSnapshot = names;
  });
}

function hasContentData(hint: unknown): boolean {
  return Boolean((hint as { data?: { rmsContent?: unknown } } | null)?.data?.rmsContent);
}

const codeActionCommands = new Set([disableRmsLintRuleCommandId]);

const ignoreOnLineTitle = /^Ignore (RMS\d{4}) on this line$/u;
const turnOffInWorkspaceTitle = /^Turn off (RMS\d{4}) in this workspace$/u;

function quickFixTitle(title: string): string {
  const ignore = ignoreOnLineTitle.exec(title)?.[1];
  if (isRmsLintCode(ignore)) return t('code-editor.quick-fix.ignore-on-line', { code: ignore });
  const turnOff = turnOffInWorkspaceTitle.exec(title)?.[1];
  if (isRmsLintCode(turnOff)) return t('code-editor.quick-fix.turn-off-rule', { code: turnOff });
  return title;
}

function codeActionFromLsp(
  model: monaco.editor.ITextModel,
  action: LspCodeAction,
): monaco.languages.CodeAction[] {
  if (typeof action?.title !== 'string') return [];
  const diagnosticsOf = () =>
    (action.diagnostics ?? []).filter(isLanguageDiagnostic).map((diagnostic) => ({
      ...toMonacoRange(diagnostic.range),
      severity: markerSeverity(diagnostic.severity),
      message: diagnostic.message,
      code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
      source: 'rms-ls',
    }));
  if (action.command && !action.edit) {
    const { command, title } = action.command;
    const commandArguments = Array.isArray(action.command.arguments)
      ? (action.command.arguments as unknown[])
      : [];
    if (typeof command !== 'string' || !codeActionCommands.has(command)) return [];
    return [
      {
        title: quickFixTitle(action.title),
        kind: 'quickfix',
        isPreferred: false,
        diagnostics: diagnosticsOf(),
        command: {
          id: command,
          title: quickFixTitle(typeof title === 'string' ? title : action.title),
          arguments: commandArguments,
        },
      },
    ];
  }
  const edits: monaco.languages.IWorkspaceTextEdit[] = [];
  for (const [uri, changes] of Object.entries(action.edit?.changes ?? {})) {
    if (monaco.Uri.parse(uri).toString() !== model.uri.toString()) return [];
    if (!Array.isArray(changes) || !changes.every(isLspTextEdit)) return [];
    for (const edit of changes) {
      edits.push({
        resource: model.uri,
        textEdit: toMonacoTextEdit(edit),
        versionId: model.getVersionId(),
      });
    }
  }
  if (edits.length === 0) return [];
  return [
    {
      title: quickFixTitle(action.title),
      kind: 'quickfix',
      isPreferred: action.isPreferred === true,
      diagnostics: diagnosticsOf(),
      edit: { edits },
    },
  ];
}

const publishedCodeActions = new PublishedCodeActions<LspCodeAction>();

function rememberPublishedCodeActions(params: {
  uri?: unknown;
  version?: unknown;
  rmsCodeActions?: unknown;
}): void {
  if (typeof params.uri !== 'string') return;
  const key = monaco.Uri.parse(params.uri).toString();
  if (!attachedDocuments.has(key)) {
    publishedCodeActions.forget(key);
    return;
  }
  publishedCodeActions.remember(key, params.version, params.rmsCodeActions);
}

function publishedCodeActionsFor(
  model: monaco.editor.ITextModel,
  range: LspRange,
): LspCodeAction[] | null {
  const key = model.uri.toString();
  const document = attachedDocuments.get(key);
  return document ? publishedCodeActions.lookup(key, document.version, range) : null;
}

function completionReplacementRange(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  languageId: SourceLanguageId = 'rms',
): monaco.Range {
  const word = model.getWordUntilPosition(position);
  const prefix = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
  const includesLeadingSigil =
    languageId === 'rms' && (prefix.endsWith('#') || prefix.endsWith('<'));
  return new monaco.Range(
    position.lineNumber,
    Math.max(1, word.startColumn - Number(includesLeadingSigil)),
    position.lineNumber,
    word.endColumn,
  );
}

async function requestLanguageOrThrow<T>(
  method: Parameters<typeof window.rmside.requestLanguageServer>[0],
  params: unknown,
): Promise<T | null> {
  const uri = languageDocumentUri(params);
  if (uri) await waitForLanguageDocument(uri);
  return (await window.rmside.requestLanguageServer(method, params)) as T | null;
}

function languageErrorText(error: unknown, fallback: string): string {
  const text = inlineErrorText(error instanceof Error ? error.message : String(error));
  if (!text) return fallback;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function requestLanguage<T>(
  method: Parameters<typeof window.rmside.requestLanguageServer>[0],
  params: unknown,
): Promise<T | null> {
  try {
    const uri = languageDocumentUri(params);
    const key = uri === null ? null : monaco.Uri.parse(uri).toString();
    const document = key === null ? undefined : attachedDocuments.get(key);
    if (key !== null && (!document || document.model.isDisposed() || document.syncFailure)) {
      return null;
    }
    const result = (await window.rmside.requestLanguageServer(method, params)) as T | null;
    if (
      key !== null &&
      (attachedDocuments.get(key) !== document ||
        document?.syncFailure ||
        document?.model.isDisposed())
    ) {
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

function languageDocumentUri(params: unknown): string | null {
  const value = params as { textDocument?: { uri?: unknown } } | null;
  return typeof value?.textDocument?.uri === 'string' ? value.textDocument.uri : null;
}

async function requestFormattingEdits(
  document: AttachedDocument,
  requestedVersion: number,
): Promise<LspTextEdit[]> {
  if (document.languageId === 'starlark') {
    return conservativeStarlarkFormattingEdits(document.model);
  }
  const result = await window.rmside.requestLanguageServer('textDocument/formatting', {
    ...textDocumentParams(document.model),
    options: { tabSize: 4, insertSpaces: true },
    rmsDocumentVersion: requestedVersion,
    ...(document.languageId === 'rms'
      ? { rmsFormatterConvention, rmsIndentConditionals }
      : document.languageId === 'xs'
        ? { xsFormatterConvention }
        : { starlarkFormatterConvention: 1 }),
  });
  if (!Array.isArray(result) || !result.every(isLspTextEdit)) {
    throw new Error(
      `${document.languageId} language service returned an invalid formatting response`,
    );
  }
  return result;
}

function syncLanguageDocument(request: Promise<void>): Promise<string | null> {
  return request.then(
    () => null,
    (error: unknown) => `rms-ls synchronization failed: ${conciseFormattingError(error)}`,
  );
}

function conservativeStarlarkFormattingEdits(model: monaco.editor.ITextModel): LspTextEdit[] {
  const errors = monaco.editor
    .getModelMarkers({ resource: model.uri })
    .some(
      (marker) =>
        marker.owner === 'starlark-lsp' && marker.severity === monaco.MarkerSeverity.Error,
    );
  if (errors) {
    throw new FormattingRefusal('formatting is unavailable while the Starlark source is invalid', {
      id: 'code-editor.format.reason.starlark-invalid',
    });
  }
  const original = model.getValue();
  const newline = original.includes('\r\n') ? '\r\n' : original.includes('\r') ? '\r' : '\n';
  const lines = original.split(/\r\n|\r|\n/u);
  if (
    lines.some((line) => {
      if (line.trim().length === 0) return false;
      const indentation = /^[\t ]*/u.exec(line)?.[0] ?? '';
      return indentation.includes('\t') || indentation.length % 4 !== 0;
    })
  ) {
    throw new FormattingRefusal(
      'formatting requires already-valid four-space indentation; token structure was left unchanged',
      { id: 'code-editor.format.reason.starlark-indentation' },
    );
  }
  const candidate = lines
    .map((line) => {
      if (line.trim().length === 0) return '';
      const content = line.replace(/^[\t ]+/u, '');
      const indentation = /^[ ]*/u.exec(line)?.[0] ?? '';
      return `${indentation}${content.replace(/[\t ]+$/u, '')}`;
    })
    .join(newline);
  if (candidate === original) return [];
  const end = model.getPositionAt(original.length);
  return [
    {
      range: {
        start: { line: 0, character: 0 },
        end: { line: end.lineNumber - 1, character: end.column - 1 },
      },
      newText: candidate,
    },
  ];
}

const mapTestHostDocumentation = new Map<string, string>([
  ['rms', 'The map-test namespace: the map to test, seeds, generation, and game constant IDs.'],
  [
    'source',
    'rms.source(path = None) returns the map pinned in the Run options, or the .rms/.rms2 map at path in the open folder.',
  ],
  [
    'id',
    'rms.id(name) returns the ID of a game constant, such as "GOLD" or "DEEP_WATER", in the selected game version. ID filters (object_ids, terrain_ids, cliff_types) also accept these names.',
  ],
  [
    'seeds',
    'rms.seeds(start, count = 1, step = 1) returns a checked uint32 seed sequence without wrapping.',
  ],
  [
    'generate',
    'rms.generate(target, seeds, preview = True) yields immutable samples in seed order. Each successful preview-enabled sample is shown transiently; the final successful sample is committed.',
  ],
  [
    'expect',
    'sample.expect(condition, message, values = None, code = None) records a finding when condition is false and continues.',
  ],
  [
    'report',
    'sample.report(message, values = None, code = None) records an unconditional reproducible finding.',
  ],
]);

interface StarlarkNativeCompletion {
  label: string;
  detail: string;
  documentation?: string;
  kind?: monaco.languages.CompletionItemKind;
  sortText?: string;
}

function nativeMethods(
  type: 'string' | 'list' | 'dict',
  labels: readonly string[],
): StarlarkNativeCompletion[] {
  return labels.map((label) => ({
    label,
    get detail() {
      return t('code-editor.completion.starlark-method', { type });
    },
    documentation:
      label === 'format'
        ? 'string.format(*args, **kwargs) substitutes positional or named values into `{}` fields.'
        : `The built-in ${type}.${label} method of Starlark.`,
  }));
}

const starlarkStringMethods = nativeMethods('string', [
  'capitalize',
  'codepoints',
  'count',
  'elems',
  'endswith',
  'find',
  'format',
  'index',
  'isalnum',
  'isalpha',
  'isdigit',
  'islower',
  'isspace',
  'istitle',
  'isupper',
  'join',
  'lower',
  'lstrip',
  'partition',
  'removeprefix',
  'removesuffix',
  'replace',
  'rfind',
  'rindex',
  'rpartition',
  'rsplit',
  'rstrip',
  'split',
  'splitlines',
  'startswith',
  'strip',
  'title',
  'upper',
]);
const starlarkListMethods = nativeMethods('list', [
  'append',
  'clear',
  'extend',
  'index',
  'insert',
  'pop',
  'remove',
]);
const starlarkDictMethods = nativeMethods('dict', [
  'clear',
  'get',
  'items',
  'keys',
  'pop',
  'popitem',
  'setdefault',
  'update',
  'values',
]);
const starlarkNativeDocumentation = new Map(
  [...starlarkStringMethods, ...starlarkListMethods, ...starlarkDictMethods].map((method) => [
    method.label,
    method.documentation,
  ]),
);
const starlarkFallbackNativeMethods = [
  ...new Map(
    [...starlarkStringMethods, ...starlarkListMethods, ...starlarkDictMethods].map((method) => [
      method.label,
      method,
    ]),
  ).values(),
];
const starlarkGlobalCompletions = [
  'rms',
  'False',
  'None',
  'True',
  'abs',
  'all',
  'any',
  'bool',
  'bytes',
  'chr',
  'dict',
  'dir',
  'enumerate',
  'fail',
  'float',
  'getattr',
  'hash',
  'hasattr',
  'int',
  'len',
  'list',
  'max',
  'min',
  'ord',
  'print',
  'range',
  'repr',
  'reversed',
  'sorted',
  'str',
  'struct',
  'tuple',
  'type',
  'zip',
] as const;

function inferredNativeMethods(
  prefix: string,
  source: string,
  receiver: string | undefined,
): StarlarkNativeCompletion[] | null {
  if (
    /"(?:\\.|[^"\\])*"\.[A-Za-z_]*$/u.test(prefix) ||
    /'(?:\\.|[^'\\])*'\.[A-Za-z_]*$/u.test(prefix) ||
    /\b(?:repr|str)\([^)]*\)\.[A-Za-z_]*$/u.test(prefix)
  ) {
    return starlarkStringMethods;
  }
  if (
    /\[[^\]\n]*\]\.[A-Za-z_]*$/u.test(prefix) ||
    /\b(?:list|reversed|sorted)\([^)]*\)\.[A-Za-z_]*$/u.test(prefix)
  ) {
    return starlarkListMethods;
  }
  if (/\{[^}\n]*\}\.[A-Za-z_]*$/u.test(prefix) || /\bdict\([^)]*\)\.[A-Za-z_]*$/u.test(prefix)) {
    return starlarkDictMethods;
  }
  if (!receiver) return null;
  const assignmentPrefix = `^\\s*${receiver}\\s*=\\s*`;
  if (
    new RegExp(`${assignmentPrefix}(?:[rubf]{0,2})?["']`, 'imu').test(source) ||
    new RegExp(`${assignmentPrefix}(?:repr|str)\\s*\\(`, 'mu').test(source)
  ) {
    return starlarkStringMethods;
  }
  if (new RegExp(`${assignmentPrefix}(?:\\[|(?:list|reversed|sorted)\\s*\\()`, 'mu').test(source)) {
    return starlarkListMethods;
  }
  if (new RegExp(`${assignmentPrefix}(?:\\{|dict\\s*\\()`, 'mu').test(source)) {
    return starlarkDictMethods;
  }
  return null;
}

function starlarkCodeMask(source: string): string {
  let result = '';
  let index = 0;
  const appendMasked = (): string => {
    const character = source[index++] ?? '';
    result += character === '\r' || character === '\n' ? character : ' ';
    return character;
  };

  while (index < source.length) {
    const character = source[index]!;
    if (character === '#') {
      while (index < source.length && source[index] !== '\r' && source[index] !== '\n') {
        appendMasked();
      }
      continue;
    }
    if (character !== '"' && character !== "'") {
      result += character;
      index += 1;
      continue;
    }

    const quote = character;
    const triple = source.slice(index, index + 3) === quote.repeat(3);
    const delimiterLength = triple ? 3 : 1;
    for (let offset = 0; offset < delimiterLength; offset += 1) appendMasked();
    while (index < source.length) {
      if (triple && source.slice(index, index + 3) === quote.repeat(3)) {
        appendMasked();
        appendMasked();
        appendMasked();
        break;
      }
      if (!triple && source[index] === quote) {
        appendMasked();
        break;
      }
      if (source[index] === '\\') {
        appendMasked();
        if (index < source.length) appendMasked();
        continue;
      }
      if (!triple && (source[index] === '\r' || source[index] === '\n')) break;
      appendMasked();
    }
  }
  return result;
}

function starlarkVisibleBindings(sourceBeforeCursor: string): StarlarkNativeCompletion[] {
  const codeLines = starlarkCodeMask(sourceBeforeCursor).split(/\r\n|\r|\n/u);
  const globals = new Map<string, StarlarkNativeCompletion>();
  let activeFunction:
    | {
        indentation: number;
        locals: Map<string, StarlarkNativeCompletion>;
      }
    | undefined;

  const addBinding = (
    bindings: Map<string, StarlarkNativeCompletion>,
    label: string,
    detail: string,
    kind = monaco.languages.CompletionItemKind.Variable,
  ): void => {
    if (!bindings.has(label)) {
      bindings.set(label, {
        label,
        detail,
        documentation: t('code-editor.completion.defined-earlier', { name: label }),
        kind,
        sortText: `0_${label}`,
      });
    }
  };

  for (const line of codeLines) {
    const content = line.trim();
    if (!content) continue;
    const indentation = /^\s*/u.exec(line)?.[0].length ?? 0;
    if (activeFunction && indentation <= activeFunction.indentation) activeFunction = undefined;

    const functionMatch = /^\s*def\s+([A-Za-z_]\w*)\s*\(([^)]*)/u.exec(line);
    if (functionMatch) {
      addBinding(
        globals,
        functionMatch[1]!,
        t('code-editor.completion.starlark-function-defined'),
        monaco.languages.CompletionItemKind.Function,
      );
      activeFunction = { indentation, locals: new Map() };
      for (const parameter of functionMatch[2]!.split(',')) {
        const parameterMatch = /^\s*\*{0,2}\s*([A-Za-z_]\w*)/u.exec(parameter);
        if (parameterMatch) {
          addBinding(
            activeFunction.locals,
            parameterMatch[1]!,
            t('code-editor.completion.starlark-parameter'),
          );
        }
      }
      continue;
    }

    const bindings = activeFunction?.locals ?? globals;
    const assignmentMatch =
      /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?:=|\+=|-=|\*=|\/=|%=|\|=|&=|\^=)(?!=)/u.exec(
        line,
      );
    if (assignmentMatch) {
      for (const label of assignmentMatch[1]!.split(',').map((value) => value.trim())) {
        addBinding(bindings, label, t('code-editor.completion.starlark-variable-defined'));
      }
    }
    const loopMatch = /^\s*for\s+([A-Za-z_]\w*)\s+in\b/u.exec(line);
    if (loopMatch)
      addBinding(bindings, loopMatch[1]!, t('code-editor.completion.starlark-loop-variable'));
  }

  return [...(activeFunction?.locals.values() ?? []), ...globals.values()];
}

function mapTestDocumentSymbols(
  model: monaco.editor.ITextModel,
): monaco.languages.DocumentSymbol[] {
  return model.getLinesContent().flatMap((line, index) => {
    const match = /^\s*def\s+([A-Za-z_]\w*)\s*\(/u.exec(line);
    if (!match || match.index === undefined) return [];
    const startColumn = line.indexOf(match[1]!) + 1;
    return [
      {
        name: match[1]!,
        detail: t('code-editor.symbol.starlark-function'),
        kind: monaco.languages.SymbolKind.Function,
        tags: [],
        range: new monaco.Range(index + 1, 1, index + 1, line.length + 1),
        selectionRange: new monaco.Range(
          index + 1,
          startColumn,
          index + 1,
          startColumn + match[1]!.length,
        ),
      },
    ];
  });
}

function starlarkSemanticTokenData(source: string): Uint32Array {
  const callableKeywords = new Set([
    'and',
    'break',
    'continue',
    'def',
    'elif',
    'else',
    'for',
    'if',
    'in',
    'lambda',
    'load',
    'not',
    'or',
    'pass',
    'return',
  ]);
  const tokens: Array<{ line: number; start: number; length: number; type: number }> = [];
  let index = 0;
  let line = 0;
  let column = 0;
  let lineStart = 0;

  const advance = (): string => {
    const character = source[index++] ?? '';
    if (character === '\n') {
      line += 1;
      column = 0;
      lineStart = index;
    } else {
      column += 1;
    }
    return character;
  };

  while (index < source.length) {
    const character = source[index]!;
    if (character === '\r') {
      advance();
      continue;
    }
    if (character === '\n') {
      advance();
      continue;
    }
    if (character === '#') {
      while (index < source.length && source[index] !== '\n') advance();
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      const triple = source.slice(index, index + 3) === quote.repeat(3);
      const delimiterLength = triple ? 3 : 1;
      for (let offset = 0; offset < delimiterLength; offset += 1) advance();
      while (index < source.length) {
        if (triple && source.slice(index, index + 3) === quote.repeat(3)) {
          advance();
          advance();
          advance();
          break;
        }
        if (!triple && source[index] === quote) {
          advance();
          break;
        }
        if (source[index] === '\\') {
          advance();
          if (index < source.length) advance();
          continue;
        }
        if (!triple && source[index] === '\n') break;
        advance();
      }
      continue;
    }
    if (!/[A-Za-z_]/u.test(character)) {
      advance();
      continue;
    }

    const startIndex = index;
    const startColumn = column;
    while (index < source.length && /[A-Za-z0-9_]/u.test(source[index]!)) advance();
    const word = source.slice(startIndex, index);
    const before = source.slice(lineStart, startIndex);
    const previousNonWhitespace = /\S\s*$/u.exec(before)?.[0].trim() ?? '';
    let nextIndex = index;
    while (
      nextIndex < source.length &&
      source[nextIndex] !== '\n' &&
      /\s/u.test(source[nextIndex]!)
    ) {
      nextIndex += 1;
    }
    const nextNonWhitespace = source[nextIndex] ?? '';
    const isDeclaration = /\bdef\s*$/u.test(before);
    const isCallable = nextNonWhitespace === '(' && !callableKeywords.has(word);
    const isProperty = previousNonWhitespace === '.';
    if (isDeclaration || isCallable || isProperty) {
      tokens.push({
        line,
        start: startColumn,
        length: word.length,
        type: isDeclaration || isCallable ? 0 : 1,
      });
    }
  }

  const data: number[] = [];
  let previousLine = 0;
  let previousStart = 0;
  for (const token of tokens) {
    const deltaLine = token.line - previousLine;
    data.push(
      deltaLine,
      deltaLine === 0 ? token.start - previousStart : token.start,
      token.length,
      token.type,
      0,
    );
    previousLine = token.line;
    previousStart = token.start;
  }
  return new Uint32Array(data);
}

function registerMapTestHostProviders(): void {
  monaco.languages.registerDocumentSemanticTokensProvider('starlark', {
    getLegend: () => starlarkSemanticTokenLegend,
    provideDocumentSemanticTokens: (model) => ({
      data: starlarkSemanticTokenData(model.getValue()),
    }),
    releaseDocumentSemanticTokens: () => undefined,
  });
  monaco.languages.registerCompletionItemProvider('starlark', {
    triggerCharacters: ['.', '_'],
    provideCompletionItems: (model, position) => {
      const prefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const range = completionReplacementRange(model, position);
      const receiver = /\b([A-Za-z_]\w*)\.[A-Za-z_]*$/u.exec(prefix)?.[1];
      const source = model.getValue();
      const sourceBeforeCursor = model.getValueInRange(
        new monaco.Range(1, 1, position.lineNumber, position.column),
      );
      const sampleAliases = new Set(
        [...source.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\s+rms\.generate\s*\(/gu)].map(
          (match) => match[1]!,
        ),
      );
      const mapAliases = new Set(
        [...source.matchAll(/\b([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\.map\b/gu)]
          .filter((match) => sampleAliases.has(match[2]!))
          .map((match) => match[1]!),
      );
      const native = inferredNativeMethods(prefix, source, receiver);
      const hostLabels =
        receiver === 'rms'
          ? ['source', 'seeds', 'generate', 'id']
          : receiver && sampleAliases.has(receiver)
            ? ['seed', 'map', 'request_hash', 'map_hash', 'warnings', 'metrics', 'expect', 'report']
            : receiver && mapAliases.has(receiver)
              ? [
                  'width',
                  'height',
                  'hash',
                  'tile',
                  'tiles',
                  'count_tiles',
                  'objects',
                  'walls',
                  'cliffs',
                  'connections',
                  'neighbors',
                  'manhattan_distance',
                  'chebyshev_distance',
                  'squared_distance',
                  'boundaries',
                  'components',
                  'connected',
                ]
              : null;
      const nativeCompletions =
        native ?? (receiver && !hostLabels ? starlarkFallbackNativeMethods : null);
      const completions: StarlarkNativeCompletion[] = hostLabels
        ? hostLabels.map((label) => ({
            label,
            detail: t('code-editor.completion.map-test'),
            documentation: mapTestHostDocumentation.get(label),
          }))
        : (nativeCompletions ??
          [
            ...starlarkVisibleBindings(sourceBeforeCursor),
            ...starlarkGlobalCompletions.map((label) => ({
              label,
              detail: t(
                label === 'rms'
                  ? 'code-editor.completion.map-test'
                  : 'code-editor.completion.starlark-built-in',
              ),
              documentation: mapTestHostDocumentation.get(label),
              sortText: `1_${label}`,
            })),
          ].filter(
            (completion, index, all) =>
              all.findIndex((candidate) => candidate.label === completion.label) === index,
          ));
      return {
        suggestions: completions.map((completion) => ({
          label: completion.label,
          kind:
            completion.kind ??
            (completion.label === 'rms'
              ? monaco.languages.CompletionItemKind.Module
              : nativeCompletions
                ? monaco.languages.CompletionItemKind.Method
                : [
                      'source',
                      'seeds',
                      'generate',
                      'id',
                      'expect',
                      'report',
                      'tile',
                      'tiles',
                      'count_tiles',
                      'objects',
                      'walls',
                      'cliffs',
                      'connections',
                      'neighbors',
                      'manhattan_distance',
                      'chebyshev_distance',
                      'squared_distance',
                      'boundaries',
                      'components',
                      'connected',
                    ].includes(completion.label)
                  ? monaco.languages.CompletionItemKind.Method
                  : hostLabels
                    ? monaco.languages.CompletionItemKind.Property
                    : monaco.languages.CompletionItemKind.Function),
          detail: completion.detail,
          documentation: completion.documentation,
          insertText: completion.label,
          range,
          sortText: completion.sortText,
        })),
      };
    },
  });
  monaco.languages.registerHoverProvider('starlark', {
    provideHover: (model, position) => {
      const word = model.getWordAtPosition(position);
      const value = word
        ? (mapTestHostDocumentation.get(word.word) ?? starlarkNativeDocumentation.get(word.word))
        : undefined;
      return value && word
        ? {
            range: new monaco.Range(
              position.lineNumber,
              word.startColumn,
              position.lineNumber,
              word.endColumn,
            ),
            contents: [{ value }],
          }
        : null;
    },
  });
  monaco.languages.registerSignatureHelpProvider('starlark', {
    signatureHelpTriggerCharacters: ['(', ','],
    provideSignatureHelp: (model, position) => {
      const prefix = model.getValueInRange(
        new monaco.Range(
          Math.max(1, position.lineNumber - 8),
          1,
          position.lineNumber,
          position.column,
        ),
      );
      const signatures = [
        [
          'rms.source',
          'rms.source(path = None)',
          'Selects the default/pinned or explicit authorized RMS source.',
        ],
        [
          'rms.seeds',
          'rms.seeds(start, count = 1, step = 1)',
          'Creates a checked deterministic uint32 sequence.',
        ],
        [
          'rms.generate',
          'rms.generate(target, seeds, preview = True)',
          'Generates immutable samples in seed order.',
        ],
        [
          'sample.expect',
          'sample.expect(condition, message, values = None, code = None)',
          'Records a failed assertion and continues.',
        ],
        [
          'sample.report',
          'sample.report(message, values = None, code = None)',
          'Records an unconditional finding.',
        ],
        [
          '.format',
          'string.format(*args, **kwargs)',
          'Substitutes positional or named values into `{}` fields.',
        ],
      ] as const;
      const nearest = signatures
        .map((signature) => ({
          index: prefix.lastIndexOf(`${signature[0]}(`),
          signature,
        }))
        .filter(({ index }) => index >= 0)
        .sort((left, right) => right.index - left.index)[0];
      if (!nearest) return null;
      const match = nearest.signature;
      return {
        value: {
          signatures: [{ label: match[1], documentation: match[2], parameters: [] }],
          activeSignature: 0,
          activeParameter: Math.max(0, prefix.slice(nearest.index).split(',').length - 1),
        },
        dispose: () => undefined,
      };
    },
  });
}

function conciseFormattingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^-?\d+:\s*/, '').replace(/^formatting is unavailable:\s*/i, '');
}

function isLspTextEdit(value: unknown): value is LspTextEdit {
  if (!value || typeof value !== 'object') return false;
  const edit = value as Partial<LspTextEdit>;
  return typeof edit.newText === 'string' && isLspRange(edit.range);
}

function isLspDocumentSymbol(value: unknown): value is LspDocumentSymbol {
  if (!value || typeof value !== 'object') return false;
  const symbol = value as Partial<LspDocumentSymbol>;
  return (
    typeof symbol.name === 'string' &&
    typeof symbol.kind === 'number' &&
    isLspRange(symbol.range) &&
    isLspRange(symbol.selectionRange)
  );
}

function isLspRange(value: unknown): value is LspRange {
  if (!value || typeof value !== 'object') return false;
  const range = value as Partial<LspRange>;
  return isLspPosition(range.start) && isLspPosition(range.end);
}

function isLspPosition(value: unknown): value is LspPosition {
  if (!value || typeof value !== 'object') return false;
  const position = value as Partial<LspPosition>;
  return (
    Number.isInteger(position.line) &&
    Number.isInteger(position.character) &&
    (position.line ?? -1) >= 0 &&
    (position.character ?? -1) >= 0
  );
}

function toMonacoEditOperation(edit: LspTextEdit): monaco.editor.IIdentifiedSingleEditOperation {
  return { range: toMonacoRangeObject(edit.range), text: edit.newText };
}

function transformSelectionOffsets(
  model: monaco.editor.ITextModel,
  selection: monaco.Selection,
  edits: monaco.editor.IIdentifiedSingleEditOperation[],
): { anchorOffset: number; activeOffset: number } {
  const anchoredOffset = model.getOffsetAt({
    lineNumber: selection.selectionStartLineNumber,
    column: selection.selectionStartColumn,
  });
  const activeOffset = model.getOffsetAt({
    lineNumber: selection.positionLineNumber,
    column: selection.positionColumn,
  });
  const offsets = edits
    .map((edit) => ({
      start: model.getOffsetAt({
        lineNumber: edit.range.startLineNumber,
        column: edit.range.startColumn,
      }),
      end: model.getOffsetAt({
        lineNumber: edit.range.endLineNumber,
        column: edit.range.endColumn,
      }),
      replacementLength: edit.text?.length ?? 0,
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  return {
    anchorOffset: transformOffset(anchoredOffset, offsets),
    activeOffset: transformOffset(activeOffset, offsets),
  };
}

function transformOffset(
  original: number,
  edits: Array<{ start: number; end: number; replacementLength: number }>,
): number {
  let delta = 0;
  for (const edit of edits) {
    if (original < edit.start) break;
    if (original >= edit.end) {
      delta += edit.replacementLength - (edit.end - edit.start);
      continue;
    }
    return edit.start + delta + Math.min(original - edit.start, edit.replacementLength);
  }
  return original + delta;
}

function textDocumentParams(model: monaco.editor.ITextModel) {
  return { textDocument: { uri: model.uri.toString() } };
}

function positionParams(model: monaco.editor.ITextModel, position: monaco.Position) {
  return {
    ...textDocumentParams(model),
    position: { line: position.lineNumber - 1, character: position.column - 1 },
  };
}

function toMonacoRange(range: LspRange) {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function toMonacoRangeObject(range: LspRange): monaco.Range {
  const value = toMonacoRange(range);
  return new monaco.Range(
    value.startLineNumber,
    value.startColumn,
    value.endLineNumber,
    value.endColumn,
  );
}

function toMonacoLocation(location: LspLocation): monaco.languages.Location {
  return { uri: monaco.Uri.parse(location.uri), range: toMonacoRangeObject(location.range) };
}

function toMonacoTextEdit(edit: LspTextEdit): monaco.languages.TextEdit {
  return { range: toMonacoRangeObject(edit.range), text: edit.newText };
}

function toMonacoSymbol(symbol: LspDocumentSymbol): monaco.languages.DocumentSymbol {
  return {
    name: symbol.name,
    detail: symbol.detail ?? '',
    kind: symbolKind(symbol.kind),
    tags: [],
    range: toMonacoRangeObject(symbol.range),
    selectionRange: toMonacoRangeObject(symbol.selectionRange),
    children: symbol.children?.map(toMonacoSymbol),
  };
}

function completionKind(kind?: number): monaco.languages.CompletionItemKind {
  if (kind === 3) return monaco.languages.CompletionItemKind.Function;
  if (kind === 10) return monaco.languages.CompletionItemKind.Property;
  if (kind === 6) return monaco.languages.CompletionItemKind.Variable;
  if (kind === 21) return monaco.languages.CompletionItemKind.Constant;
  if (kind === 7) return monaco.languages.CompletionItemKind.Class;
  if (kind === 5) return monaco.languages.CompletionItemKind.Field;
  if (kind === 23) return monaco.languages.CompletionItemKind.Event;
  if (kind === 15) return monaco.languages.CompletionItemKind.Snippet;
  if (kind === 17) return monaco.languages.CompletionItemKind.File;
  if (kind === 19) return monaco.languages.CompletionItemKind.Folder;
  return monaco.languages.CompletionItemKind.Keyword;
}

function symbolKind(kind: number): monaco.languages.SymbolKind {
  if (kind === 3) return monaco.languages.SymbolKind.Namespace;
  if (kind === 12) return monaco.languages.SymbolKind.Function;
  if (kind === 7) return monaco.languages.SymbolKind.Property;
  if (kind === 14) return monaco.languages.SymbolKind.Constant;
  if (kind === 1) return monaco.languages.SymbolKind.File;
  if (kind === 17) return monaco.languages.SymbolKind.Boolean;
  if (kind === 13) return monaco.languages.SymbolKind.Variable;
  if (kind === 5) return monaco.languages.SymbolKind.Class;
  if (kind === 8) return monaco.languages.SymbolKind.Field;
  return monaco.languages.SymbolKind.Event;
}

function markdownDocumentation(
  value?: string | { kind?: string; value?: string },
): string | monaco.IMarkdownString | undefined {
  if (typeof value === 'string') return value;
  if (!value?.value) return undefined;
  return value.kind === 'markdown' ? { value: value.value } : value.value;
}

function markerTags(diagnostic: LanguageServerDiagnostic): monaco.MarkerTag[] {
  const tags = (diagnostic as { tags?: unknown }).tags;
  if (!Array.isArray(tags)) return [];
  return tags.flatMap((tag) =>
    tag === 1 ? [monaco.MarkerTag.Unnecessary] : tag === 2 ? [monaco.MarkerTag.Deprecated] : [],
  );
}

function markerSeverity(severity?: number): monaco.MarkerSeverity {
  if (severity === 1) return monaco.MarkerSeverity.Error;
  if (severity === 2) return monaco.MarkerSeverity.Warning;
  if (severity === 3) return monaco.MarkerSeverity.Info;
  return monaco.MarkerSeverity.Hint;
}

function isLanguageDiagnostic(value: unknown): value is LanguageServerDiagnostic {
  if (!value || typeof value !== 'object') return false;
  const diagnostic = value as Partial<LanguageServerDiagnostic>;
  return (
    typeof diagnostic.message === 'string' &&
    typeof diagnostic.range?.start?.line === 'number' &&
    typeof diagnostic.range.start.character === 'number' &&
    typeof diagnostic.range.end?.line === 'number' &&
    typeof diagnostic.range.end.character === 'number'
  );
}
