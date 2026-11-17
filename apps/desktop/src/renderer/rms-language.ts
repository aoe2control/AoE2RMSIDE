import type * as monaco from 'monaco-editor';
import type { SourceLanguageId } from '../shared/xs-contract';

export function rmsLanguageConfigurationFor(
  indentConditionals: boolean,
  indentRandom = true,
): monaco.languages.LanguageConfiguration {
  const openers = [
    indentConditionals ? String.raw`(?:if|elseif|else)(?=\s|$)(?!.*\sendif(?:\s|$))` : null,
    indentRandom
      ? String.raw`(?:start_random|percent_chance)(?=\s|$)(?!.*\send_random(?:\s|$))`
      : null,
  ].filter((opener) => opener !== null);
  return {
    brackets: [
      ['{', '}'],
      ['(', ')'],
    ],
    colorizedBracketPairs: [['{', '}']],
    comments: { blockComment: ['/*', '*/'] },
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
    ],
    ...(openers.length > 0
      ? {
          indentationRules: {
            increaseIndentPattern: new RegExp(String.raw`^\s*(?:${openers.join('|')}).*$`, 'u'),
            decreaseIndentPattern: indentConditionals
              ? /^\s*(?:elseif|else|endif)(?=\s|$)/u
              : /(?!)/u,
          },
        }
      : {}),
  };
}

export const rmsLanguageConfiguration = rmsLanguageConfigurationFor(true);

export const rmsGluedWordToken = 'regexp.rms-glued-word';

export const rmsMonarchLanguage: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '',
  tokenizer: {
    root: [
      [/[ \t\v\f]+/u, ''],
      [/\/\*(?=\s|$)/u, 'comment', '@blockComment'],
      [/"[^"]*"?/u, 'string'],
      [/'[^']*'?/u, 'string'],
      [/\*\/(?=\s|$)/u, 'comment'],
      [/[{}](?=\s|$)/u, 'delimiter.curly'],
      [/[^\s{}]*[{}][^\s]*/u, rmsGluedWordToken],
      [/[^\s]+/u, ''],
    ],
    blockComment: [
      [/[ \t\v\f]+/u, 'comment'],
      [/\*\/(?=\s|$)/u, 'comment', '@pop'],
      [/\/\*(?=\s|$)/u, 'comment', '@push'],
      [/[^\s]+/u, 'comment'],
    ],
  },
};

export function bracketColorizationFor(
  languageId: SourceLanguageId,
): monaco.editor.BracketPairColorizationOptions {
  return { enabled: languageId !== 'xs', independentColorPoolPerBracketType: false };
}
