import type { EditionCapabilities } from '../shared/edition';
import type { ExternalLinkTarget } from '../shared/external-links';
import { mapTestPreviewNotes } from '../shared/message-catalog';
import { t } from '../shared/i18n/translator';

export interface ThemePanelMenuItem {
  id: 'view.theme';
  label: string;
}

export function themePanelMenuItem(): ThemePanelMenuItem {
  return { id: 'view.theme', label: t('app-menu.view.theme-panel') };
}

export type HelpMenuItem =
  | { id: string; label: string; kind: 'link'; target: ExternalLinkTarget }
  | { id: 'help.about'; label: string; kind: 'about' };

export function helpMenuItems(
  capabilities: Pick<EditionCapabilities, 'documentation' | 'issueTracker'>,
  displayName: string,
): HelpMenuItem[] {
  return [
    ...(capabilities.documentation
      ? [
          {
            id: 'help.documentation',
            label: t('app-menu.help.documentation'),
            kind: 'link',
            target: 'rmside-documentation',
          } as const,
        ]
      : []),
    {
      id: 'help.join-discord',
      label: t('app-menu.help.join-discord'),
      kind: 'link',
      target: 'discord',
    },
    ...(capabilities.issueTracker
      ? [
          {
            id: 'help.report-bug',
            label: t('app-menu.help.report-bug'),
            kind: 'link',
            target: 'rmside-issues',
          } as const,
        ]
      : []),
    { id: 'help.about', label: t('app-menu.help.about', { product: displayName }), kind: 'about' },
  ];
}

export interface LiveGenerationStagesMenuState {
  enabled: boolean;
  note: { id: 'view.live-generation-stages-map-test-note'; label: string } | null;
}

export function liveGenerationStagesMenuState(
  mapTestPreviewShown: boolean,
): LiveGenerationStagesMenuState {
  return mapTestPreviewShown
    ? {
        enabled: false,
        note: {
          id: 'view.live-generation-stages-map-test-note',
          label: mapTestPreviewNotes.stages,
        },
      }
    : { enabled: true, note: null };
}

export function languageMenuItemVisible(languageCount: number): boolean {
  return languageCount > 1;
}
