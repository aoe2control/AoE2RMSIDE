import { join } from 'node:path';
import { t } from '../shared/i18n/translator';
import { FileTooLargeError, readFileBounded, replaceFileAtomically } from './bounded-file';
import {
  externalLanguageNames,
  externalLanguages,
  type ExternalLanguage,
} from './external-language-compatibility';

export interface ExternalLanguageSetting {
  use: boolean;
  fillGaps: boolean;
}

export type ExternalLanguageSettings = Readonly<Record<ExternalLanguage, ExternalLanguageSetting>>;

export const defaultExternalLanguageSetting: ExternalLanguageSetting = Object.freeze({
  use: true,
  fillGaps: true,
});

const settingsVersion = 1;
const maximumSettingsBytes = 4 * 1024;
export const externalLanguageSettingsFileName = 'external-language-servers-v1.json';

export function validateExternalLanguageSettings(value: unknown): ExternalLanguageSettings {
  const record = value as { version?: unknown; languages?: unknown } | null;
  const languages =
    record && typeof record === 'object' && record.version === settingsVersion
      ? (record.languages as Record<string, unknown> | null)
      : null;
  const settings = {} as Record<ExternalLanguage, ExternalLanguageSetting>;
  for (const language of externalLanguages) {
    const stored = (languages && typeof languages === 'object' ? languages[language] : null) as {
      use?: unknown;
      fillGaps?: unknown;
    } | null;
    settings[language] = {
      use: typeof stored?.use === 'boolean' ? stored.use : defaultExternalLanguageSetting.use,
      fillGaps:
        typeof stored?.fillGaps === 'boolean'
          ? stored.fillGaps
          : defaultExternalLanguageSetting.fillGaps,
    };
  }
  return settings;
}

export class ExternalLanguageSettingsStore {
  private readonly path: string;
  private pending: Promise<unknown> = Promise.resolve();
  private cached: ExternalLanguageSettings | undefined;

  constructor(userDataPath: string) {
    this.path = join(userDataPath, externalLanguageSettingsFileName);
  }

  read(): Promise<ExternalLanguageSettings> {
    return this.serialize(() => this.load());
  }

  update(
    language: ExternalLanguage,
    change: Partial<ExternalLanguageSetting>,
  ): Promise<ExternalLanguageSettings> {
    return this.serialize(async () => {
      const current = await this.load();
      const next: ExternalLanguageSettings = {
        ...current,
        [language]: { ...current[language], ...change },
      };
      await replaceFileAtomically(
        this.path,
        `${JSON.stringify({ version: settingsVersion, languages: next }, null, 2)}\n`,
      );
      this.cached = next;
      return next;
    });
  }

  private async load(): Promise<ExternalLanguageSettings> {
    if (this.cached) return this.cached;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(
        (await readFileBounded(this.path, maximumSettingsBytes)).toString('utf8'),
      );
    } catch (error) {
      const missing = (error as { code?: unknown } | null)?.code === 'ENOENT';
      if (!missing && !(error instanceof FileTooLargeError) && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    this.cached = validateExternalLanguageSettings(parsed);
    return this.cached;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => undefined);
    return next;
  }
}

export interface ExternalLanguageMenuServer {
  language: ExternalLanguage;
  displayName: string;
}

export type ExternalLanguageMenuEntry =
  | { kind: 'heading'; language: ExternalLanguage; label: string }
  | {
      kind: 'use' | 'fill-gaps';
      language: ExternalLanguage;
      label: string;
      checked: boolean;
      enabled: boolean;
    }
  | { kind: 'separator' };

export function externalLanguageMenu(
  servers: readonly ExternalLanguageMenuServer[],
  settings: ExternalLanguageSettings,
): { label: string; entries: ExternalLanguageMenuEntry[] } | null {
  const shown = externalLanguages.flatMap((language) =>
    servers.filter((server) => server.language === language).slice(0, 1),
  );
  if (shown.length === 0) return null;
  const entries: ExternalLanguageMenuEntry[] = [];
  for (const server of shown) {
    if (entries.length > 0) entries.push({ kind: 'separator' });
    const setting = settings[server.language];
    entries.push(
      {
        kind: 'heading',
        language: server.language,
        label: t('app-menu.view.external-language-server.name', {
          server: server.displayName,
          language: externalLanguageNames[server.language],
        }),
      },
      {
        kind: 'use',
        language: server.language,
        label: t('app-menu.view.external-language-server.use'),
        checked: setting.use,
        enabled: true,
      },
      {
        kind: 'fill-gaps',
        language: server.language,
        label: t('app-menu.view.external-language-server.fill-gaps'),
        checked: setting.fillGaps,
        enabled: setting.use,
      },
    );
  }
  return { label: t('app-menu.view.external-language-servers'), entries };
}
