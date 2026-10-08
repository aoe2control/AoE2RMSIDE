import type { ExternalLinkTarget } from './api';
import { isExternalLinkTarget } from './external-links';
import { messageIdPattern } from './i18n/message-format';
import {
  activeTranslator,
  englishTranslator,
  t,
  type MessageId,
  type Translator,
} from './i18n/translator';

export type OutputSeverity = 'info' | 'warning' | 'error';

export const outputSources = [
  'Run',
  'Script',
  'Preview',
  'Map test',
  'Deploy',
  'Live test',
  'Recovery',
  'Update',
  'Files',
  'Game folder',
  'Game textures',
  'App',
] as const;
export type OutputSource = (typeof outputSources)[number];

const outputSourceLabels: Readonly<Record<OutputSource, MessageId>> = {
  Run: 'output.source.run',
  Script: 'output.source.script',
  Preview: 'output.source.preview',
  'Map test': 'output.source.map-test',
  Deploy: 'output.source.deploy',
  'Live test': 'output.source.live-test',
  Recovery: 'output.source.recovery',
  Update: 'output.source.update',
  Files: 'output.source.files',
  'Game folder': 'output.source.game-folder',
  'Game textures': 'output.source.game-textures',
  App: 'output.source.app',
};

export function outputSourceLabel(source: OutputSource): string {
  return t(outputSourceLabels[source]);
}

export type OutputArgument = string | number | OutputText | readonly (string | OutputText)[];

export interface OutputText {
  id: MessageId;
  args?: Readonly<Record<string, OutputArgument>>;
}

export type OutputWords = string | OutputText;

export function wordOutputWords(words: OutputWords): string {
  return typeof words === 'string' ? words : wordOutputText(words);
}

export interface OutputCatalogWording {
  kind: 'catalog';
  source: OutputSource;
  code: string | null;
  raw?: string;
  params?: Readonly<Record<string, string | number>>;
  fallbackHeadline?: OutputText;
  severity?: OutputSeverity;
  standardIncludeAccess?: 'packaged-selection' | 'no-linked-installation' | 'missing-gamedata';
  place?: { name: string; line: number | null };
}

export interface OutputTextWording {
  kind: 'text';
  headline?: OutputText;
  cause?: OutputText;
  action?: OutputText;
}

export type OutputWording = OutputTextWording | OutputCatalogWording;

export interface OutputAction {
  label: string;
  link?: ExternalLinkTarget;
}

export interface OutputMessage {
  code: string;
  severity: OutputSeverity;
  source: OutputSource;
  headline: string;
  cause?: string;
  action?: OutputAction;
  detail?: string;
  monospace?: boolean;
  wording?: OutputWording;
}

export const outputMessageLimits = {
  code: 96,
  headline: 600,
  cause: 600,
  action: 200,
  detail: 4_000,
} as const;

const codePattern = /^[A-Za-z0-9._:-]{1,96}$/u;

export function validateOutputMessage(value: unknown): OutputMessage | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const { code, severity, source, headline, cause, action, detail, monospace, wording } = candidate;
  if (typeof code !== 'string' || !codePattern.test(code)) return null;
  if (severity !== 'info' && severity !== 'warning' && severity !== 'error') return null;
  if (typeof source !== 'string' || !(outputSources as readonly string[]).includes(source)) {
    return null;
  }
  if (typeof headline !== 'string' || headline.trim() === '') return null;
  if (cause !== undefined && typeof cause !== 'string') return null;
  if (detail !== undefined && typeof detail !== 'string') return null;
  if (monospace !== undefined && typeof monospace !== 'boolean') return null;
  const validatedWording = wording === undefined ? undefined : validateOutputWording(wording);
  if (validatedWording === null) return null;
  let validatedAction: OutputAction | undefined;
  if (action !== undefined) {
    if (!action || typeof action !== 'object') return null;
    const { label, link } = action as Record<string, unknown>;
    if (typeof label !== 'string' || label.trim() === '') return null;
    if (link !== undefined && !isExternalLinkTarget(link)) {
      return null;
    }
    validatedAction = {
      label: bounded(label, outputMessageLimits.action),
      ...(link === undefined ? {} : { link: link as ExternalLinkTarget }),
    };
  }
  return {
    code,
    severity,
    source: source as OutputSource,
    headline: bounded(headline, outputMessageLimits.headline),
    ...(cause ? { cause: bounded(cause, outputMessageLimits.cause) } : {}),
    ...(validatedAction ? { action: validatedAction } : {}),
    ...(detail ? { detail: bounded(detail, outputMessageLimits.detail) } : {}),
    ...(monospace ? { monospace: true } : {}),
    ...(validatedWording ? { wording: validatedWording } : {}),
  };
}

