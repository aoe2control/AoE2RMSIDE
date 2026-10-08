import type { InstallationReport, RememberedInstallationSelection } from '../shared/api';
import { presentMessage } from '../shared/message-catalog';
import { outputMessageText, type OutputMessage } from '../shared/output-message';

const gameInstallationChangedEvent = 'rmside-game-installation-changed';

type UsableInstallationReport = InstallationReport & {
  valid: true;
};

export async function discoverGameInstallation(): Promise<InstallationReport | null> {
  const reports = await window.rmside.discoverInstallations();
  const remembered = await window.rmside.getRememberedInstallationSelection();
  return selectUsableInstallation(reports, remembered);
}

export async function pickGameInstallation(): Promise<InstallationReport | null> {
  const report = await window.rmside.pickManualInstallation();
  if (isUsableInstallation(report)) notifyGameInstallationChanged();
  return report;
}

export async function ensureGameInstallation(): Promise<InstallationReport | null> {
  const discovered = await discoverGameInstallation();
  if (discovered) {
    notifyGameInstallationChanged();
    return discovered;
  }
  return pickGameInstallation();
}

export async function unlinkGameInstallation(): Promise<void> {
  await window.rmside.forgetRememberedInstallationSelection();
  notifyGameInstallationChanged();
}

export function onGameInstallationChanged(listener: () => void): () => void {
  window.addEventListener(gameInstallationChangedEvent, listener);
  return () => window.removeEventListener(gameInstallationChangedEvent, listener);
}

export function isUsableInstallation(
  report: InstallationReport | null,
): report is UsableInstallationReport {
  return report?.valid === true;
}

function selectUsableInstallation(
  reports: readonly InstallationReport[],
  remembered: RememberedInstallationSelection | null,
): InstallationReport | null {
  if (!remembered) return null;
  return (
    reports.find(
      (report) =>
        isUsableInstallation(report) &&
        samePath(report.evidence.installationRoot.value, remembered.installationRoot),
    ) ?? null
  );
}

function notifyGameInstallationChanged(): void {
  window.dispatchEvent(new Event(gameInstallationChangedEvent));
}

function samePath(left: string, right: string): boolean {
  return (
    left.replaceAll('\\', '/').toLocaleLowerCase('en-US') ===
    right.replaceAll('\\', '/').toLocaleLowerCase('en-US')
  );
}

export function refusedGameFolderMessage(report: InstallationReport): OutputMessage {
  return presentMessage({
    source: 'Game folder',
    code: 'game-folder.not-steam',
    raw: report.uncertainty.join(' '),
  });
}

export function refusedGameFolderText(report: InstallationReport): string {
  return outputMessageText(refusedGameFolderMessage(report));
}
