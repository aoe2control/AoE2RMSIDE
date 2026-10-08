import { t, type MessageId } from './i18n/translator';

export interface RmsLintRule {
  readonly code: string;
  readonly title: string;
}

function lintRule(code: string, title: MessageId): RmsLintRule {
  return Object.freeze({
    code,
    get title() {
      return t(title);
    },
  });
}

export const rmsLintRules: readonly RmsLintRule[] = Object.freeze([
  lintRule('RMS4001', 'lint-rule.RMS4001.title'),
  lintRule('RMS4002', 'lint-rule.RMS4002.title'),
  lintRule('RMS4003', 'lint-rule.RMS4003.title'),
  lintRule('RMS4004', 'lint-rule.RMS4004.title'),
  lintRule('RMS4005', 'lint-rule.RMS4005.title'),
  lintRule('RMS4006', 'lint-rule.RMS4006.title'),
  lintRule('RMS4007', 'lint-rule.RMS4007.title'),
  lintRule('RMS4008', 'lint-rule.RMS4008.title'),
  lintRule('RMS4009', 'lint-rule.RMS4009.title'),
  lintRule('RMS4010', 'lint-rule.RMS4010.title'),
  lintRule('RMS4011', 'lint-rule.RMS4011.title'),
]);

export const disableRmsLintRuleCommandId = 'rmside.disableRmsLintRule';

export function isRmsLintCode(value: unknown): value is string {
  return typeof value === 'string' && rmsLintRules.some((rule) => rule.code === value);
}

export interface RmsLintWorkspaceRules {
  workspace: string | null;
  disabled: string[];
}

export const maximumRmsLintWorkspaces = 64;

export function validateRmsLintWorkspaceRules(value: unknown): RmsLintWorkspaceRules[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumRmsLintWorkspaces) {
    throw new Error('RMS lint rule settings are invalid');
  }
  const seen = new Set<string | null>();
  return value.map((entry: unknown) => {
    const candidate = entry as Partial<RmsLintWorkspaceRules> | null;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      !(candidate.workspace === null || typeof candidate.workspace === 'string') ||
      (typeof candidate.workspace === 'string' && candidate.workspace.length > 32_768) ||
      !Array.isArray(candidate.disabled) ||
      candidate.disabled.length > rmsLintRules.length * 4
    ) {
      throw new Error('RMS lint rule settings are invalid');
    }
    if (seen.has(candidate.workspace)) throw new Error('RMS lint rule settings repeat a workspace');
    seen.add(candidate.workspace);
    return {
      workspace: candidate.workspace,
      disabled: [...new Set(candidate.disabled.filter(isRmsLintCode))].sort(),
    };
  });
}

export function disabledRmsLintRules(
  settings: readonly RmsLintWorkspaceRules[],
  workspace: string | null,
): string[] {
  return settings.find((entry) => entry.workspace === workspace)?.disabled ?? [];
}

export function withRmsLintRule(
  settings: readonly RmsLintWorkspaceRules[],
  workspace: string | null,
  code: string,
  enabled: boolean,
): RmsLintWorkspaceRules[] {
  if (!isRmsLintCode(code)) throw new Error(`${String(code)} is not an RMS lint rule`);
  const current = new Set(disabledRmsLintRules(settings, workspace));
  if (enabled) current.delete(code);
  else current.add(code);
  const others = settings.filter((entry) => entry.workspace !== workspace);
  const next =
    current.size === 0 ? others : [...others, { workspace, disabled: [...current].sort() }];
  return next.slice(Math.max(0, next.length - maximumRmsLintWorkspaces));
}
