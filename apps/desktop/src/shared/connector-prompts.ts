import { connectorBridgeLimits, isConnectorDisplayText } from './connector-api';
import { knownCrashReference, type KnownCrashReference } from './known-crashes';

export const connectorPromptKinds = ['deploy-replace', 'live-test', 'deploy-known-crash'] as const;
export type ConnectorPromptKind = (typeof connectorPromptKinds)[number];

export const connectorPromptLimits = Object.freeze({
  file: connectorBridgeLimits.factText,
  mod: 120,
  crashes: 8,
  minimumCloseAfterMs: 1_000,
  maximumCloseAfterMs: 60 * 60 * 1000,
});

interface ConnectorPromptBase {
  app: string;
  file: string;
  closeAfterMs?: number;
}

export type ConnectorPrompt =
  | (ConnectorPromptBase & { prompt: 'deploy-replace'; mod: string })
  | (ConnectorPromptBase & {
      prompt: 'live-test';
      seed: number;
      crashes?: KnownCrashReference[];
    })
  | (ConnectorPromptBase & {
      prompt: 'deploy-known-crash';
      mod: string;
      crashes: KnownCrashReference[];
    });

export type ConnectorPromptDecision = 'confirm' | 'cancel' | 'no-answer';

export interface ConnectorPromptAnswer {
  decision: ConnectorPromptDecision;
  allowForSession?: boolean;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${label} has the unknown field ${key}`);
  }
}

function text(value: unknown, maximum: number, label: string): string {
  if (!isConnectorDisplayText(value, 1, maximum)) {
    throw new Error(`${label} is not text of 1 to ${maximum} characters`);
  }
  return value as string;
}

function seed(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < -2147483648 ||
    (value as number) > 4294967295
  ) {
    throw new Error('prompt seed is not a seed');
  }
  return value as number;
}

function crashes(value: unknown, required: boolean): KnownCrashReference[] | undefined {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || value.length > connectorPromptLimits.crashes) {
    throw new Error(`prompt crashes is not a list of at most ${connectorPromptLimits.crashes}`);
  }
  const references = value.map((entry, index) => {
    const reference = knownCrashReference(entry);
    if (!reference) throw new Error(`prompt crashes[${index}] is not a known crash`);
    return reference;
  });
  if (required && references.length === 0) throw new Error('prompt crashes is empty');
  return references;
}

function closeAfter(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < connectorPromptLimits.minimumCloseAfterMs ||
    (value as number) > connectorPromptLimits.maximumCloseAfterMs
  ) {
    throw new Error('prompt closeAfterMs is out of range');
  }
  return value as number;
}

export function validateConnectorPrompt(value: unknown): ConnectorPrompt {
  const prompt = record(value, 'connector prompt');
  const kind = prompt.prompt;
  if (typeof kind !== 'string' || !(connectorPromptKinds as readonly string[]).includes(kind)) {
    throw new Error(`prompt kind is not one of ${connectorPromptKinds.join(', ')}`);
  }
  const base = {
    app: text(prompt.app, connectorBridgeLimits.displayName, 'prompt app'),
    file: text(prompt.file, connectorPromptLimits.file, 'prompt file'),
  };
  const close = closeAfter(prompt.closeAfterMs);
  const withClose = close === undefined ? {} : { closeAfterMs: close };
  if (kind === 'deploy-replace') {
    knownKeys(prompt, ['prompt', 'app', 'file', 'mod', 'closeAfterMs'], 'connector prompt');
    return {
      prompt: kind,
      ...base,
      mod: text(prompt.mod, connectorPromptLimits.mod, 'prompt mod'),
      ...withClose,
    };
  }
  if (kind === 'live-test') {
    knownKeys(prompt, ['prompt', 'app', 'file', 'seed', 'crashes', 'closeAfterMs'], 'prompt');
    const found = crashes(prompt.crashes, false);
    return {
      prompt: kind,
      ...base,
      seed: seed(prompt.seed),
      ...(found && found.length > 0 ? { crashes: found } : {}),
      ...withClose,
    };
  }
  knownKeys(prompt, ['prompt', 'app', 'file', 'mod', 'crashes', 'closeAfterMs'], 'prompt');
  return {
    prompt: 'deploy-known-crash',
    ...base,
    mod: text(prompt.mod, connectorPromptLimits.mod, 'prompt mod'),
    crashes: crashes(prompt.crashes, true)!,
    ...withClose,
  };
}

export function validateConnectorPromptAnswer(value: unknown): ConnectorPromptAnswer {
  const answer = record(value, 'prompt answer');
  knownKeys(answer, ['decision', 'allowForSession'], 'prompt answer');
  const decision = answer.decision;
  if (decision !== 'confirm' && decision !== 'cancel' && decision !== 'no-answer') {
    throw new Error('prompt decision is not confirm, cancel, or no-answer');
  }
  if (answer.allowForSession !== undefined && typeof answer.allowForSession !== 'boolean') {
    throw new Error('prompt allowForSession is not a boolean');
  }
  return {
    decision,
    ...(answer.allowForSession === true && decision === 'confirm' ? { allowForSession: true } : {}),
  };
}
