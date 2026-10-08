import { sentence } from './output-message';
import { step, type CatalogAction, type CatalogHeadline, type CatalogText } from './catalog-text';
import { t } from './i18n/translator';

interface LintFacts {
  core: string;
}

export interface RmsLintCatalogEntry {
  severity?: 'info' | 'warning' | 'error';
  headline: CatalogHeadline<LintFacts>;
  cause?: CatalogText<LintFacts>;
  action?: CatalogAction<LintFacts>;
}

function quoted(facts: LintFacts, index = 0): string | null {
  const names = [...facts.core.matchAll(/'([^'\n]{1,80})'/gu)].map((match) => match[1]!);
  return names[index] ?? null;
}

function leadingName(facts: LintFacts): string | null {
  return /^(#?[A-Za-z_][\w%]*)\b/u.exec(facts.core.trim())?.[1] ?? null;
}

function asSentence(text: string | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return sentence(trimmed.charAt(0).toUpperCase() + trimmed.slice(1));
}

function undefinedWordForAName(facts: LintFacts): boolean {
  return /: \S+ is not a defined name where it reads a name/u.test(facts.core);
}

function clauses(facts: LintFacts, separator: string): [string, string | undefined] {
  const core = facts.core.trim().replace(/\.$/u, '');
  const index = core.indexOf(separator);
  return index < 0
    ? [core, undefined]
    : [core.slice(0, index), core.slice(index + separator.length)];
}

export const rmsLintCatalog: Record<string, RmsLintCatalogEntry> = {
  RMS4001: {
    headline: (facts) => {
      const name = quoted(facts);
      return name ? t('message.RMS4001.headline.named', { name }) : t('message.RMS4001.headline');
    },
    cause: 'message.RMS4001.cause',
    action: (facts) => {
      const suggestion = quoted(facts, 1);
      return suggestion
        ? { label: t('message.RMS4001.action.suggestion', { suggestion }) }
        : step('message.RMS4001.action');
    },
  },
  RMS4002: {
    severity: 'info',
    headline: (facts) => {
      const name = quoted(facts);
      return name ? t('message.RMS4002.headline.named', { name }) : t('message.RMS4002.headline');
    },
    cause: 'message.RMS4002.cause',
    action: step('message.action.use-or-remove'),
  },
  RMS4003: {
    headline: (facts) => clauses(facts, '; ')[0] || t('message.RMS4003.headline'),
    cause: (facts) => asSentence(clauses(facts, '; ')[1]) ?? t('message.RMS4003.cause'),
    action: step('message.RMS4003.action'),
  },
  RMS4004: {
    headline: (facts) => {
      const name = leadingName(facts);
      return name ? t('message.RMS4004.headline.named', { name }) : t('message.RMS4004.headline');
    },
    cause: (facts) => {
      const line = /on line (\d+)/u.exec(facts.core)?.[1];
      return line ? t('message.RMS4004.cause.line', { line }) : t('message.RMS4004.cause');
    },
    action: step('message.RMS4004.action'),
  },
  RMS4005: {
    headline: 'message.RMS4005.headline',
    cause: (facts) => asSentence(clauses(facts, ': ')[1]),
    action: step('message.RMS4005.action'),
  },
  RMS4006: {
    severity: 'info',
    headline: 'message.RMS4006.headline',
    cause: 'message.RMS4006.cause',
    action: step('message.RMS4006.action'),
  },
  RMS4007: {
    headline: (facts) =>
      clauses(facts, facts.core.includes(': ') ? ': ' : ', ')[0] || t('message.RMS4007.headline'),
    cause: (facts) =>
      asSentence(clauses(facts, facts.core.includes(': ') ? ': ' : ', ')[1]) ??
      t('message.RMS4007.cause'),
    action: step('message.RMS4007.action'),
  },
  RMS4008: {
    headline: (facts) => {
      const name = leadingName(facts);
      return name ? t('message.RMS4008.headline.named', { name }) : t('message.RMS4008.headline');
    },
    cause: (facts) => asSentence(facts.core),
    action: step('message.RMS4008.action'),
  },
  RMS4009: {
    headline: (facts) => {
      const word = /^The game does not read (\S+) as/u.exec(facts.core.trim())?.[1];
      return word ? t('message.RMS4009.headline.named', { word }) : t('message.RMS4009.headline');
    },
    cause: (facts) => {
      const core = facts.core.trim();
      const dispatched = / runs the defined name (\S+) after it as the command (\S+?)\.?$/u.exec(
        core,
      );
      if (dispatched) {
        return t('message.RMS4009.cause.dispatches', {
          name: dispatched[1]!,
          command: dispatched[2]!,
        });
      }
      const command = / and runs (\S+) after it on this line\.?$/u.exec(core)?.[1];
      if (command) return t('message.RMS4009.cause.runs', { command });
      const word = / and acts on (\S+) after it on this line\.?$/u.exec(core)?.[1];
      if (word) return t('message.RMS4009.cause.acts', { word });
      if (/ It skips the words after it on this line\b/u.test(core)) {
        return t('message.RMS4009.cause.skipped');
      }
      return t('message.RMS4009.cause');
    },
    action: step('message.RMS4009.action'),
  },
  RMS4010: {
    headline: (facts) => {
      const command = /^The game ignores this (\S+?):/u.exec(facts.core.trim())?.[1];
      return command
        ? t('message.RMS4010.headline.named', { command })
        : t('message.RMS4010.headline');
    },
    cause: (facts) => {
      if (undefinedWordForAName(facts)) return t('message.RMS2034.cause');
      const number = /: (\S+) is a number where it reads a name/u.exec(facts.core)?.[1];
      return number ? t('message.RMS4010.cause.named', { number }) : t('message.RMS4010.cause');
    },
    action: (facts) =>
      step(undefinedWordForAName(facts) ? 'message.RMS2034.action' : 'message.RMS4010.action'),
  },
};
