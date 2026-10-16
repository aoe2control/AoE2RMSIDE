import type * as monaco from 'monaco-editor';
import type { ResolvedTheme } from '../shared/api';
import {
  defaultEditorColorScheme,
  editorColorSchemeIds,
  type EditorColorSchemeId,
} from '../shared/editor-color-scheme';
import type { CodeSemanticTokenType } from './semantic-tokens';

export const editorBackgrounds: Readonly<Record<ResolvedTheme, string>> = Object.freeze({
  light: '#f1f1f1',
  dark: '#171717',
});

export interface CodeColors {
  text: string;
  comment: string;
  keyword: string;
  control: string;
  section: string;
  command: string;
  attribute: string;
  number: string;
  string: string;
  constant: string;
  operator: string;
}

export interface MapTestColors {
  text: string;
  keyword: string;
  comment: string;
  string: string;
  number: string;
  identifier: string;
  type: string;
  decorator: string;
  function: string;
  property: string;
  delimiter: string;
  operator: string;
  invalid: string;
}

export interface BracketColors {
  first: string;
  second: string;
  third: string;
  unexpected: string;
}

export interface EditorColorHalf {
  foreground: string;
  code: CodeColors;
  mapTest: MapTestColors;
  brackets: BracketColors;
}

export interface EditorColorScheme {
  id: EditorColorSchemeId;
  name: string | null;
  light: EditorColorHalf;
  dark: EditorColorHalf;
}

const defaultScheme: EditorColorScheme = {
  id: 'default',
  name: null,
  light: {
    foreground: '#000000',
    code: {
      text: '#000000',
      comment: '#008000',
      keyword: '#808080',
      control: '#8F08C4',
      section: '#2B91AF',
      command: '#74531F',
      attribute: '#000000',
      number: '#098658',
      string: '#A31515',
      constant: '#1F377F',
      operator: '#000000',
    },
    mapTest: {
      text: '#000000',
      keyword: '#0000FF',
      comment: '#008000',
      string: '#A31515',
      number: '#098658',
      identifier: '#001080',
      type: '#267F99',
      decorator: '#795E26',
      function: '#795E26',
      property: '#000000',
      delimiter: '#000000',
      operator: '#000000',
      invalid: '#CD3131',
    },
    brackets: { first: '#0431FA', second: '#319331', third: '#7B3814', unexpected: '#CC0B0B' },
  },
  dark: {
    foreground: '#c8c8c8',
    code: {
      text: '#C8C8C8',
      comment: '#57A64A',
      keyword: '#9A9A9A',
      control: '#D8A0DF',
      section: '#4EC9B0',
      command: '#DCDCAA',
      attribute: '#DADADA',
      number: '#B5CEA8',
      string: '#D69D85',
      constant: '#9CDCFE',
      operator: '#B4B4B4',
    },
    mapTest: {
      text: '#CCCCCC',
      keyword: '#569CD6',
      comment: '#6A9955',
      string: '#CE9178',
      number: '#B5CEA8',
      identifier: '#9CDCFE',
      type: '#4EC9B0',
      decorator: '#DCDCAA',
      function: '#DCDCAA',
      property: '#DADADA',
      delimiter: '#CCCCCC',
      operator: '#D4D4D4',
      invalid: '#F44747',
    },
    brackets: { first: '#FFD700', second: '#DA70D6', third: '#179FFF', unexpected: '#FF1212CC' },
  },
};

const solarizedLight = {
  base00: '#5c7179',
  base01: '#586e75',
  base1: '#808d8d',
  yellow: '#8b6801',
  orange: '#c24307',
  red: '#d32727',
  magenta: '#c92b7a',
  violet: '#6266b8',
  blue: '#0072b5',
  cyan: '#047b74',
  green: '#667502',
};
const solarizedDark = {
  base0: '#839496',
  base1: '#93a1a1',
  base01: '#586e75',
  yellow: '#b58900',
  orange: '#d85725',
  red: '#ea413b',
  magenta: '#df428c',
  violet: '#7379cc',
  blue: '#268bd2',
  cyan: '#2aa198',
  green: '#859900',
};

function solarizedHalf(
  palette: Omit<typeof solarizedLight, 'base00' | 'base01' | 'base1'>,
  text: string,
  emphasis: string,
  comment: string,
): EditorColorHalf {
  return {
    foreground: text,
    code: {
      text,
      comment,
      keyword: palette.orange,
      control: palette.green,
      section: palette.yellow,
      command: palette.blue,
      attribute: emphasis,
      number: palette.magenta,
      string: palette.cyan,
      constant: palette.violet,
      operator: text,
    },
    mapTest: {
      text,
      keyword: palette.green,
      comment,
      string: palette.cyan,
      number: palette.magenta,
      identifier: text,
      type: palette.yellow,
      decorator: palette.orange,
      function: palette.blue,
      property: emphasis,
      delimiter: text,
      operator: text,
      invalid: palette.red,
    },
    brackets: {
      first: palette.yellow,
      second: palette.magenta,
      third: palette.blue,
      unexpected: palette.red,
    },
  };
}