const maximumArguments = 16;
const maximumArgumentText = 600;
const maximumListItems = 32;
const maximumTextDepth = 4;
const argumentNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateOutputText(value: unknown, depth = 0): OutputText | null {
  if (!isPlainRecord(value) || depth > maximumTextDepth) return null;
  const { id, args } = value;
  if (Object.keys(value).some((key) => key !== 'id' && key !== 'args')) return null;
  if (typeof id !== 'string' || id.length > 160 || !messageIdPattern.test(id)) return null;
  if (args === undefined) return { id: id as MessageId };
  if (!isPlainRecord(args) || Object.keys(args).length > maximumArguments) return null;
  const copied: Record<string, OutputArgument> = {};
  for (const [name, argument] of Object.entries(args)) {
    if (!argumentNamePattern.test(name)) return null;
    const checked = validateArgument(argument, depth);
    if (checked === null) return null;
    copied[name] = checked;
  }
  return { id: id as MessageId, args: copied };
}

function validateArgument(value: unknown, depth: number): OutputArgument | null {
  if (typeof value === 'string') return value.length <= maximumArgumentText ? value : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    if (value.length > maximumListItems) return null;
    const items: (string | OutputText)[] = [];
    for (const item of value as unknown[]) {
      const checked =
        typeof item === 'string'
          ? item.length <= maximumArgumentText
            ? item
            : null
          : validateOutputText(item, depth + 1);
      if (checked === null) return null;
      items.push(checked);
    }
    return items;
  }
  return validateOutputText(value, depth + 1);
}

const standardIncludeAccessValues = [
  'packaged-selection',
  'no-linked-installation',
  'missing-gamedata',
] as const;

const catalogWordingKeys = new Set([
  'kind',
  'source',
  'code',
  'raw',
  'params',
  'fallbackHeadline',
  'severity',
  'standardIncludeAccess',
  'place',
]);

export function validateOutputWording(value: unknown): OutputWording | null {
  if (!isPlainRecord(value)) return null;
  if (value.kind === 'text') {
    const wording: OutputTextWording = { kind: 'text' };
    for (const part of ['headline', 'cause', 'action'] as const) {
      if (value[part] === undefined) continue;
      const text = validateOutputText(value[part]);
      if (!text) return null;
      wording[part] = text;
    }
    return Object.keys(value).every((key) => key in wording) ? wording : null;
  }
  if (value.kind !== 'catalog') return null;
  if (!Object.keys(value).every((key) => catalogWordingKeys.has(key))) return null;
  const { source, code, raw, params, fallbackHeadline, severity, standardIncludeAccess, place } =
    value;
  if (typeof source !== 'string' || !(outputSources as readonly string[]).includes(source)) {
    return null;
  }
  if (code !== null && (typeof code !== 'string' || !codePattern.test(code))) return null;
  if (raw !== undefined && (typeof raw !== 'string' || raw.length > outputMessageLimits.detail)) {
    return null;
  }
  const wording: OutputCatalogWording = { kind: 'catalog', source: source as OutputSource, code };
  if (raw !== undefined) wording.raw = raw;
  if (params !== undefined) {
    if (!isPlainRecord(params) || Object.keys(params).length > maximumArguments) return null;
    const copied: Record<string, string | number> = {};
    for (const [name, param] of Object.entries(params)) {
      if (!argumentNamePattern.test(name)) return null;
      if (typeof param === 'string' && param.length <= maximumArgumentText) copied[name] = param;
      else if (typeof param === 'number' && Number.isFinite(param)) copied[name] = param;
      else return null;
    }
    wording.params = copied;
  }
  if (fallbackHeadline !== undefined) {
    const text = validateOutputText(fallbackHeadline);
    if (!text) return null;
    wording.fallbackHeadline = text;
  }
  if (severity !== undefined) {
    if (severity !== 'info' && severity !== 'warning' && severity !== 'error') return null;
    wording.severity = severity;
  }
  if (standardIncludeAccess !== undefined) {
    if (!(standardIncludeAccessValues as readonly unknown[]).includes(standardIncludeAccess)) {
      return null;
    }
    wording.standardIncludeAccess =
      standardIncludeAccess as OutputCatalogWording['standardIncludeAccess'];
  }
  if (place !== undefined) {
    if (!isPlainRecord(place)) return null;
    const { name, line } = place;
    if (typeof name !== 'string' || name.length < 1 || name.length > 260) return null;
    if (line !== null && !(Number.isInteger(line) && (line as number) > 0)) return null;
    wording.place = { name, line: line as number | null };
  }
  return wording;
}

