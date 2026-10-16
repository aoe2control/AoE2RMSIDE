export const editorColorSchemeIds = [
  'default',
  'solarized',
  'catppuccin',
  'gruvbox',
  'ayu',
  'one',
] as const;

export type EditorColorSchemeId = (typeof editorColorSchemeIds)[number];

export const defaultEditorColorScheme: EditorColorSchemeId = 'default';

export function isEditorColorSchemeId(value: unknown): value is EditorColorSchemeId {
  return typeof value === 'string' && (editorColorSchemeIds as readonly string[]).includes(value);
}