const solarized: EditorColorScheme = {
  id: 'solarized',
  name: 'Solarized',
  light: solarizedHalf(
    solarizedLight,
    solarizedLight.base00,
    solarizedLight.base01,
    solarizedLight.base1,
  ),
  dark: solarizedHalf(
    solarizedDark,
    solarizedDark.base0,
    solarizedDark.base1,
    solarizedDark.base01,
  ),
};

const catppuccinLatte = {
  text: '#4c4f69',
  overlay2: '#7c7f93',
  overlay2Text: '#6a6d80',
  pink: '#b14296',
  mauve: '#8839ef',
  red: '#d20f39',
  peach: '#be4700',
  yellow: '#9d6001',
  green: '#217f02',
  sky: '#0275a4',
  sapphire: '#04798b',
  blue: '#1b63f1',
  lavender: '#5363d5',
};
const catppuccinMocha = {
  text: '#cdd6f4',
  overlay2: '#9399b2',
  overlay2Text: '#9399b2',
  pink: '#f5c2e7',
  mauve: '#cba6f7',
  red: '#f38ba8',
  peach: '#fab387',
  yellow: '#f9e2af',
  green: '#a6e3a1',
  sky: '#89dceb',
  sapphire: '#74c7ec',
  blue: '#89b4fa',
  lavender: '#b4befe',
};

function catppuccinHalf(palette: typeof catppuccinLatte): EditorColorHalf {
  return {
    foreground: palette.text,
    code: {
      text: palette.text,
      comment: palette.overlay2,
      keyword: palette.pink,
      control: palette.mauve,
      section: palette.yellow,
      command: palette.blue,
      attribute: palette.lavender,
      number: palette.peach,
      string: palette.green,
      constant: palette.peach,
      operator: palette.sky,
    },
    mapTest: {
      text: palette.text,
      keyword: palette.mauve,
      comment: palette.overlay2,
      string: palette.green,
      number: palette.peach,
      identifier: palette.text,
      type: palette.yellow,
      decorator: palette.pink,
      function: palette.blue,
      property: palette.lavender,
      delimiter: palette.overlay2Text,
      operator: palette.sky,
      invalid: palette.red,
    },
    brackets: {
      first: palette.peach,
      second: palette.mauve,
      third: palette.sapphire,
      unexpected: palette.red,
    },
  };
}

const catppuccin: EditorColorScheme = {
  id: 'catppuccin',
  name: 'Catppuccin',
  light: catppuccinHalf(catppuccinLatte),
  dark: catppuccinHalf(catppuccinMocha),
};

const gruvboxLight = {
  fg: '#3c3836',
  gray: '#928374',
  red: '#9d0006',
  neutralRed: '#cc241d',
  green: '#767006',
  yellow: '#996201',
  blue: '#076678',
  purple: '#8f3f71',
  aqua: '#407956',
  orange: '#af3a03',
};
const gruvboxDark = {
  fg: '#ebdbb2',
  gray: '#928374',
  red: '#fb4934',
  neutralRed: '#fb4934',
  green: '#b8bb26',
  yellow: '#fabd2f',
  blue: '#83a598',
  purple: '#d3869b',
  aqua: '#8ec07c',
  orange: '#fe8019',
};

function gruvboxHalf(palette: typeof gruvboxLight): EditorColorHalf {
  return {
    foreground: palette.fg,
    code: {
      text: palette.fg,
      comment: palette.gray,
      keyword: palette.aqua,
      control: palette.red,
      section: palette.yellow,
      command: palette.green,
      attribute: palette.blue,
      number: palette.purple,
      string: palette.green,
      constant: palette.purple,
      operator: palette.fg,
    },
    mapTest: {
      text: palette.fg,
      keyword: palette.red,
      comment: palette.gray,
      string: palette.green,
      number: palette.purple,
      identifier: palette.blue,
      type: palette.yellow,
      decorator: palette.orange,
      function: palette.green,
      property: palette.aqua,
      delimiter: palette.fg,
      operator: palette.fg,
      invalid: palette.neutralRed,
    },
    brackets: {
      first: palette.yellow,
      second: palette.purple,
      third: palette.blue,
      unexpected: palette.neutralRed,
    },
  };
}

const gruvbox: EditorColorScheme = {
  id: 'gruvbox',
  name: 'Gruvbox',
  light: gruvboxHalf(gruvboxLight),
  dark: gruvboxHalf(gruvboxDark),
};

