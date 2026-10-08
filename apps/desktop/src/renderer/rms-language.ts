import type * as monaco from 'monaco-editor';
import type { SourceLanguageId } from '../shared/xs-contract';

export function rmsLanguageConfigurationFor(
  indentConditionals: boolean,
): monaco.languages.LanguageConfiguration {
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
    ...(indentConditionals
      ? {
          indentationRules: {
            increaseIndentPattern: /^\s*(?:if|elseif|else)(?=\s|$)(?!.*\sendif(?:\s|$)).*$/u,
            decreaseIndentPattern: /^\s*(?:elseif|else|endif)(?=\s|$)/u,
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
