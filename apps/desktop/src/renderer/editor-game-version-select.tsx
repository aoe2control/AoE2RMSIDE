import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { InstallationReport } from '../shared/api';
import { presentMessage } from '../shared/message-catalog';
import { outputNote, type OutputMessage } from '../shared/output-message';
import {
  editorGameVersionOptions,
  localGameVersionLabel,
  resolveEditorGameVersion,
  type EditorGameVersionSelection,
} from './editor-game-version';
import {
  discoverGameInstallation,
  isUsableInstallation,
  onGameInstallationChanged,
  pickGameInstallation,
  refusedGameFolderMessage,
} from './game-installation';
import { useI18n } from './i18n';
import { SelectGameFolderItem } from './select-game-folder-button';

const localValue = '__local-game-version__';
const selectGameFolderValue = '__select-game-folder__';

export function EditorGameVersionSelect({
  appendOutput,
}: {
  appendOutput(message: OutputMessage): void;
}) {
  const { t } = useI18n();
  const options = useMemo(() => editorGameVersionOptions(), []);
  const [installation, setInstallation] = useState<InstallationReport | null>(null);
  const [busy, setBusy] = useState(true);
  const [selection, setSelection] = useState<EditorGameVersionSelection>('auto');
  const localProductVersion = installation?.evidence.productVersion?.value ?? null;
  const resolvedProfileId = resolveEditorGameVersion(selection, localProductVersion, options);

  const detect = useCallback(async () => {
    setBusy(true);
    try {
      setInstallation(await discoverGameInstallation());
    } catch {
      setInstallation(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void detect();
    return onGameInstallationChanged(() => void detect());
  }, [detect]);

  const versionOrigin = selection === 'auto' && installation !== null ? 'local' : 'packaged';
  useEffect(() => {
    void window.rmside
      .selectLanguageGameVersion(resolvedProfileId, versionOrigin)
      .catch(() => undefined);
  }, [resolvedProfileId, versionOrigin]);

  const pickFolder = useCallback(async () => {
    setBusy(true);
    try {
      const report = await pickGameInstallation();
      if (!report) return;
      if (isUsableInstallation(report)) {
        setInstallation(report);
        setSelection('auto');
        appendOutput(
          outputNote(
            'Game folder',
            'game-folder.linked',
            report.evidence.productVersion
              ? {
                  id: 'run-menu.game-folder.linked-version',
                  args: { version: report.evidence.productVersion.value },
                }
              : { id: 'run-menu.game-folder.linked' },
          ),
        );
      } else {
        appendOutput(refusedGameFolderMessage(report));
      }
    } catch (error) {
      appendOutput(
        presentMessage({
          source: 'Game folder',
          raw: error instanceof Error ? error.message : String(error),
          fallbackHeadline: 'message.fallback.game-folder',
        }),
      );
    } finally {
      setBusy(false);
    }
  }, [appendOutput]);

  const linked = installation !== null;
  const selectedValue = selection === 'auto' && linked ? localValue : resolvedProfileId;
  const selectedLabel =
    selection === 'auto' && linked
      ? localGameVersionLabel(localProductVersion)
      : (options.find((option) => option.profileId === resolvedProfileId)?.label ??
        t('run-menu.version.no-packaged'));

  return (
    <Select
      modal={false}
      onValueChange={(next) => {
        if (!next) return;
        if (next === selectGameFolderValue) {
          void pickFolder();
          return;
        }
        setSelection(next === localValue ? 'auto' : next);
      }}
      value={selectedValue}
    >
      <SelectTrigger
        aria-label={t('run-menu.version.game-version')}
        className="preview-version-trigger"
      >
        <SelectValue>{selectedLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent
        align="end"
        alignItemWithTrigger={false}
        className="preview-version-menu"
        collisionPadding={0}
        side="top"
      >
        {linked ? (
          <SelectItem value={localValue}>{localGameVersionLabel(localProductVersion)}</SelectItem>
        ) : (
          <SelectGameFolderItem disabled={busy} value={selectGameFolderValue} />
        )}
        {options.length > 0 ? <SelectSeparator /> : null}
        {options.map((option) => (
          <SelectItem key={option.profileId} value={option.profileId}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