const ayuLight = {
  fg: '#5c6166',
  comment: '#898a8d',
  tag: '#017795',
  keyword: '#ae5501',
  entity: '#0273b3',
  func: '#976300',
  markup: '#be4448',
  constant: '#845cab',
  string: '#597800',
  operator: '#aa5729',
  special: '#8f662a',
  error: '#cb353a',
};
const ayuDark = {
  fg: '#bfbdb6',
  comment: '#626a73',
  tag: '#39bae6',
  keyword: '#ff8f40',
  entity: '#59c2ff',
  func: '#ffb454',
  markup: '#f07178',
  constant: '#d2a6ff',
  string: '#aad94c',
  operator: '#f29668',
  special: '#e6b673',
  error: '#d95757',
};

function ayuHalf(palette: typeof ayuLight): EditorColorHalf {
  return {
    foreground: palette.fg,
    code: {
      text: palette.fg,
      comment: palette.comment,
      keyword: palette.tag,
      control: palette.keyword,
      section: palette.entity,
      command: palette.func,
      attribute: palette.markup,
      number: palette.constant,
      string: palette.string,
      constant: palette.constant,
      operator: palette.operator,
    },
    mapTest: {
      text: palette.fg,
      keyword: palette.keyword,
      comment: palette.comment,
      string: palette.string,
      number: palette.constant,
      identifier: palette.fg,
      type: palette.entity,
      decorator: palette.special,
      function: palette.func,
      property: palette.markup,
      delimiter: palette.fg,
      operator: palette.operator,
      invalid: palette.error,
    },
    brackets: {
      first: palette.func,
      second: palette.constant,
      third: palette.entity,
      unexpected: palette.error,
    },
  };
}

const ayu: EditorColorScheme = {
  id: 'ayu',
  name: 'Ayu',
  light: ayuHalf(ayuLight),
  dark: ayuHalf(ayuDark),
};

const oneLight = {
  fg: '#383a42',
  comment: '#898a90',
  red: '#c73b31',
  darkRed: '#ca1243',
  green: '#2a7d2c',
  yellow: '#946402',
  orange: '#936503',
  blue: '#3066df',
  purple: '#a626a4',
  cyan: '#0075a8',
};
const oneDark = {
  fg: '#abb2bf',
  comment: '#5e6572',
  red: '#e06c75',
  darkRed: '#cd5e53',
  green: '#98c379',
  yellow: '#e5c07b',
  orange: '#d19a66',
  blue: '#61afef',
  purple: '#c678dd',
  cyan: '#56b6c2',
};

function oneHalf(palette: typeof oneLight): EditorColorHalf {
  return {
    foreground: palette.fg,
    code: {
      text: palette.fg,
      comment: palette.comment,
      keyword: palette.cyan,
      control: palette.purple,
      section: palette.yellow,
      command: palette.blue,
      attribute: palette.red,
      number: palette.orange,
      string: palette.green,
      constant: palette.orange,
      operator: palette.fg,
    },
    mapTest: {
      text: palette.fg,
      keyword: palette.purple,
      comment: palette.comment,
      string: palette.green,
      number: palette.orange,
      identifier: palette.fg,
      type: palette.yellow,
      decorator: palette.cyan,
      function: palette.blue,
      property: palette.red,
      delimiter: palette.fg,
      operator: palette.cyan,
      invalid: palette.darkRed,
    },
    brackets: {
      first: palette.yellow,
      second: palette.purple,
      third: palette.cyan,
      unexpected: palette.darkRed,
    },
  };
}

const one: EditorColorScheme = {
  id: 'one',
  name: 'One',
  light: oneHalf(oneLight),
  dark: oneHalf(oneDark),
};

const schemesById: Readonly<Record<EditorColorSchemeId, EditorColorScheme>> = {
  default: defaultScheme,
  solarized,
  catppuccin,
  gruvbox,
  ayu,
  one,
};

export const editorColorSchemes: readonly EditorColorScheme[] = Object.freeze(
  editorColorSchemeIds.map((id) => schemesById[id]),
);

export function editorColorScheme(id: EditorColorSchemeId): EditorColorScheme {
  return schemesById[id] ?? schemesById[defaultEditorColorScheme];
}

