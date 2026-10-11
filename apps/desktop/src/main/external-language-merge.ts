import type { LspRange } from './external-language-position';
import { isLspRange } from './external-language-position';

export const externalRoutedMethods = [
  'textDocument/hover',
  'textDocument/completion',
  'textDocument/signatureHelp',
  'textDocument/definition',
] as const;
export type ExternalRoutedMethod = (typeof externalRoutedMethods)[number];

export function isExternalRoutedMethod(method: string): method is ExternalRoutedMethod {
  return (externalRoutedMethods as readonly string[]).includes(method);
}

const capabilityOf: Readonly<Record<ExternalRoutedMethod, string>> = {
  'textDocument/hover': 'hoverProvider',
  'textDocument/completion': 'completionProvider',
  'textDocument/signatureHelp': 'signatureHelpProvider',
  'textDocument/definition': 'definitionProvider',
};

export function serverSupports(method: ExternalRoutedMethod, capabilities: unknown): boolean {
  const value = (capabilities as Record<string, unknown> | null)?.[capabilityOf[method]];
  return value === true || (!!value && typeof value === 'object');
}

export type ExternalRoute = 'built-in' | 'external-first' | 'merge' | 'external-only' | 'none';

export function externalRoute(
  method: string,
  supported: boolean,
  fillGaps: boolean,
): ExternalRoute {
  if (!isExternalRoutedMethod(method)) return 'built-in';
  if (!supported) return fillGaps ? 'built-in' : 'none';
  if (!fillGaps) return 'external-only';
  return method === 'textDocument/completion' ? 'merge' : 'external-first';
}

export function isEmptyAnswer(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.signatures)) return record.signatures.length === 0;
  if (Array.isArray(record.items)) return record.items.length === 0;
  return false;
}

export const externalBounds = Object.freeze({
  diagnosticsPerDocument: 1_000,
  diagnosticMessage: 2_000,
  completionItems: 2_000,
  completionLabel: 256,
  completionDetail: 1_000,
  markdown: 16_000,
  signatures: 16,
  signatureParameters: 64,
  locations: 32,
  uri: 4_096,
});

export interface ExternalDiagnostic {
  range: LspRange;
  severity: number;
  code: string;
  source: string;
  message: string;
}

export interface MergeDiagnostic {
  range: LspRange;
  severity?: unknown;
  [key: string]: unknown;
}

function bounded(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function externalDiagnosticCode(prefix: string, code: unknown): string {
  const own =
    typeof code === 'string' || (typeof code === 'number' && Number.isFinite(code))
      ? String(code)
          .replace(/[^A-Za-z0-9._-]/gu, '')
          .slice(0, 64)
      : '';
  return own ? `${prefix}.${own}` : prefix;
}

export function attributeExternalDiagnostics(
  raw: unknown,
  server: { displayName: string; codePrefix: string },
  convertRange: (range: LspRange) => LspRange,
): ExternalDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  const diagnostics: ExternalDiagnostic[] = [];
  for (const entry of raw.slice(0, externalBounds.diagnosticsPerDocument)) {
    const value = entry as Record<string, unknown> | null;
    if (!value || typeof value !== 'object' || !isLspRange(value.range)) continue;
    if (typeof value.message !== 'string' || value.message.trim() === '') continue;
    const severity =
      typeof value.severity === 'number' && [1, 2, 3, 4].includes(value.severity)
        ? value.severity
        : 1;
    diagnostics.push({
      range: convertRange(value.range),
      severity,
      code: externalDiagnosticCode(server.codePrefix, value.code),
      source: server.displayName,
      message: bounded(value.message, externalBounds.diagnosticMessage),
    });
  }
  return diagnostics;
}

function overlapsOnStartLine(left: LspRange, right: LspRange): boolean {
  if (left.start.line !== right.start.line) return false;
  const leftEnd = left.end.line === left.start.line ? left.end.character : Number.MAX_SAFE_INTEGER;
  const rightEnd =
    right.end.line === right.start.line ? right.end.character : Number.MAX_SAFE_INTEGER;
  return left.start.character <= rightEnd && right.start.character <= leftEnd;
}

function severityOf(diagnostic: MergeDiagnostic): number {
  return typeof diagnostic.severity === 'number' ? diagnostic.severity : 1;
}

export function duplicatesExternal(
  builtIn: MergeDiagnostic,
  external: readonly ExternalDiagnostic[],
): boolean {
  if (!isLspRange(builtIn.range)) return false;
  return external.some(
    (finding) =>
      finding.severity === severityOf(builtIn) && overlapsOnStartLine(finding.range, builtIn.range),
  );
}

