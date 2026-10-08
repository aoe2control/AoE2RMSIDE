import type * as monaco from 'monaco-editor';

export const xsTypeWords = ['int', 'float', 'bool', 'string', 'vector', 'void'] as const;

export const xsControlWords = [
  'if',
  'then',
  'else',
  'for',
  'while',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'return',
  'goto',
] as const;

export const xsDeclarationWords = [
  'const',
  'static',
  'extern',
  'export',
  'mutable',
  'class',
  'rule',
  'include',
  'label',
  'dbg',
  'breakpoint',
  'active',
  'inactive',
  'minInterval',
  'maxInterval',
  'highFrequency',
  'runImmediately',
  'priority',
  'group',
  'infiniteLoopLimit',
  'infiniteRecursionLimit',
] as const;

export const xsLanguageConfiguration: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string', 'comment'] },
    { open: '/*', close: ' */', notIn: ['string'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
  ],
  wordPattern: /(-?\d*\.\d\w*)|([A-Za-z_]\w*)/u,
  indentationRules: {
    increaseIndentPattern: /^.*\{[^}"']*$/u,
    decreaseIndentPattern: /^\s*\}/u,
  },
  folding: {
    markers: {
      start: /^\s*\/\/\s*#?region\b/u,
      end: /^\s*\/\/\s*#?endregion\b/u,
    },
  },
};

export const xsMonarchLanguage: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '',
  ignoreCase: true,
  types: [...xsTypeWords],
  control: [...xsControlWords],
  declarations: [...xsDeclarationWords],
  tokenizer: {
    root: [
      [/\/\/.*$/u, 'comment'],
      [/\/\*/u, 'comment', '@comment'],
      [/"/u, 'string', '@string'],
      [/\b(?:true|false)\b/u, 'keyword'],
      [
        /[A-Za-z_]\w*(?=\s*\()/u,
        {
          cases: {
            '@types': 'keyword',
            '@control': 'control',
            '@declarations': 'keyword',
            '@default': 'function',
          },
        },
      ],
      [
        /[A-Za-z_]\w*/u,
        {
          cases: {
            '@types': 'keyword',
            '@control': 'control',
            '@declarations': 'keyword',
            '@default': 'variable',
          },
        },
      ],
      [/(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?/u, 'number'],
      [/[{}()]/u, '@brackets'],
      [/\+\+|--|==|!=|<=|>=|&&|\|\||[-+*/%=<>&|]/u, 'operator'],
      [/[;,.:]/u, 'delimiter'],
      [/\s+/u, ''],
    ],
    comment: [
      [/[^*]+/u, 'comment'],
      [/\*\//u, 'comment', '@pop'],
      [/\*/u, 'comment'],
    ],
    string: [
      [/[^"\\]+$/u, 'string', '@pop'],
      [/[^"\\]+/u, 'string'],
      [/\\./u, 'string'],
      [/"/u, 'string', '@pop'],
    ],
  },
};