function ruleColor(color: string): string {
  return color.replace(/^#/u, '');
}

export const codeTokenRoles: Readonly<Record<CodeSemanticTokenType, keyof CodeColors>> =
  Object.freeze({
    comment: 'comment',
    keyword: 'keyword',
    control: 'control',
    namespace: 'section',
    function: 'command',
    property: 'attribute',
    number: 'number',
    string: 'string',
    variable: 'constant',
    operator: 'operator',
  });

export function codeTokenRules(half: EditorColorHalf): monaco.editor.ITokenThemeRule[] {
  const { code, mapTest } = half;
  return [
    { token: '', foreground: ruleColor(code.text) },
    ...Object.entries(codeTokenRoles).map(([token, role]) => ({
      token,
      foreground: ruleColor(code[role]),
    })),
    { token: 'keyword.python', foreground: ruleColor(mapTest.keyword) },
    { token: 'comment.python', foreground: ruleColor(mapTest.comment) },
    { token: 'string.python', foreground: ruleColor(mapTest.string) },
    { token: 'number.python', foreground: ruleColor(mapTest.number) },
  ];
}

export function mapTestTokenRules(half: EditorColorHalf): monaco.editor.ITokenThemeRule[] {
  const { mapTest } = half;
  return [
    { token: '', foreground: ruleColor(mapTest.text) },
    { token: 'function', foreground: ruleColor(mapTest.function) },
    { token: 'property', foreground: ruleColor(mapTest.property) },
    { token: 'identifier.python', foreground: ruleColor(mapTest.identifier) },
    { token: 'type.identifier.python', foreground: ruleColor(mapTest.type) },
    { token: 'tag.python', foreground: ruleColor(mapTest.decorator) },
    { token: 'keyword.python', foreground: ruleColor(mapTest.keyword) },
    { token: 'comment.python', foreground: ruleColor(mapTest.comment) },
    { token: 'string.python', foreground: ruleColor(mapTest.string) },
    { token: 'number.python', foreground: ruleColor(mapTest.number) },
    { token: 'delimiter.python', foreground: ruleColor(mapTest.delimiter) },
    { token: 'operator.python', foreground: ruleColor(mapTest.operator) },
    { token: 'invalid.python', foreground: ruleColor(mapTest.invalid) },
  ];
}

export function bracketColorKeys(half: EditorColorHalf): Record<string, string> {
  return {
    'editorBracketHighlight.foreground1': half.brackets.first,
    'editorBracketHighlight.foreground2': half.brackets.second,
    'editorBracketHighlight.foreground3': half.brackets.third,
    'editorBracketHighlight.unexpectedBracket.foreground': half.brackets.unexpected,
  };
}

export type EditorThemeFamily = 'code' | 'map-test';

export function editorThemeName(
  scheme: EditorColorSchemeId,
  theme: ResolvedTheme,
  family: EditorThemeFamily,
): string {
  return family === 'map-test' ? `rmside-${scheme}-map-test-${theme}` : `rmside-${scheme}-${theme}`;
}

export type PreviewRole = keyof CodeColors | 'bracket';

export const schemePreviewLines: ReadonlyArray<ReadonlyArray<readonly [string, PreviewRole]>> = [
  [['/* gold near every TC */', 'comment']],
  [
    ['#const', 'keyword'],
    [' ', 'text'],
    ['PILE_DISTANCE', 'constant'],
    [' ', 'text'],
    ['12', 'number'],
  ],
  [['<OBJECTS_GENERATION>', 'section']],
  [
    ['create_object', 'command'],
    [' ', 'text'],
    ['GOLD', 'constant'],
    [' ', 'text'],
    ['{', 'bracket'],
  ],
  [
    ['  ', 'text'],
    ['min_distance_to_players', 'attribute'],
    [' ', 'text'],
    ['9', 'number'],
  ],
  [
    ['  ', 'text'],
    ['if', 'control'],
    [' ', 'text'],
    ['TINY_MAP', 'constant'],
  ],
  [
    ['    ', 'text'],
    ['number_of_objects', 'attribute'],
    [' ', 'text'],
    ['4', 'number'],
  ],
  [
    ['  ', 'text'],
    ['endif', 'control'],
  ],
  [['}', 'bracket']],
];

export function previewRoleColor(half: EditorColorHalf, role: PreviewRole): string {
  return role === 'bracket' ? half.brackets.first : half.code[role];
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function parseHexColor(color: string): { rgb: [number, number, number]; alpha: number } {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/iu.exec(color);
  if (!match) throw new Error(`not a hex color: ${color}`);
  const hex = match[1]!;
  return {
    rgb: [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [
      number,
      number,
      number,
    ],
    alpha: match[2] ? Number.parseInt(match[2], 16) / 255 : 1,
  };
}

export function contrastRatio(foreground: string, background: string): number {
  const back = parseHexColor(background).rgb;
  const front = parseHexColor(foreground);
  const drawn = front.rgb.map(
    (value, index) => value * front.alpha + back[index]! * (1 - front.alpha),
  );
  const luminance = ([r, g, b]: number[]) =>
    0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
  const [high, low] = [luminance(drawn), luminance(back)].sort((a, b) => b - a);
  return (high! + 0.05) / (low! + 0.05);
}