export function mergeDiagnostics<Diagnostic extends MergeDiagnostic>(
  builtIn: readonly Diagnostic[],
  external: readonly ExternalDiagnostic[],
  fillGaps: boolean,
): Array<Diagnostic | ExternalDiagnostic> {
  if (!fillGaps) return [...external];
  return [...external, ...builtIn.filter((finding) => !duplicatesExternal(finding, external))];
}

export function sanitizeExternalMarkdown(text: string): string {
  return bounded(
    text
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
      .replace(/!?\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/gu, '$1')
      .replace(/^[ \t]{0,3}\[[^\]\n]+\]:[^\n]*$/gmu, '')
      .replace(/<((?:https?|file|command|vscode):[^>\s]*)>/giu, '$1'),
    externalBounds.markdown,
  );
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|<>])/gu, '\\$1');
}

export function externalDocumentation(value: unknown): string | undefined {
  if (typeof value === 'string')
    return value ? sanitizeExternalMarkdown(escapeMarkdown(value)) : undefined;
  const markup = value as { kind?: unknown; value?: unknown } | null;
  if (!markup || typeof markup !== 'object' || typeof markup.value !== 'string' || !markup.value)
    return undefined;
  return sanitizeExternalMarkdown(
    markup.kind === 'markdown' ? markup.value : escapeMarkdown(markup.value),
  );
}

function hoverPart(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const part = value as { kind?: unknown; language?: unknown; value?: unknown } | null;
  if (!part || typeof part !== 'object' || typeof part.value !== 'string') return null;
  if (typeof part.language === 'string') {
    const language = part.language.replace(/[^\w+-]/gu, '').slice(0, 32);
    return `\`\`\`${language}\n${part.value.replaceAll('```', '`​``')}\n\`\`\``;
  }
  return part.kind === 'plaintext' ? escapeMarkdown(part.value) : part.value;
}

export function normalizeExternalHover(
  raw: unknown,
  convertRange: (range: LspRange) => LspRange,
): { contents: { kind: 'markdown'; value: string }; range?: LspRange } | null {
  const value = raw as { contents?: unknown; range?: unknown } | null;
  if (!value || typeof value !== 'object' || value.contents === undefined) return null;
  const parts = (Array.isArray(value.contents) ? value.contents : [value.contents])
    .slice(0, 16)
    .map(hoverPart)
    .filter((part): part is string => !!part && part.trim() !== '');
  if (parts.length === 0) return null;
  return {
    contents: { kind: 'markdown', value: sanitizeExternalMarkdown(parts.join('\n\n---\n\n')) },
    ...(isLspRange(value.range) ? { range: convertRange(value.range) } : {}),
  };
}

export interface ExternalCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: { kind: 'markdown'; value: string };
  insertText?: string;
  insertTextFormat?: number;
  filterText?: string;
  sortText?: string;
  tags?: number[];
}

export function normalizeExternalCompletion(
  raw: unknown,
): { isIncomplete: boolean; items: ExternalCompletionItem[] } | null {
  if (raw === null || raw === undefined) return null;
  const list = raw as { items?: unknown; isIncomplete?: unknown };
  const source = Array.isArray(raw) ? raw : Array.isArray(list.items) ? list.items : null;
  if (!source) return null;
  const items: ExternalCompletionItem[] = [];
  for (const entry of source.slice(0, externalBounds.completionItems)) {
    const value = entry as Record<string, unknown> | null;
    if (!value || typeof value !== 'object' || typeof value.label !== 'string' || !value.label)
      continue;
    const documentation = externalDocumentation(value.documentation);
    items.push({
      label: bounded(value.label, externalBounds.completionLabel),
      ...(Number.isInteger(value.kind) ? { kind: value.kind as number } : {}),
      ...(typeof value.detail === 'string'
        ? { detail: bounded(value.detail, externalBounds.completionDetail) }
        : {}),
      ...(documentation
        ? { documentation: { kind: 'markdown' as const, value: documentation } }
        : {}),
      ...(typeof value.insertText === 'string'
        ? { insertText: bounded(value.insertText, externalBounds.completionDetail) }
        : {}),
      ...(value.insertTextFormat === 2 ? { insertTextFormat: 2 } : {}),
      ...(typeof value.filterText === 'string'
        ? { filterText: bounded(value.filterText, externalBounds.completionLabel) }
        : {}),
      ...(typeof value.sortText === 'string'
        ? { sortText: bounded(value.sortText, externalBounds.completionLabel) }
        : {}),
      ...(Array.isArray(value.tags) && value.tags.includes(1) ? { tags: [1] } : {}),
    });
  }
  return { isIncomplete: !Array.isArray(raw) && list.isIncomplete === true, items };
}

