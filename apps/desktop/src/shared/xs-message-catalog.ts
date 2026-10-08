import { engineSentence } from './output-message';
import { step, type CatalogAction, type CatalogHeadline, type CatalogText } from './catalog-text';
import { t, type MessageId } from './i18n/translator';

interface XsFacts {
  core: string;
}

export interface XsCatalogEntry {
  severity?: 'info' | 'warning' | 'error';
  headline: CatalogHeadline<XsFacts>;
  cause?: CatalogText<XsFacts>;
  action?: CatalogAction<XsFacts>;
}

const voidParameterList = /^XS has no '\(void\)' parameter list/u;

function quoted(facts: XsFacts, index = 0): string | null {
  const names = [...facts.core.matchAll(/'([^'\n]{1,80})'/gu)].map((match) => match[1]!);
  return names[index] ?? null;
}

function own(facts: XsFacts): string | null {
  const core = facts.core.trim();
  if (!core) return null;
  return engineSentence(core);
}

function about(withName: MessageId, generic: MessageId) {
  return (facts: XsFacts): string => {
    const name = quoted(facts);
    return name ? t(withName, { name }) : t(generic);
  };
}

export const xsCatalog: Record<string, XsCatalogEntry> = {
  XS1000: {
    headline: 'message.XS1000.headline',
    cause: 'message.XS1000.cause',
  },
  XS1001: {
    headline: 'message.XS1001.headline',
    cause: 'message.XS1001.cause',
    action: step('message.XS1001.action'),
  },
  XS1002: {
    headline: 'message.XS1002.headline',
    cause: 'message.XS1002.cause',
    action: step('message.XS1002.action'),
  },
  XS1003: {
    headline: 'message.XS1003.headline',
    cause: 'message.XS1003.cause',
    action: step('message.XS1003.action'),
  },
  XS1004: {
    headline: 'message.XS1004.headline',
    cause: 'message.XS1004.cause',
    action: step('message.XS1004.action'),
  },
  XS1005: {
    headline: 'message.XS1005.headline',
    cause: 'message.XS1005.cause',
  },
  XS1006: {
    headline: 'message.XS1006.headline',
    cause: 'message.XS1006.cause',
  },
  XS1007: {
    headline: 'message.XS1007.headline',
    cause: 'message.XS1007.cause',
    action: step('message.XS1007.action'),
  },
  XS1008: {
    headline: 'message.XS1008.headline',
  },
  XS1009: {
    severity: 'info',
    headline: 'message.XS1009.headline',
    cause: 'message.xs.cause.fix-shown',
  },
  XS2001: {
    headline: (facts) => {
      if (voidParameterList.test(facts.core)) return t('message.XS2001.headline.void');
      const expected = /^Expected (.+?), found/u.exec(facts.core)?.[1];
      if (!expected) return t('message.XS2001.headline');
      return t('message.XS2001.headline.expected', {
        expected: `${expected.charAt(0).toUpperCase()}${expected.slice(1)}`,
      });
    },
    cause: own,
    action: (facts) => {
      if (voidParameterList.test(facts.core)) {
        return step('message.XS2001.action.void');
      }
      return /^Expected ';'/u.test(facts.core) ? step('message.XS2001.action.semicolon') : null;
    },
  },
  XS2002: { headline: 'message.XS2002.headline', cause: own },
  XS2003: {
    headline: 'message.XS2003.headline',
    cause: 'message.XS2003.cause',
  },
  XS2004: {
    headline: about('message.XS2004.headline.named', 'message.XS2004.headline'),
    cause: 'message.XS2004.cause',
    action: (facts) => {
      const example = /for example '([^']+)'/u.exec(facts.core)?.[1];
      return example
        ? { label: t('message.XS2004.action.example', { example }) }
        : step('message.XS2004.action');
    },
  },
  XS2005: {
    headline: 'message.XS2005.headline',
    cause: 'message.XS2005.cause',
  },
  XS2006: { headline: 'message.XS2006.headline' },
  XS2007: {
    headline: 'message.XS2007.headline',
    cause: 'message.XS2007.cause',
    action: step('message.XS2007.action'),
  },
  XS2008: { headline: 'message.XS2008.headline', cause: own },
  XS2009: {
    headline: 'message.XS2009.headline',
    cause: 'message.XS2009.cause',
  },
  XS2010: {
    headline: 'message.XS2010.headline',
    cause: 'message.XS2010.cause',
  },
  XS2011: {
    headline: 'message.XS2011.headline',
  },
  XS2012: {
    headline: about('message.XS2012.headline.named', 'message.XS2012.headline'),
    cause: 'message.XS2012.cause',
    action: step('message.XS2012.action'),
  },
  XS2090: {
    headline: 'message.XS2090.headline',
    cause: 'message.XS2090.cause',
  },
  XS2091: {
    severity: 'info',
    headline: 'message.XS2091.headline',
    cause: 'message.xs.cause.fix-shown',
  },
  XS3001: {
    headline: about('message.XS3001.headline.named', 'message.XS3001.headline'),
    cause: 'message.XS3001.cause',
    action: step('message.XS3001.action'),
  },
  XS3002: {
    headline: about('message.XS3002.headline.named', 'message.XS3002.headline'),
    cause: 'message.XS3002.cause',
    action: step('message.XS3002.action'),
  },
  XS3003: {
    headline: about('message.XS3003.headline.named', 'message.XS3003.headline'),
    cause: 'message.XS3003.cause',
    action: step('message.XS3003.action'),
  },
  XS3004: {
    headline: about('message.XS3004.headline.named', 'message.XS3004.headline'),
    cause: own,
    action: step('message.XS3004.action'),
  },
  XS3005: {
    headline: about('message.XS3005.headline.named', 'message.XS3005.headline'),
    cause: 'message.XS3005.cause',
    action: step('message.action.choose-another-name'),
  },
  XS3006: { headline: 'message.XS3006.headline', cause: own },
  XS3007: { headline: 'message.XS3007.headline', cause: own },
  XS3008: {
    headline: about('message.XS3008.headline.named', 'message.XS3008.headline'),
    cause: (facts) => {
      const successor = quoted(facts, 1);
      return /renamed to/u.test(facts.core) && successor
        ? t('message.XS3008.cause.renamed', { successor })
        : null;
    },
    action: (facts) =>
      /renamed to/u.test(facts.core)
        ? step('message.XS3008.action.renamed')
        : step('message.XS3008.action'),
  },
  XS3009: {
    headline: about('message.XS3009.headline.named', 'message.XS3009.headline'),
    cause: own,
  },
  XS3010: {
    headline: 'message.XS3010.headline',
    cause: 'message.XS3010.cause',
  },
  XS3011: {
    headline: about('message.XS3011.headline.named', 'message.XS3011.headline'),
    cause: 'message.XS3011.cause',
    action: step('message.XS3011.action'),
  },
  XS3012: {
    headline: 'message.XS3012.headline',
    cause: 'message.XS3012.cause',
  },
  XS3013: { headline: 'message.XS3013.headline' },
  XS3014: { headline: 'message.XS3014.headline' },
  XS3015: {
    headline: about('message.XS3015.headline.named', 'message.XS3015.headline'),
    cause: 'message.XS3015.cause',
  },
  XS3016: {
    headline: 'message.XS3016.headline',
    cause: own,
  },
  XS3017: { headline: 'message.XS3017.headline', cause: own },
  XS3018: { headline: 'message.XS3018.headline' },
  XS3019: {
    headline: 'message.XS3019.headline',
    cause: 'message.XS3019.cause',
  },
  XS3020: { headline: 'message.XS3020.headline', cause: own },
  XS3021: {
    headline: about('message.XS3021.headline.named', 'message.XS3021.headline'),
    cause: 'message.XS3021.cause',
  },
  XS3022: {
    headline: 'message.XS3022.headline',
    cause: own,
    action: step('message.XS3022.action'),
  },
  XS3023: {
    headline: 'message.XS3023.headline',
    cause: 'message.XS3023.cause',
  },
  XS3024: { headline: 'message.XS3024.headline', cause: own },
  XS3025: { headline: 'message.XS3025.headline', cause: own },
  XS3026: { headline: 'message.XS3026.headline', cause: own },
  XS3027: {
    headline: 'message.XS3027.headline',
    cause: own,
  },
  XS3029: {
    headline: about('message.XS3029.headline.named', 'message.XS3029.headline'),
    cause: own,
  },
  XS3030: { headline: 'message.XS3030.headline', cause: own },
  XS4001: {
    headline: about('message.XS4001.headline.named', 'message.XS4001.headline'),
    cause: 'message.XS4001.cause',
    action: step('message.action.use-or-remove'),
  },
  XS4003: {
    headline: 'message.XS4003.headline',
    cause: 'message.XS4003.cause',
    action: step('message.XS4003.action'),
  },
  XS4004: {
    headline: about('message.XS4004.headline.named', 'message.XS4004.headline'),
    cause: 'message.XS4004.cause',
    action: step('message.XS4004.action'),
  },
  XS4005: {
    headline: about('message.XS4005.headline.named', 'message.XS4005.headline'),
    cause: 'message.XS4005.cause',
    action: step('message.XS4005.action'),
  },
  XS4006: {
    severity: 'info',
    headline: about('message.XS4006.headline.named', 'message.XS4006.headline'),
    cause: 'message.XS4006.cause',
  },
  XS4007: {
    severity: 'info',
    headline: about('message.XS4007.headline.named', 'message.XS4007.headline'),
    cause: 'message.XS4007.cause',
  },
  XS4008: {
    headline: about('message.XS4008.headline.named', 'message.XS4008.headline'),
    cause: 'message.XS4008.cause',
    action: step('message.action.choose-another-name'),
  },
  XS4009: {
    headline: about('message.XS4009.headline.named', 'message.XS4009.headline'),
    cause: 'message.XS4009.cause',
    action: step('message.XS4009.action'),
  },
  XS4010: {
    severity: 'info',
    headline: 'message.XS4010.headline',
    cause: 'message.XS4010.cause',
    action: step('message.XS4010.action'),
  },
  XS4012: {
    headline: about('message.XS4012.headline.named', 'message.XS4012.headline'),
    cause: 'message.XS4012.cause',
    action: step('message.XS4012.action'),
  },
  XS4013: {
    headline: 'message.XS4013.headline',
    cause: 'message.XS4013.cause',
    action: step('message.XS4013.action'),
  },
  XS4017: {
    headline: about('message.XS4017.headline.named', 'message.XS4017.headline'),
    cause: own,
    action: step('message.action.choose-another-name'),
  },
  XS4023: {
    headline: 'message.XS4023.headline',
    cause: own,
  },
  XS4024: {
    headline: about('message.XS4024.headline.named', 'message.XS4024.headline'),
    cause: 'message.XS4024.cause',
    action: step('message.action.choose-another-name'),
  },
  XS4025: {
    headline: 'message.XS4025.headline',
    cause: own,
    action: step('message.XS4025.action'),
  },
  XS4026: {
    headline: 'message.XS4026.headline',
    cause: 'message.XS4026.cause',
    action: step('message.XS4026.action'),
  },
  XS9001: {
    headline: 'message.XS9001.headline',
    cause: 'message.XS9001.cause',
  },
  XS9002: {
    severity: 'info',
    headline: 'message.XS9002.headline',
    cause: 'message.xs.cause.fix-shown',
  },
  XS: {
    headline: 'message.XS.headline',
    cause: own,
  },
};