export function wordOutputText(
  text: OutputText,
  translator: Translator = activeTranslator(),
): string {
  const args: Record<string, string | number | readonly string[]> = {};
  for (const [name, argument] of Object.entries(text.args ?? {})) {
    if (typeof argument === 'string' || typeof argument === 'number') args[name] = argument;
    else if (Array.isArray(argument)) {
      args[name] = (argument as readonly (string | OutputText)[]).map((item) =>
        typeof item === 'string' ? item : wordOutputText(item, translator),
      );
    } else args[name] = wordOutputText(argument as OutputText, translator);
  }
  return translator.t(text.id, args);
}

export function rewordOutputText(message: OutputMessage): OutputMessage {
  const wording = message.wording;
  if (wording?.kind !== 'text') return message;
  return {
    ...message,
    ...(wording.headline ? { headline: wordOutputText(wording.headline) } : {}),
    ...(wording.cause ? { cause: wordOutputText(wording.cause) } : {}),
    ...(wording.action && message.action
      ? { action: { ...message.action, label: wordOutputText(wording.action) } }
      : {}),
  };
}

export function outputMessageText(message: OutputMessage): string {
  return [message.headline, message.cause, message.action?.label]
    .filter((part): part is string => Boolean(part))
    .map((part) => sentence(part))
    .join(' ');
}

export type OutputNoteAction = OutputAction | { text: OutputText; link?: ExternalLinkTarget };

export interface OutputNoteExtra {
  cause?: string | OutputText;
  action?: OutputNoteAction;
  detail?: string;
  severity?: OutputSeverity;
}

export function outputNote(
  source: OutputSource,
  code: string,
  headline: string | OutputText,
  extra: OutputNoteExtra = {},
): OutputMessage {
  const wording: OutputTextWording = { kind: 'text' };
  const word = (part: string | OutputText, name: 'headline' | 'cause' | 'action'): string => {
    if (typeof part === 'string') return part;
    wording[name] = part;
    return wordOutputText(part);
  };
  const { cause, action, detail, severity } = extra;
  let wordedAction: OutputAction | undefined;
  if (action) {
    const label = 'text' in action ? word(action.text, 'action') : action.label;
    wordedAction = { label, ...(action.link ? { link: action.link } : {}) };
  }
  const message: OutputMessage = {
    code,
    severity: severity ?? 'info',
    source,
    headline: word(headline, 'headline'),
    ...(cause !== undefined ? { cause: word(cause, 'cause') } : {}),
    ...(wordedAction ? { action: wordedAction } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
  return Object.keys(wording).length > 1 ? { ...message, wording } : message;
}

const sentenceEnd = /[.!?…:。！？：।]$/u;

export function sentence(text: string, translator: Translator = activeTranslator()): string {
  const trimmed = text.trim();
  return sentenceEnd.test(trimmed)
    ? trimmed
    : translator.t('message.format.sentence', { text: trimmed });
}

export function engineSentence(text: string): string {
  const trimmed = text.trim();
  const firstWord = /^\S*/u.exec(trimmed)![0];
  const scriptWord = /[_#<>(]|\.\w/u.test(firstWord);
  return sentence(
    scriptWord ? trimmed : trimmed.charAt(0).toLocaleUpperCase('en') + trimmed.slice(1),
    englishTranslator,
  );
}

function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}