export function mergeCompletion(
  external: { isIncomplete: boolean; items: ExternalCompletionItem[] },
  builtIn: unknown,
): Record<string, unknown> {
  const builtInList =
    builtIn && typeof builtIn === 'object' && !Array.isArray(builtIn)
      ? (builtIn as Record<string, unknown>)
      : {};
  const builtInItems = Array.isArray(builtIn)
    ? builtIn
    : Array.isArray(builtInList.items)
      ? builtInList.items
      : [];
  const labels = new Set(external.items.map((item) => item.label));
  return {
    ...builtInList,
    isIncomplete: external.isIncomplete || builtInList.isIncomplete === true,
    items: [
      ...external.items,
      ...builtInItems.filter(
        (item) => !labels.has((item as { label?: unknown } | null)?.label as string),
      ),
    ],
  };
}

export function normalizeExternalSignatureHelp(raw: unknown): {
  signatures: Array<{
    label: string;
    documentation?: { kind: 'markdown'; value: string };
    parameters?: Array<{
      label: string | [number, number];
      documentation?: { kind: 'markdown'; value: string };
    }>;
    activeParameter?: number;
  }>;
  activeSignature?: number;
  activeParameter?: number;
} | null {
  const value = raw as {
    signatures?: unknown;
    activeSignature?: unknown;
    activeParameter?: unknown;
  };
  if (!value || typeof value !== 'object' || !Array.isArray(value.signatures)) return null;
  const markdown = (documentation: unknown) => {
    const text = externalDocumentation(documentation);
    return text ? { documentation: { kind: 'markdown' as const, value: text } } : {};
  };
  const signatures = value.signatures.slice(0, externalBounds.signatures).flatMap((entry) => {
    const signature = entry as Record<string, unknown> | null;
    if (!signature || typeof signature.label !== 'string') return [];
    const label = bounded(signature.label, externalBounds.completionDetail);
    const parameters = Array.isArray(signature.parameters)
      ? signature.parameters.slice(0, externalBounds.signatureParameters).flatMap((item) => {
          const parameter = item as Record<string, unknown> | null;
          const raw = parameter?.label;
          const parameterLabel =
            typeof raw === 'string'
              ? bounded(raw, externalBounds.completionLabel)
              : Array.isArray(raw) &&
                  raw.length === 2 &&
                  raw.every((offset) => Number.isInteger(offset) && offset >= 0) &&
                  raw[0] <= raw[1] &&
                  raw[1] <= label.length
                ? ([raw[0], raw[1]] as [number, number])
                : null;
          return parameterLabel === null
            ? []
            : [{ label: parameterLabel, ...markdown(parameter?.documentation) }];
        })
      : undefined;
    return [
      {
        label,
        ...markdown(signature.documentation),
        ...(parameters ? { parameters } : {}),
        ...(Number.isInteger(signature.activeParameter)
          ? { activeParameter: signature.activeParameter as number }
          : {}),
      },
    ];
  });
  if (signatures.length === 0) return null;
  return {
    signatures,
    ...(Number.isInteger(value.activeSignature)
      ? { activeSignature: value.activeSignature as number }
      : {}),
    ...(Number.isInteger(value.activeParameter)
      ? { activeParameter: value.activeParameter as number }
      : {}),
  };
}

export interface ExternalLocation {
  uri: string;
  range: LspRange;
}

export function normalizeExternalLocations(raw: unknown): ExternalLocation[] {
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const locations: ExternalLocation[] = [];
  for (const entry of entries.slice(0, externalBounds.locations)) {
    const value = entry as Record<string, unknown> | null;
    if (!value || typeof value !== 'object') continue;
    const uri = typeof value.uri === 'string' ? value.uri : value.targetUri;
    const range = isLspRange(value.range)
      ? value.range
      : isLspRange(value.targetSelectionRange)
        ? value.targetSelectionRange
        : value.targetRange;
    if (
      typeof uri !== 'string' ||
      uri.length > externalBounds.uri ||
      !/^(?:file|untitled):/iu.test(uri) ||
      !isLspRange(range)
    )
      continue;
    locations.push({ uri, range });
  }
  return locations;
}
