import type { LocalPresentationName, LocalPresentationNames } from '../shared/api';
import { t } from '../shared/i18n/translator';

export const rmsCompletionTriggerCharacters = Object.freeze(['#', '<', '_', ' ', '/']);

export const monacoTriggerKind = Object.freeze({
  invoke: 0,
  triggerCharacter: 1,
  triggerForIncompleteCompletions: 2,
});

export function lspCompletionContext(context: { triggerKind: number; triggerCharacter?: string }): {
  triggerKind: 1 | 2 | 3;
  triggerCharacter?: string;
} {
  if (context.triggerKind === monacoTriggerKind.triggerCharacter) {
    return context.triggerCharacter === undefined
      ? { triggerKind: 2 }
      : { triggerKind: 2, triggerCharacter: context.triggerCharacter };
  }
  return {
    triggerKind: context.triggerKind === monacoTriggerKind.triggerForIncompleteCompletions ? 3 : 1,
  };
}

export type RmsContentKind = 'object' | 'terrain';

export function localContentNameAvailability(names: LocalPresentationNames | null): {
  localObjectNames: boolean;
  localTerrainNames: boolean;
} {
  const named = (entries: readonly LocalPresentationName[] | undefined) =>
    (entries ?? []).some((entry) => entry.constant !== null);
  return { localObjectNames: named(names?.objects), localTerrainNames: named(names?.terrains) };
}

export function rmsContentKindOf(list: unknown): RmsContentKind | null {
  const kind = (list as { itemDefaults?: { data?: { rmsContent?: unknown } } } | null)?.itemDefaults
    ?.data?.rmsContent;
  return kind === 'object' || kind === 'terrain' ? kind : null;
}

export interface RmsContentSuggestion {
  label: string;
  detail: string;
  sortText: string;
}

const maximumDetailLength = 60;

export function rmsContentSuggestions(
  names: LocalPresentationNames | null,
  kind: RmsContentKind,
  listed: ReadonlySet<string>,
): RmsContentSuggestion[] {
  const entries = (kind === 'object' ? names?.objects : names?.terrains) ?? [];
  const seen = new Set(listed);
  const suggestions: RmsContentSuggestion[] = [];
  for (const entry of entries) {
    const text = entry.displayName;
    const detail =
      text === null
        ? t(
            kind === 'object'
              ? 'code-editor.completion.content.object'
              : 'code-editor.completion.content.terrain',
            { id: entry.id },
          )
        : t('code-editor.completion.content.named', {
            name:
              text.length > maximumDetailLength
                ? `${text.slice(0, maximumDetailLength - 1)}…`
                : text,
            id: entry.id,
          });
    for (const constant of [entry.constant, ...entry.aliases]) {
      if (!constant || seen.has(constant)) continue;
      seen.add(constant);
      suggestions.push({ label: constant, detail, sortText: `2${constant}` });
    }
  }
  return suggestions;
}

export interface RmsCompletionRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export function rmsCompletionEdit(item: {
  textEdit?: unknown;
}): { range: RmsCompletionRange; text: string } | null {
  const edit = item.textEdit as { range?: RmsCompletionRange; newText?: unknown } | undefined;
  const range = edit?.range;
  const position = (value: unknown): value is { line: number; character: number } =>
    Number.isInteger((value as { line?: unknown } | null)?.line) &&
    Number.isInteger((value as { character?: unknown } | null)?.character);
  if (
    typeof edit?.newText !== 'string' ||
    !position(range?.start) ||
    !position(range?.end) ||
    range.start.line !== range.end.line ||
    range.start.character > range.end.character
  ) {
    return null;
  }
  return { range, text: edit.newText };
}

const triggerSuggestCommand = 'editor.action.triggerSuggest';

export function rmsCompletionCommand(item: {
  command?: unknown;
}): { id: string; title: string } | null {
  const command = item.command as { command?: unknown; title?: unknown } | undefined;
  if (command?.command !== triggerSuggestCommand) return null;
  return {
    id: triggerSuggestCommand,
    title: typeof command.title === 'string' ? command.title : 'Suggest',
  };
}

export const rmsSignatureHelpTriggerCharacters = Object.freeze([' ', '(', ',']);

export interface LspSignatureParameter {
  label: string | [number, number];
  documentation?: string | { kind?: string; value?: string };
}

export interface MonacoSignatureParameter {
  label: string | [number, number];
  documentation?: string | { value: string };
}

export function signatureParameters(
  parameters: readonly LspSignatureParameter[] | undefined,
): MonacoSignatureParameter[] {
  return (parameters ?? []).map((parameter) => {
    const documentation = parameter.documentation;
    if (documentation === undefined) return { label: parameter.label };
    if (typeof documentation === 'string') return { label: parameter.label, documentation };
    if (!documentation.value) return { label: parameter.label };
    return {
      label: parameter.label,
      documentation:
        documentation.kind === 'markdown' ? { value: documentation.value } : documentation.value,
    };
  });
}
