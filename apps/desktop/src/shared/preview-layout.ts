export const previewLayouts = ['side-by-side', 'behind-editor', 'editor-only'] as const;

export type PreviewLayout = (typeof previewLayouts)[number];

export const defaultPreviewLayout: PreviewLayout = 'side-by-side';

export function isPreviewLayout(value: unknown): value is PreviewLayout {
  return typeof value === 'string' && (previewLayouts as readonly string[]).includes(value);
}

export function nextPreviewLayout(layout: PreviewLayout): PreviewLayout {
  return previewLayouts[(previewLayouts.indexOf(layout) + 1) % previewLayouts.length]!;
}

export function previewLayoutShowsPreview(layout: PreviewLayout): boolean {
  return layout !== 'editor-only';
}

export function migratePreviewLayout(value: unknown, previewExpanded: boolean): PreviewLayout {
  if (value !== undefined) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 64) {
      throw new Error('preview layout is invalid');
    }
    if (isPreviewLayout(value)) return value;
  }
  return previewExpanded ? defaultPreviewLayout : 'editor-only';
}

export function previewLayoutShowsEditor(
  layout: PreviewLayout,
  overlayEditorShown: boolean,
): boolean {
  return layout !== 'behind-editor' || overlayEditorShown;
}

export function previewLayoutSwitchGlides(layout: PreviewLayout, from: PreviewLayout): boolean {
  return (
    (layout === 'behind-editor' && from === 'side-by-side') ||
    (layout === 'side-by-side' && from === 'behind-editor')
  );
}

export type EditorTabPressOutcome = 'activate' | 'hide-editor' | 'show-editor';

export function editorTabPressOutcome(
  layout: PreviewLayout,
  editorShown: boolean,
  tabIsActive: boolean,
): EditorTabPressOutcome {
  if (layout !== 'behind-editor') return 'activate';
  if (!editorShown) return 'show-editor';
  return tabIsActive ? 'hide-editor' : 'activate';
}

export const defaultOverlayEditorShown = false;

export function migrateOverlayEditorShown(value: unknown): boolean {
  if (value === undefined) return defaultOverlayEditorShown;
  if (typeof value !== 'boolean') throw new Error('editor visibility is invalid');
  return value;
}
