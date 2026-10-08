import { createHash } from 'node:crypto';
import type {
  ControlLivePreviewBinding,
  ControlLiveSynchronizationRequest,
  ControlSetupContext,
  PreviewGenerationInput,
} from '../shared/api';
import { compactSetupSuffix } from '../shared/lobby-options';

export function controlLiveDocumentSourceHash(source: string): string {
  return createHash('sha256').update(source.replace(/\r\n?/gu, '\n'), 'utf8').digest('hex');
}

export interface AuthorizedControlLivePreview {
  binding: Omit<ControlLivePreviewBinding, 'currentDocumentUri' | 'currentDocumentRevision'>;
  documentSourceHash: string;
  documentSourceLength: number;
  players: PreviewGenerationInput['players'];
  modeContext: string;
}

export function assertAuthorizedControlLivePreview(
  request: ControlLiveSynchronizationRequest,
  authorized: AuthorizedControlLivePreview | undefined,
  currentDocumentSource: { hash: string; length: number } | undefined,
): void {
  if (!authorized) {
    throw new Error('live testing requires a successful preview (stale-or-nonexact-preview)');
  }
  const mismatch = authorizedControlLivePreviewMismatch(request, authorized, currentDocumentSource);
  if (mismatch) {
    throw new Error(
      `live-test request does not match the authorized preview: ${mismatch} (stale-or-nonexact-preview)`,
    );
  }
}

function authorizedControlLivePreviewMismatch(
  request: ControlLiveSynchronizationRequest,
  authorized: AuthorizedControlLivePreview,
  currentDocumentSource: { hash: string; length: number } | undefined,
): string | undefined {
  const preview = request?.preview;
  if (!preview) return 'preview-missing';
  if (preview.currentDocumentUri !== authorized.binding.documentUri) {
    return 'current-document-uri';
  }
  if (preview.currentDocumentRevision !== authorized.binding.documentRevision) {
    return 'current-document-revision';
  }
  if (!currentDocumentSource) return 'language-document-missing';
  if (currentDocumentSource.hash !== authorized.documentSourceHash) {
    return `language-document-source-length-${currentDocumentSource.length}-${authorized.documentSourceLength}`;
  }
  for (const [key, value] of Object.entries(authorized.binding)) {
    if (preview[key as keyof ControlLivePreviewBinding] !== value) return `preview-${key}`;
  }
  if (!['1.0.0', '1.1.0', '1.2.0'].includes(request.setup.schemaVersion)) {
    return 'setup-schema-version';
  }
  if (request.setup.compatibility.minimumMajor !== 1) return 'setup-minimum-major';
  if (request.setup.compatibility.maximumMajor !== 1) return 'setup-maximum-major';
  if (request.setup.revealMap !== 'all-visible') return 'setup-reveal-map';
  if (request.setup.players.length !== authorized.players.length) return 'setup-player-count';
  for (const [index, player] of request.setup.players.entries()) {
    const previewPlayer = authorized.players[index];
    if (!previewPlayer) return 'setup-player-count';
    if (player.slot !== previewPlayer.slot) return `setup-player-${index + 1}-slot`;
    if (player.team !== previewPlayer.team) return `setup-player-${index + 1}-team`;
    if (player.civilizationId !== previewPlayer.civilizationId) {
      return `setup-player-${index + 1}-civilization`;
    }
  }
  if (authorized.modeContext !== controlModeContext(request.setup)) return 'setup-mode-context';
  return undefined;
}

function controlModeContext(setup: ControlSetupContext): string {
  const gameModes: Record<ControlSetupContext['gameMode'], number> = {
    'random-map': 0,
    regicide: 1,
    'death-match': 2,
    'king-of-the-hill': 5,
    'wonder-race': 6,
    'defend-the-wonder': 7,
    'turbo-random-map': 8,
    'capture-the-relic': 10,
    'sudden-death': 11,
    'battle-royale': 12,
    'empire-wars': 13,
  };
  const resources: Record<ControlSetupContext['startingResources'], number> = {
    standard: 0,
    low: 1,
    medium: 2,
    high: 3,
    'ultra-high': 4,
    infinite: 5,
    random: 6,
  };
  const ages: Record<ControlSetupContext['startingAge'], number> = {
    standard: 0,
    'dark-age': 2,
    'feudal-age': 3,
    'castle-age': 4,
    'imperial-age': 5,
    'post-imperial-age': 6,
  };
  const positions: Record<ControlSetupContext['positionPolicy'], number> = {
    random: 0,
    fixed: 1,
    'team-together': 2,
  };
  const suffix = compactSetupSuffix(setup.computerPlayerSlots ?? [], setup);
  return `aoe2:gm=${gameModes[setup.gameMode]};r=${resources[setup.startingResources]};a=${ages[setup.startingAge]};p=${positions[setup.positionPolicy]};c=${setup.players.map((player) => player.color).join(',')}${suffix}`;
}
