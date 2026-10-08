import type {
  OutputCatalogWording,
  OutputMessage,
  OutputSeverity,
  OutputSource,
  OutputText,
} from './output-message';
import { engineSentence, rewordOutputText, sentence, wordOutputText } from './output-message';
import { desktopErrorFacts, type DesktopErrorFacts } from './desktop-error';
import { xsCatalog } from './xs-message-catalog';
import { rmsLintCatalog } from './rms-lint-message-catalog';
import {
  linkStep,
  resolveCatalogAction,
  resolveCatalogText,
  resolveHeadline,
  step,
  type ActionRef,
  type CatalogAction,
  type CatalogHeadline,
  type CatalogText,
} from './catalog-text';
import {
  activeTranslator,
  englishTranslator,
  t,
  withTranslator,
  type MessageId,
} from './i18n/translator';

export type SourceLocator = (
  uri: string,
  byteOffset: number,
) => { name: string; line: number | null } | null;

export type StandardIncludeAccessHint =
  'packaged-selection' | 'no-linked-installation' | 'missing-gamedata';

export interface MessageInput {
  source: OutputSource;
  code?: string | null;
  raw?: string;
  params?: Readonly<Record<string, string | number | undefined>>;
  fallbackHeadline?: MessageId | OutputText;
  severity?: OutputSeverity;
  locate?: SourceLocator;
  standardIncludeAccess?: StandardIncludeAccessHint | null;
  place?: { name: string; line: number | null } | null;
}

export interface MessageFacts {
  text: string;
  core: string;
  code: string | null;
  location: string | null;
  place: { name: string; line: number | null } | null;
  params: Readonly<Record<string, string | number | undefined>>;
  standardIncludeAccess: StandardIncludeAccessHint | null;
}

export interface CatalogEntry {
  severity?: OutputSeverity;
  source?: OutputSource;
  headline?: CatalogHeadline<MessageFacts>;
  cause?: CatalogText<MessageFacts>;
  action?: CatalogAction<MessageFacts>;
}

const reportProblem: ActionRef = linkStep('message.action.report-problem', 'rmside-issues');
const getNewerControl: ActionRef = linkStep('message.action.get-newer-control', 'control-releases');

function playerSlots(slots: string): string {
  const list = slots
    .split(',')
    .map((slot) => slot.trim())
    .filter(Boolean)
    .map((slot) => t('message.format.player-slot', { slot }));
  if (list.length === 0) return t('message.format.player-slot-unknown');
  return activeTranslator().formatList(list);
}

function slotCount(slots: string): number {
  return Math.max(1, slots.split(',').filter((slot) => slot.trim()).length);
}

function playerSlotCorrection(
  missingSlots: string,
  playerSlots: string,
): { player: number; slot: number } | null {
  const missing = missingSlots
    .split(',')
    .map((slot) => Number(slot.trim()))
    .filter(Number.isInteger);
  const slots = playerSlots
    .split(',')
    .map((slot) => Number(slot.trim()))
    .filter((slot) => Number.isInteger(slot) && slot > 0);
  if (missing.length !== 1 || slots.length === 0) return null;
  const playerIndex = slots.indexOf(missing[0]!);
  if (playerIndex < 0) return null;
  const free = Array.from({ length: slots.length }, (_, index) => index + 1).filter(
    (slot) => !slots.includes(slot),
  );
  return free.length === 1 ? { player: playerIndex + 1, slot: free[0]! } : null;
}

function param(facts: MessageFacts, name: string): string {
  const value = facts.params[name];
  return value === undefined ? '' : String(value);
}

function engineCause(facts: MessageFacts): string | null {
  const core = facts.core.trim();
  if (!core || core === 'unknown error') return null;
  return engineSentence(core);
}

function profileXsFolder(facts: MessageFacts): string | null {
  return /[Yy]our profile's XS folder \(([^()]+)\)/u.exec(facts.core)?.[1] ?? null;
}

function strictReason(facts: MessageFacts, lead: string): string | null {
  const core = facts.core.trim();
  const index = core.indexOf(lead);
  if (index < 0)
    return facts.location ? locatedCause(facts, engineCause(facts) ?? '') : engineCause(facts);
  const reason = core.slice(index + lead.length).trim();
  if (!reason) return null;
  const text = engineSentence(reason);
  return facts.location ? locatedCause(facts, text) : text;
}

function locatedCause(facts: MessageFacts, text: string): string {
  return facts.location ? t('message.format.located', { location: facts.location, text }) : text;
}

function scriptSubject(facts: MessageFacts): string {
  return facts.location ?? t('message.format.the-script');
}

const standardIncludeAction = (facts: MessageFacts): ActionRef => {
  switch (facts.standardIncludeAccess) {
    case 'no-linked-installation':
      return step('message.action.link-game-folder');
    case 'missing-gamedata':
      return step('message.action.verify-game-files');
    default:
      return step('message.action.select-local-game-version');
  }
};

const rmsCatalog: Record<string, CatalogEntry> = {
  RMS2021: {
    headline: (facts) => {
      const standard = /Standard game include '([^'\n]+)'/u.exec(facts.core);
      if (standard) return t('message.RMS2021.headline.standard', { include: standard[1] });
      const missing = /include was not found: (\S+)/u.exec(facts.core);
      if (missing) return t('message.RMS2021.headline.missing', { include: missing[1] });
      if (/include cycle/u.test(facts.core)) return t('message.RMS2021.headline.cycle');
      return t('message.RMS2021.headline');
    },
    cause: (facts) => {
      const standard = /Standard game include '([^'\n]+)'/u.exec(facts.core);
      if (standard) {
        return t('message.RMS2021.cause.standard', {
          subject: scriptSubject(facts),
          include: standard[1],
        });
      }
      const missing = /include was not found: (\S+)/u.exec(facts.core);
      if (missing) {
        return t('message.RMS2021.cause.missing', {
          subject: scriptSubject(facts),
          include: missing[1],
        });
      }
      if (/include cycle/u.test(facts.core)) {
        return t('message.RMS2021.cause.cycle', { subject: scriptSubject(facts) });
      }
      return facts.location ? locatedCause(facts, engineCause(facts) ?? '') : engineCause(facts);
    },
    action: (facts) => {
      if (/Standard game include/u.test(facts.core)) return standardIncludeAction(facts);
      if (/include was not found/u.test(facts.core)) {
        return step('message.action.check-include-name');
      }
      return null;
    },
  },
  RMS2042: {
    headline: 'message.RMS2042.headline',
    cause: (facts) => strictReason(facts, 'The game crashes on this script: '),
    action: step('message.action.open-problems'),
  },
  RMS2043: {
    headline: 'message.RMS2043.headline',
    cause: (facts) => strictReason(facts, 'The preview cannot show this script: '),
    action: step('message.action.open-problems'),
  },
  RMS: {
    headline: 'message.RMS.headline',
    cause: (facts) =>
      facts.location
        ? t('message.RMS.cause.located', { location: facts.location })
        : t('message.RMS.cause'),
    action: step('message.action.open-problems'),
  },
  'analysis.source-errors': {
    headline: 'message.RMS.headline',
    cause: 'message.RMS.cause',
    action: step('message.action.open-problems'),
  },
};

const generationCatalog: Record<string, CatalogEntry> = {
  RMSGEN1001: {
    headline: 'message.RMSGEN1001.headline',
    cause: 'message.RMSGEN1001.cause',
    action: step('message.action.choose-map-size'),
  },
  RMSGEN1005: {
    headline: 'message.RMSGEN1005.headline',
    cause: 'message.RMSGEN1005.cause',
    action: step('message.action.change-player-count'),
  },
  RMSGEN1006: {
    headline: 'message.RMSGEN1006.headline',
    cause: 'message.RMSGEN1006.cause',
    action: step('message.action.open-players-menu'),
  },
  RMSGEN1009: {
    headline: (facts) =>
      /lobby teams/u.test(facts.core)
        ? t('message.RMSGEN1009.headline.teams')
        : t('message.RMSGEN1009.headline'),
    cause: (facts) => {
      if (/lobby teams/u.test(facts.core)) return t('message.RMSGEN1009.cause.teams');
      const counts =
        /expands to (\d+) generation steps; .* up to (\d+)/u.exec(facts.core) ??
        /resolves to (\d+) semantic operations; .* bounded to (\d+)/u.exec(facts.core);
      return counts
        ? t('message.RMSGEN1009.cause.counts', {
            steps: Number(counts[1]),
            limit: Number(counts[2]),
          })
        : t('message.RMSGEN1009.cause');
    },
    action: (facts) =>
      /lobby teams/u.test(facts.core) ? step('message.action.open-players-menu') : null,
  },
  RMSGEN1010: {
    headline: 'message.RMSGEN1010.headline',
    cause: 'message.RMSGEN1010.cause',
    action: step('message.action.open-players-menu'),
  },
  RMSGEN2001: {
    headline: 'message.RMSGEN2001.headline',
    cause: 'message.RMSGEN2001.cause',
  },
  RMSGEN2002: {
    headline: (facts) => {
      const missing = /lobby slots? ([\d, ]+) (?:has|have) none/u.exec(facts.core);
      if (!missing) return t('message.RMSGEN2002.headline');
      return t('message.RMSGEN2002.headline.slots', {
        slots: playerSlots(missing[1]!),
        count: slotCount(missing[1]!),
      });
    },
    cause: (facts) => {
      if (/direct player lands require an explicit land_position/u.test(facts.core)) {
        return t('message.RMSGEN2002.cause.direct');
      }
      const assigned =
        /player lands went to slots ([\d, ]+)\)|only slot (\d+) received a player land/u.exec(
          facts.core,
        );
      if (assigned) {
        return t('message.RMSGEN2002.cause.assigned', {
          slots: playerSlots(assigned[1] ?? assigned[2]!),
        });
      }
      return t('message.RMSGEN2002.cause');
    },
    action: (facts) => {
      const missing = /lobby slots? ([\d, ]+) (?:has|have) none/u.exec(facts.core);
      if (!missing) return step('message.action.open-players-menu');
      const moved = playerSlotCorrection(missing[1]!, param(facts, 'playerSlots'));
      if (moved) {
        return {
          label: t('message.RMSGEN2002.action.move-back', {
            player: moved.player,
            slot: moved.slot,
          }),
        };
      }
      return {
        label: t('message.RMSGEN2002.action.move', {
          slots: playerSlots(missing[1]!),
          count: slotCount(missing[1]!),
        }),
      };
    },
  },
  RMSGEN5001: {
    severity: 'warning',
    headline: (facts) => {
      const objects = /objects? ([\d, ]+) (?:is|are) not defined/u.exec(facts.core);
      if (!objects) return t('message.RMSGEN5001.headline');
      return t('message.RMSGEN5001.headline.objects', {
        objects: objects[1],
        count: slotCount(objects[1]!),
      });
    },
    cause: 'message.RMSGEN5001.cause',
    action: step('message.action.select-local-game-version'),
  },
  RMSGEN7103: {
    headline: 'message.RMSGEN7103.headline',
    cause: (facts) => {
      const terrain = /uses terrain (\d+)/u.exec(facts.core)?.[1];
      return terrain ? t('message.RMSGEN7103.cause', { terrain }) : engineCause(facts);
    },
  },
  RMSGEN3002: {
    headline: 'message.RMSGEN3002.headline',
    cause: 'message.RMSGEN.cause.budget',
    action: step('message.action.try-another-seed'),
  },
  RMSGEN1: {
    headline: 'message.RMSGEN1.headline',
    cause: engineCause,
  },
  RMSGEN: {
    headline: 'message.RMSGEN.headline',
    cause: (facts) =>
      /exhausted (?:its|their) bounded/u.test(facts.core)
        ? t('message.RMSGEN.cause.budget')
        : engineCause(facts),
    action: (facts) =>
      /exhausted (?:its|their) bounded/u.test(facts.core)
        ? step('message.action.try-another-seed')
        : null,
  },
  RMSXS0001: {
    severity: 'info',
    headline: 'message.RMSXS0001.headline',
    cause: 'message.RMSXS0001.cause',
  },
  RMSXS: {
    severity: 'warning',
    headline: 'message.RMSXS.headline',
    cause: engineCause,
  },
  'content.invalid': {
    headline: 'message.content.invalid.headline',
    cause: (facts) => {
      const object = /object definition (\d+) is unavailable/u.exec(facts.core);
      return object
        ? t('message.content.invalid.cause.object', { object: object[1] })
        : engineCause(facts);
    },
    action: reportProblem,
  },
  'content.missing-definition': {
    headline: (facts) => {
      const match =
        /(object|terrain|cliff|definition) (\d+) is not (?:in the game data|defined by content pack)/u.exec(
          facts.core,
        ) ?? /does not define (\w+) (\d+)/u.exec(facts.core);
      return match
        ? t('message.content.missing-definition.headline.kind', {
            kind: `${match[1]!.charAt(0).toUpperCase()}${match[1]!.slice(1)}`,
            number: match[2],
          })
        : t('message.content.missing-definition.headline');
    },
    cause: (facts) => {
      const seed = /with seed (\d+)/u.exec(facts.core);
      return seed
        ? t('message.content.missing-definition.cause.seed', { seed: seed[1] })
        : t('message.content.missing-definition.cause');
    },
    action: step('message.action.select-local-game-version'),
  },
  'generation.source-changed': {
    severity: 'info',
    headline: 'message.generation.source-changed.headline',
    cause: 'message.generation.source-changed.cause',
  },
};

const transportCatalog: Record<string, CatalogEntry> = {
  'protocol.1': {
    headline: 'message.protocol.1.headline',
    action: step('message.action.reinstall'),
  },
  'protocol.2': {
    headline: 'message.protocol.2.headline',
    cause: engineCause,
  },
  'protocol.4': {
    headline: 'message.protocol.4.headline',
    cause: engineCause,
    action: step('message.action.check-update'),
  },
  'protocol.5': {
    severity: 'info',
    headline: 'message.generation.source-changed.headline',
    cause: 'message.generation.source-changed.cause',
  },
  'protocol.6': {
    headline: 'message.protocol.6.headline',
    cause: engineCause,
    action: reportProblem,
  },
  protocol: {
    headline: 'message.protocol.headline',
    cause: engineCause,
  },
  'jsonrpc.-32002': {
    headline: 'message.jsonrpc.-32002.headline',
    cause: (facts) =>
      facts.location ? locatedCause(facts, engineCause(facts) ?? '') : engineCause(facts),
  },
  'jsonrpc.-32602': {
    headline: 'message.jsonrpc.-32602.headline',
    cause: engineCause,
    action: reportProblem,
  },
  'jsonrpc.-32601': {
    headline: 'message.jsonrpc.-32601.headline',
    action: reportProblem,
  },
  'jsonrpc.-32700': {
    headline: 'message.jsonrpc.-32700.headline',
    action: reportProblem,
  },
  'jsonrpc.-32800': {
    severity: 'info',
    headline: 'message.jsonrpc.-32800.headline',
  },
  jsonrpc: {
    headline: 'message.jsonrpc.headline',
    cause: engineCause,
  },
};

function xsDependency(facts: MessageFacts): string | undefined {
  return /XS dependency (.+?) does not parse/u.exec(facts.core)?.[1];
}

const xsSyntaxHeadline = (facts: MessageFacts): string => {
  const name = xsDependency(facts);
  return name ? t('message.xs-syntax.headline.named', { name }) : t('message.xs-syntax.headline');
};

const controlFailures: Array<[codes: string[], entry: CatalogEntry]> = [
  [
    ['xs-syntax'],
    {
      headline: xsSyntaxHeadline,
      cause: (facts) => {
        const line = /does not parse: line (\d+):/u.exec(facts.core)?.[1];
        const name = xsDependency(facts);
        return name && line
          ? t('message.control.xs-syntax.cause.located', { name, line })
          : t('message.control.xs-syntax.cause');
      },
      action: step('message.control.xs-syntax.action'),
    },
  ],
  [
    ['xs-profile-file-not-owned'],
    {
      headline: (facts) => {
        const name = /XS file (.+?) already exists in your profile's XS folder/u.exec(facts.core);
        return name
          ? t('message.control.xs-profile-file-not-owned.headline.named', { name: name[1] })
          : t('message.control.xs-profile-file-not-owned.headline');
      },
      cause: (facts) => {
        const folder = profileXsFolder(facts);
        return folder
          ? t('message.control.xs-profile-file-not-owned.cause.folder', { folder })
          : t('message.control.xs-profile-file-not-owned.cause');
      },
      action: step('message.control.xs-profile-file-not-owned.action'),
    },
  ],
  [
    ['xs-profile-file-changed'],
    {
      headline: (facts) => {
        const name = /XS file (.+?) in your profile's XS folder/u.exec(facts.core);
        return name
          ? t('message.control.xs-profile-file-changed.headline.named', { name: name[1] })
          : t('message.control.xs-profile-file-changed.headline');
      },
      cause: (facts) => {
        const folder = profileXsFolder(facts);
        return t('message.control.xs-profile-file-changed.cause', {
          folder: folder ?? t('message.format.profile-xs-folder'),
        });
      },
      action: step('message.control.xs-profile-file-changed.action'),
    },
  ],
  [
    ['xs-profile-name-invalid'],
    {
      headline: (facts) => {
        const name = /XS file name (.+?) can't be copied/u.exec(facts.core);
        return name
          ? t('message.control.xs-profile-name-invalid.headline.named', { name: name[1] })
          : t('message.control.xs-profile-name-invalid.headline');
      },
      cause: 'message.control.xs-profile-name-invalid.cause',
      action: step('message.control.xs-profile-name-invalid.action'),
    },
  ],
  [
    ['xs-profile-name-collision'],
    {
      headline: (facts) => {
        const name = /would both be copied as (.+?) to your profile's XS folder/u.exec(facts.core);
        return name
          ? t('message.control.xs-profile-name-collision.headline.named', { name: name[1] })
          : t('message.control.xs-profile-name-collision.headline');
      },
      cause: 'message.control.xs-profile-name-collision.cause',
      action: step('message.control.xs-profile-name-collision.action'),
    },
  ],
  [
    ['xs-profile-folder-unsafe'],
    {
      headline: 'message.control.xs-profile-folder-unsafe.headline',
      cause: (facts) => {
        const folder = profileXsFolder(facts);
        return t('message.control.xs-profile-folder-unsafe.cause', {
          folder: folder ?? t('message.format.the-folder'),
        });
      },
    },
  ],
  [
    ['xs-profile-record-invalid'],
    {
      headline: 'message.control.xs-profile-record-invalid.headline',
      cause: 'message.control.xs-profile-record-invalid.cause',
      action: reportProblem,
    },
  ],
  [
    ['xs-profile-staging-failed'],
    {
      headline: 'message.control.xs-profile-staging-failed.headline',
      cause: (facts) => {
        if (/more XS files than a live test copies/u.test(facts.core)) {
          return t('message.control.xs-profile-staging-failed.cause.too-many');
        }
        const folder = profileXsFolder(facts) ?? t('message.format.profile-xs-folder');
        if (/could not be restored/u.test(facts.core)) {
          return t('message.control.xs-profile-staging-failed.cause.not-restored', { folder });
        }
        if (/was restored/u.test(facts.core)) {
          return t('message.control.xs-profile-staging-failed.cause.restored', { folder });
        }
        if (/changed during the live test/u.test(facts.core)) {
          return t('message.control.xs-profile-staging-failed.cause.record-changed', { folder });
        }
        return engineCause(facts);
      },
      action: (facts) =>
        /more XS files than a live test copies/u.test(facts.core)
          ? null
          : step('message.control.xs-profile-staging-failed.action'),
    },
  ],
  [
    ['game-detection-timeout', 'game-not-detected', 'no-game'],
    {
      headline: 'message.control.game-detection-timeout.headline',
      action: step('message.control.game-detection-timeout.action'),
    },
  ],
  [
    ['launcher-exited-before-start'],
    {
      headline: 'message.control.launcher-exited-before-start.headline',
      action: step('message.action.check-control-file'),
    },
  ],
  [
    ['launcher-start-timeout'],
    {
      headline: 'message.control.launcher-start-timeout.headline',
      action: step('message.action.check-control-file'),
    },
  ],
  [
    ['handshake-timeout', 'injection-handshake-timeout'],
    {
      headline: 'message.control.handshake-timeout.headline',
      action: step('message.action.reconnect-control'),
    },
  ],
  [
    ['control-civilization-unsupported'],
    {
      headline: 'message.control.control-civilization-unsupported.headline',
      cause: 'message.control.control-civilization-unsupported.cause',
      action: getNewerControl,
    },
  ],
  [
    ['endpoint-civilization_unavailable_in_control_catalog'],
    {
      headline: 'message.control.endpoint-civilization_unavailable_in_control_catalog.headline',
      cause: 'message.control.endpoint-civilization_unavailable_in_control_catalog.cause',
      action: getNewerControl,
    },
  ],
  [
    ['game-civilization-unavailable'],
    {
      headline: 'message.control.game-civilization-unavailable.headline',
      action: step('message.control.game-civilization-unavailable.action'),
    },
  ],
  [
    ['unsupported-game-version'],
    {
      headline: 'message.control.unsupported-game-version.headline',
      action: step('message.action.check-update'),
    },
  ],
  [
    ['launcher-still-unloading'],
    {
      headline: 'message.control.launcher-still-unloading.headline',
      action: step('message.action.wait-run-again'),
    },
  ],
  [
    ['launcher-engine-starting-timeout'],
    {
      headline: 'message.control.launcher-engine-starting-timeout.headline',
      action: step('message.action.wait-run-again'),
    },
  ],
  [
    ['launcher-startup-timeout'],
    {
      headline: 'message.control.launcher-startup-timeout.headline',
      action: step('message.action.run-again-or-restart-game'),
    },
  ],
  [
    ['launcher-game-not-ready'],
    {
      headline: 'message.control.launcher-game-not-ready.headline',
      action: step('message.control.launcher-game-not-ready.action'),
    },
  ],
  [
    ['launcher-engine-incompatible'],
    {
      headline: 'message.control.launcher-engine-incompatible.headline',
      action: step('message.action.restart-game-run-again'),
    },
  ],
  [
    ['launcher-engine-failed-earlier'],
    {
      headline: 'message.control.launcher-engine-failed-earlier.headline',
      action: step('message.action.restart-game-run-again'),
    },
  ],
  [
    ['launcher-injection-failed'],
    {
      headline: 'message.control.launcher-injection-failed.headline',
      action: step('message.action.restart-game-run-again'),
    },
  ],
  [
    ['launcher-launcher-already-running'],
    {
      headline: 'message.control.launcher-launcher-already-running.headline',
      action: step('message.control.launcher-launcher-already-running.action'),
    },
  ],
  [
    [
      'incompatible-engine',
      'capability-mismatch',
      'launcher-engine-mismatch',
      'stale-reused-engine',
      'incompatible-control-capabilities',
    ],
    {
      headline: 'message.control.incompatible-engine.headline',
      action: linkStep('message.control.incompatible-engine.action', 'control-releases'),
    },
  ],
  [
    ['effective-readback-mismatch', 'start-transaction-mismatch', 'invalid-setup'],
    {
      headline: 'message.control.effective-readback-mismatch.headline',
      action: step('message.action.press-run-again'),
    },
  ],
  [
    ['connection-lost', 'endpoint-unavailable', 'endpoint-engine_stopping'],
    {
      headline: 'message.control.connection-lost.headline',
      action: step('message.control.connection-lost.action'),
    },
  ],
  [
    ['endpoint-timeout', 'endpoint-render_timeout'],
    {
      headline: 'message.control.endpoint-timeout.headline',
      action: step('message.action.reconnect-control'),
    },
  ],
  [
    ['endpoint-closed'],
    {
      headline: 'message.control.endpoint-closed.headline',
      cause: 'message.control.endpoint-closed.cause',
      action: step('message.action.check-game-window'),
    },
  ],
  [
    ['match-start-unresponsive'],
    {
      headline: 'message.control.match-start-unresponsive.headline',
      cause: 'message.control.match-start-unresponsive.cause',
      action: step('message.control.match-start-unresponsive.action'),
    },
  ],
  [
    ['active-verification-timeout'],
    {
      headline: 'message.control.active-verification-timeout.headline',
      action: step('message.action.check-game-window'),
    },
  ],
  [
    ['clean-end-timeout'],
    {
      headline: 'message.control.clean-end-timeout.headline',
      action: step('message.action.check-game-window'),
    },
  ],
  [
    ['endpoint-local_mod_source_changed'],
    {
      headline: 'message.control.endpoint-local_mod_source_changed.headline',
      action: step('message.action.press-run-again'),
    },
  ],
  [
    ['endpoint-local_mod_stage_conflict'],
    {
      headline: 'message.control.endpoint-local_mod_stage_conflict.headline',
      action: step('message.control.endpoint-local_mod_stage_conflict.action'),
    },
  ],
  [
    ['endpoint-local_mod_stage_failed'],
    {
      headline: 'message.control.endpoint-local_mod_stage_failed.headline',
      action: step('message.action.run-again-or-restart-game'),
    },
  ],
  [
    ['start-response-timeout'],
    {
      severity: 'warning',
      headline: 'message.control.start-response-timeout.headline',
      action: step('message.control.start-response-timeout.action'),
    },
  ],
  [
    ['clean-end-response-timeout'],
    {
      severity: 'warning',
      headline: 'message.control.clean-end-response-timeout.headline',
      action: step('message.control.clean-end-response-timeout.action'),
    },
  ],
  [
    ['deployment-target-unavailable'],
    {
      headline: 'message.control.deployment-target-unavailable.headline',
      cause: 'message.format.preview-kept',
      action: step('message.control.deployment-target-unavailable.action'),
    },
  ],
  [
    ['deployment-identity-invalid', 'deployment-preview-mismatch', 'managed-deployment-failed'],
    {
      headline: 'message.control.deployment-identity-invalid.headline',
      cause: 'message.format.preview-kept',
    },
  ],
  [
    ['malformed-launcher-status', 'launcher-crashed', 'launcher-engine-failure'],
    {
      headline: 'message.control.malformed-launcher-status.headline',
      action: step('message.action.reconnect-control'),
    },
  ],
  [
    [
      'unsafe-or-unknown-session',
      'stale-safety-observation',
      'endpoint-rms_session_safety_changing',
      'endpoint-rms_session_safety_unknown',
      'endpoint-session_boundary_changed',
    ],
    {
      headline: 'message.control.unsafe-or-unknown-session.headline',
      action: step('message.action.wait-try-again'),
    },
  ],
  [
    [
      'validation-failed',
      'malformed-endpoint-response',
      'endpoint-response-too-large',
      'endpoint-rejected',
      'invalid-session-identity',
      'invalid-catalog-generation',
    ],
    {
      headline: 'message.control.validation-failed.headline',
      action: step('message.action.reconnect-control'),
    },
  ],
  [
    ['unsupported-session-state'],
    {
      headline: 'message.control.unsupported-session-state.headline',
      action: step('message.control.unsupported-session-state.action'),
    },
  ],
  [
    ['explicit-clean-end-required'],
    {
      headline: 'message.control.explicit-clean-end-required.headline',
      action: step('message.control.explicit-clean-end-required.action'),
    },
  ],
  [
    ['session-not-connected'],
    {
      headline: 'message.control.session-not-connected.headline',
      action: step('message.control.session-not-connected.action'),
    },
  ],
  [
    ['launcher-artifact-transition'],
    {
      headline: 'message.control.launcher-artifact-transition.headline',
      action: step('message.control.launcher-artifact-transition.action'),
    },
  ],
  [
    ['operation-queue-full', 'endpoint-queue_full'],
    {
      headline: 'message.control.operation-queue-full.headline',
      action: step('message.action.wait-try-again'),
    },
  ],
  [
    ['stale-or-nonexact-preview'],
    {
      severity: 'warning',
      headline: 'message.live.stopped.headline',
      cause: 'message.live.stopped.stale-preview.cause',
    },
  ],
  [
    ['active-match-confirmation-required'],
    {
      severity: 'warning',
      headline: 'message.control.active-match-confirmation-required.headline',
      cause: 'message.control.active-match-confirmation-required.cause',
      action: step('message.action.press-run-again'),
    },
  ],
  [
    ['clean-end-rejected'],
    {
      headline: 'message.control.clean-end-rejected.headline',
      action: step('message.action.check-game-window'),
    },
  ],
  [
    ['session-changed-before-mutation'],
    {
      headline: 'message.control.session-changed-before-mutation.headline',
      cause: 'message.control.session-changed-before-mutation.cause',
      action: step('message.action.check-game-window'),
    },
  ],
  [
    ['session-identity-changed'],
    {
      headline: 'message.control.session-identity-changed.headline',
      action: step('message.action.reconnect-control'),
    },
  ],
  [
    ['managed-source-unavailable', 'ambiguous-managed-source'],
    {
      headline: 'message.control.managed-source-unavailable.headline',
      cause: 'message.control.managed-source-unavailable.cause',
      action: step('message.action.run-again-or-restart-game'),
    },
  ],
  [
    ['invalid-setup-player'],
    {
      headline: 'message.control.invalid-setup-player.headline',
      cause: 'message.control.invalid-setup-player.cause',
      action: step('message.action.open-players-menu'),
    },
  ],
  [
    [
      'unsupported-live-contract',
      'invalid-live-request',
      'invalid-preview-identity',
      'invalid-preview-options',
      'invalid-ending-age',
    ],
    {
      headline: 'message.control.invalid-live-request.headline',
      action: reportProblem,
    },
  ],
  [['unsupported-platform'], { headline: 'message.control.unsupported-platform.headline' }],
  [
    ['cancelled'],
    {
      severity: 'info',
      headline: 'message.live.cancelled.headline',
      cause: 'message.live.cancelled.cause',
    },
  ],
  [
    [
      'endpoint-rollback_snapshot_unavailable',
      'rollback_snapshot_unavailable',
      'endpoint-pregame_initialization_failed',
    ],
    {
      headline: 'message.control.endpoint-rollback_snapshot_unavailable.headline',
      action: step('message.control.endpoint-rollback_snapshot_unavailable.action'),
    },
  ],
];

const liveCatalog: Record<string, CatalogEntry> = {
  control: {
    headline: 'message.control.headline',
    cause: engineCause,
    action: step('message.action.reconnect-control'),
  },
  'live.engine-startup': { severity: 'info', headline: 'message.live.engine-startup.headline' },
  'live.engine-unloading': {
    severity: 'info',
    headline: 'message.live.engine-unloading.headline',
  },
  'live.engine-starting': {
    severity: 'info',
    headline: 'message.live.engine-starting.headline',
  },
  'live.game-detected': { severity: 'info', headline: 'message.live.game-detected.headline' },
  'live.attach': { severity: 'info', headline: 'message.live.attach.headline' },
  'live.handshake': { severity: 'info', headline: 'message.live.handshake.headline' },
  'live.ready': { severity: 'info', headline: 'message.live.ready.headline' },
  'live.clean-end': { severity: 'info', headline: 'message.live.clean-end.headline' },
  'live.deploy': {
    severity: 'info',
    headline: 'message.live.deploy.headline',
    cause: (facts) => {
      const names = param(facts, 'xsFiles').split('/').filter(Boolean);
      if (names.length === 0) return null;
      return t('message.live.deploy.cause', {
        files: activeTranslator().formatList(names),
        count: names.length,
      });
    },
  },
  'live.deploy-current': { severity: 'info', headline: 'message.live.deploy-current.headline' },
  'live.catalog-refresh': { severity: 'info', headline: 'message.live.catalog-refresh.headline' },
  'live.match-start': {
    severity: 'info',
    headline: (facts) => t('message.live.match-start.headline', { seed: param(facts, 'seed') }),
  },
  'live.verified': {
    severity: 'info',
    headline: (facts) => t('message.live.verified.headline', { seed: param(facts, 'seed') }),
    cause: (facts) =>
      facts.params.unverifiedVersion
        ? t('message.live.verified.cause', { version: param(facts, 'unverifiedVersion') })
        : null,
  },
  'live.unverified-game': {
    severity: 'warning',
    headline: (facts) =>
      t('message.live.unverified-game.headline', { version: param(facts, 'version') }),
    cause: 'message.live.unverified-game.cause',
  },
  'live.cancelled': {
    severity: 'info',
    headline: 'message.live.cancelled.headline',
    cause: 'message.live.cancelled.cause',
  },
  'live.detached': { severity: 'info', headline: 'message.live.detached.headline' },
  'live.stopped.generation-failed': {
    severity: 'warning',
    headline: 'message.live.stopped.headline',
    cause: 'message.live.stopped.generation-failed.cause',
  },
  'live.stopped.invalid-source': {
    severity: 'warning',
    headline: 'message.live.stopped.headline',
    cause: 'message.live.stopped.invalid-source.cause',
  },
  'live.stopped.source-changed': {
    severity: 'warning',
    headline: 'message.live.stopped.headline',
    cause: 'message.live.stopped.source-changed.cause',
  },
  'live.stopped.stale-preview': {
    severity: 'warning',
    headline: 'message.live.stopped.headline',
    cause: 'message.live.stopped.stale-preview.cause',
  },
  'live.match-kept': {
    severity: 'info',
    headline: 'message.live.cancelled.headline',
    cause: 'message.live.match-kept.cause',
  },
  'live.permission-not-saved': {
    headline: 'message.live.cancelled.headline',
    cause: 'message.live.permission-not-saved.cause',
  },
  'live.control-selected': { severity: 'info', headline: 'message.live.control-selected.headline' },
  'live.control-rejected': {
    severity: 'warning',
    headline: 'message.live.control-rejected.headline',
    cause: 'message.format.preview-works-without-it',
    action: linkStep('message.live.control-rejected.action', 'control-releases'),
  },
  'live.control-forgotten': {
    severity: 'info',
    headline: 'message.live.control-forgotten.headline',
  },
  'live.control-forget-failed': {
    headline: 'message.live.control-forget-failed.headline',
    action: step('message.live.control-forget-failed.action'),
  },
  'live.status-unavailable': {
    severity: 'warning',
    headline: 'message.live.status-unavailable.headline',
    cause: 'message.format.preview-works-without-it',
  },
  'live.seed-unavailable': {
    severity: 'warning',
    headline: 'message.live.seed-unavailable.headline',
    cause: (facts) => param(facts, 'reason') || null,
  },
  'live.seed-imported': {
    severity: 'info',
    headline: (facts) => t('message.live.seed-imported.headline', { seed: param(facts, 'seed') }),
  },
};

const deployCatalog: Record<string, CatalogEntry> = {
  'deploy.target-changed': {
    headline: 'message.deploy.target-changed.headline',
    action: step('message.action.open-deploy-again'),
  },
  'deploy.external-edits': {
    headline: 'message.deploy.external-edits.headline',
    cause: 'message.deploy.external-edits.cause',
    action: step('message.deploy.external-edits.action'),
  },
  'deploy.stale-preview': {
    headline: 'message.deploy.stale-preview.headline',
    action: step('message.action.open-deploy-again'),
  },
  'deploy.not-managed': {
    headline: 'message.deploy.not-managed.headline',
    cause: 'message.deploy.not-managed.cause',
    action: step('message.action.choose-another-mod-name'),
  },
  'deploy.profile': {
    headline: 'message.deploy.profile.headline',
    action: step('message.deploy.profile.action'),
  },
  'deploy.built-in': {
    headline: 'message.deploy.built-in.headline',
    action: step('message.deploy.built-in.action'),
  },
  'deploy.too-large': {
    headline: 'message.deploy.too-large.headline',
  },
  'deploy.redirected': {
    headline: 'message.deploy.redirected.headline',
    cause: 'message.deploy.redirected.cause',
  },
  'deploy.unconfirmed': {
    headline: 'message.deploy.unconfirmed.headline',
    action: step('message.deploy.unconfirmed.action'),
  },
  'deploy.no-map': {
    headline: 'message.deploy.no-map.headline',
    cause: 'message.deploy.no-map.cause',
  },
  'deploy.reserved-name': {
    headline: 'message.deploy.reserved-name.headline',
    action: step('message.action.choose-another-mod-name'),
  },
  'deploy.invalid-name': {
    headline: 'message.deploy.invalid-name.headline',
    cause: 'message.deploy.invalid-name.cause',
    action: step('message.action.choose-another-mod-name'),
  },
  'deploy.xs-syntax': {
    headline: xsSyntaxHeadline,
    cause: (facts) => {
      const located =
        /XS dependency (.+?) does not parse: line (\d+): (.+?)(?: \((XS\d{4})\))?$/u.exec(
          facts.core,
        );
      return located
        ? t('message.deploy.xs-syntax.cause.located', {
            name: located[1],
            line: located[2],
            error: sentence(located[3]!, englishTranslator),
          })
        : t('message.deploy.xs-syntax.cause');
    },
    action: step('message.deploy.xs-syntax.action'),
  },
  'deploy.map-icon': {
    headline: 'message.deploy.map-icon.headline',
    cause: engineCause,
    action: step('message.deploy.map-icon.action'),
  },
  'deploy.map-icon-busy': {
    severity: 'warning',
    cause: 'message.deploy.map-icon-busy.cause',
    action: step('message.deploy.map-icon-busy.action'),
  },
  'deploy.map-icon-preview-changed': {
    severity: 'warning',
    cause: 'message.deploy.map-icon-preview-changed.cause',
    action: step('message.deploy.map-icon-preview-changed.action'),
  },
  'deploy.map-icon-textures-changed': {
    cause: 'message.deploy.map-icon-textures-changed.cause',
    action: step('message.deploy.map-icon.action'),
  },
  'deploy.no-installation': {
    cause: 'message.deploy.no-installation.cause',
    action: step('message.action.link-game-folder'),
  },
  'deploy.unsafe-target': { cause: 'message.deploy.unsafe-target.cause' },
  'deploy.path-collision': {
    cause: (facts) => t('message.deploy.path-collision.cause', { path: param(facts, 'path') }),
  },
  'deploy.unplaceable-source': {
    cause: 'message.deploy.unplaceable-source.cause',
    action: reportProblem,
  },
  'deploy.state-invalid': {
    cause: 'message.deploy.state-invalid.cause',
    action: reportProblem,
  },
  deploy: {
    headline: 'message.deploy.headline',
    cause: engineCause,
  },
};

export function mapTestErrorLocation(
  traceback: string,
): { file: string; line: number; column: number | null; error: string } | null {
  const text = traceback.replace(/\s+/gu, ' ');
  const located = / error: (.+?) --> (.+?):(\d+):(\d+)(?: |$)/u.exec(` ${text}`);
  if (!located) return null;
  let file = located[2]!;
  let line = Number(located[3]);
  let column: number | null = Number(located[4]);
  if (file.startsWith('<')) {
    const caller = [...text.matchAll(/\* ((?:(?! \* ).)+?):(\d+), in /gu)]
      .filter((frame) => !frame[1]!.startsWith('<'))
      .at(-1);
    if (!caller) return null;
    file = caller[1]!;
    line = Number(caller[2]);
    column = null;
  }
  const error = located[1]!
    .replace(/\s*\((?:RMS(?:GEN|XS)?\d{4})\)/gu, '')
    .replace(/^invalid generation request RMS\w+:\s*/u, '')
    .replace(/^fail:\s*/u, '')
    .replace(/^strict source execution failed:\s*/u, 'the tested map has an error: ')
    .replace(/\s*\(at source bytes? [\d.]+\)/gu, '')
    .trim();
  return { file, line, column, error };
}

const mapTestScriptError: CatalogEntry = {
  source: 'Map test',
  headline: 'message.map-test.execution.headline',
  cause: (facts) => {
    const location = mapTestErrorLocation(facts.core);
    if (!location) return engineCause(facts);
    return sentence(
      t('message.map-test.execution.cause', {
        file: location.file,
        line: location.line,
        error: location.error,
      }),
    );
  },
};

const rerunMapTest = step('message.action.rerun-map-test');
const replayHeadline: MessageId = 'message.map-test.replay.headline';

const mapTestCatalog: Record<string, CatalogEntry> = {
  'map-test.execution': mapTestScriptError,
  RMSTEST1001: {
    source: 'Map test',
    headline: 'message.RMSTEST1001.headline',
    cause: engineCause,
    action: reportProblem,
  },
  RMSTEST2001: {
    source: 'Map test',
    headline: 'message.RMSTEST2001.headline',
    cause: mapTestScriptError.cause!,
  },
  RMSTEST2002: mapTestScriptError,
  RMSTEST2003: {
    source: 'Map test',
    severity: 'info',
    headline: 'message.RMSTEST2003.headline',
  },
  RMSTEST2004: {
    source: 'Map test',
    headline: 'message.RMSTEST2004.headline',
    cause: 'message.RMSTEST2004.cause',
    action: step('message.RMSTEST2004.action'),
  },
  RMSTEST2005: {
    source: 'Map test',
    headline: 'message.RMSTEST2005.headline',
    cause: 'message.RMSTEST2005.cause',
    action: step('message.RMSTEST2005.action'),
  },
  RMSTEST2006: {
    source: 'Map test',
    headline: 'message.RMSTEST2006.headline',
    cause: engineCause,
  },
  RMSTEST3001: {
    source: 'Map test',
    headline: 'message.RMSTEST3001.headline',
    cause: engineCause,
    action: reportProblem,
  },
  RMSTEST3002: {
    source: 'Map test',
    headline: 'message.RMSTEST3002.headline',
    cause: 'message.RMSTEST3002.cause',
    action: step('message.RMSTEST3002.action'),
  },
  RMSTEST: mapTestScriptError,
  'map-test.child-memory': {
    cause: 'message.map-test.child-memory.cause',
    action: step('message.map-test.child-memory.action'),
  },
  'map-test.child-stack': { cause: 'message.map-test.child-stack.cause' },
  'map-test.child-aborted': { cause: 'message.map-test.child-aborted.cause' },
  'map-test.source-path': { cause: 'message.map-test.source-path.cause' },
  'map-test.default-source-outside': { cause: 'message.map-test.default-source-outside.cause' },
  'map-test.untitled-needs-folder': { cause: 'message.map-test.untitled-needs-folder.cause' },
  'map-test.report-invalid': { cause: 'message.map-test.report-invalid.cause' },
  'map-test.report-too-large': {
    cause: (facts) =>
      t('message.map-test.report-too-large.cause', { limit: numberParam(facts, 'limit') }),
  },
  'map-test.replay-script-changed': {
    source: 'Map test',
    headline: replayHeadline,
    cause: 'message.map-test.replay-script-changed.cause',
    action: rerunMapTest,
  },
  'map-test.replay-source-changed': {
    source: 'Map test',
    headline: replayHeadline,
    cause: 'message.map-test.replay-source-changed.cause',
    action: rerunMapTest,
  },
  'map-test.replay-game-version': {
    source: 'Map test',
    headline: replayHeadline,
    cause: 'message.map-test.replay-game-version.cause',
    action: rerunMapTest,
  },
  'map-test.replay-different-map': {
    source: 'Map test',
    headline: replayHeadline,
    cause: 'message.map-test.replay-different-map.cause',
    action: reportProblem,
  },
  'map-test.replay-missing': {
    source: 'Map test',
    headline: replayHeadline,
    cause: 'message.map-test.replay-missing.cause',
  },
  'map-test.replay-needs-script': {
    source: 'Map test',
    severity: 'warning',
    headline: (facts) =>
      t('message.map-test.replay-needs-script.headline', {
        script: param(facts, 'script') || t('message.format.the-map-test'),
      }),
    cause: 'message.map-test.replay-needs-script.cause',
  },
  'map-test.check-needs-script': {
    source: 'Map test',
    severity: 'warning',
    headline: (facts) =>
      t('message.map-test.check-needs-script.headline', {
        script: param(facts, 'script') || t('message.format.the-map-test'),
      }),
    cause: 'message.map-test.check-needs-script.cause',
  },
  'map-test.results-running': {
    source: 'Map test',
    severity: 'info',
    headline: (facts) => {
      const counts = mapTestProgressCounts(
        Number(param(facts, 'completed')),
        Number(param(facts, 'requested')),
      );
      return counts
        ? t('message.map-test.results-running.headline.counts', { counts })
        : t('message.map-test.results-running.headline');
    },
    cause: 'message.map-test.results-running.cause',
  },
  'map-test.results-after-error': {
    source: 'Map test',
    severity: 'warning',
    headline: 'message.map-test.results-after-error.headline',
    cause: 'message.map-test.results-before.cause',
    action: step('message.map-test.results-after-error.action'),
  },
  'map-test.results-after-stop': {
    source: 'Map test',
    severity: 'info',
    headline: 'message.map-test.results-after-stop.headline',
    cause: 'message.map-test.results-before.cause',
  },
  'map-test.results-imported': {
    source: 'Map test',
    severity: 'info',
    headline: (facts) =>
      t('message.map-test.results-imported.headline', {
        script: param(facts, 'script') || t('message.format.a-map-test'),
      }),
    cause: 'message.map-test.results-imported.cause',
  },
};

const replayFailurePatterns: Array<[RegExp, string]> = [
  [/map-test script identity differs/u, 'map-test.replay-script-changed'],
  [
    /source graph identity differs|source catalog changed|the source changed while|\(generation\.source-changed\b/u,
    'map-test.replay-source-changed',
  ],
  [
    /profile or content identity is no longer available|engine identity is unsupported/u,
    'map-test.replay-game-version',
  ],
  [/does not match its recorded identity/u, 'map-test.replay-different-map'],
  [/selected map-test finding is unavailable/u, 'map-test.replay-missing'],
];

export const mapTestPreviewNotes = Object.freeze({
  get look() {
    return t('message.map-test.preview-note.look');
  },
  get stages() {
    return t('message.map-test.preview-note.stages');
  },
});

export const generationResultWords = Object.freeze({
  get generated() {
    return t('message.generation-result.generated');
  },
  get reused() {
    return t('message.generation-result.reused');
  },
  get unverifiedVersion() {
    return t('message.generation-result.unverified-version');
  },
  get deploymentUnverifiedVersion() {
    return t('message.generation-result.deployment-unverified-version');
  },
  get generationUnavailable() {
    return t('message.generation-result.generation-unavailable');
  },
});

export function presentMapTestReplayFailure(raw: string): OutputMessage {
  const text = stripTransport(raw);
  const code =
    replayFailurePatterns.find(([pattern]) => pattern.test(text))?.[1] ?? messageCode(raw);
  return presentMessage({
    source: 'Map test',
    raw,
    ...(code ? { code } : {}),
    fallbackHeadline: replayHeadline,
  });
}

export function mapTestProgressCounts(completed: number, requested: number): string | null {
  if (!Number.isInteger(requested) || requested <= 0) return null;
  const done = Number.isInteger(completed) ? Math.min(Math.max(completed, 0), requested) : 0;
  return t('message.map-test.progress.counts', { done, requested });
}

export function presentMapTestProgress(progress: {
  phase: 'idle' | 'running' | 'completed';
  completed: number;
  requested: number;
  percent: number;
}): { word: string; detail: string } {
  if (progress.phase === 'completed') {
    return {
      word: t('message.map-test.progress.tested'),
      detail: t('message.map-test.progress.tested-detail', { count: progress.completed }),
    };
  }
  const counts = mapTestProgressCounts(progress.completed, progress.requested);
  return {
    word: t('message.map-test.progress.testing'),
    detail: counts
      ? t('message.map-test.progress.testing-detail', { percent: progress.percent, counts })
      : t('message.map-test.progress.starting'),
  };
}

export function mapTestWorkerFieldWords(maximum: number): {
  label: string;
  hint: string;
  automatic: string;
  useAutomatic: string;
} {
  return {
    label: t('message.map-test.workers.label'),
    hint: t('message.map-test.workers.hint', { maximum }),
    automatic: t('message.map-test.workers.automatic'),
    useAutomatic: t('message.map-test.workers.use-automatic'),
  };
}

export type MapTestMeasurement = boolean | number | string | null;

export function mapTestValuesText(
  measurements: Readonly<Record<string, MapTestMeasurement>>,
): string | null {
  const parts = Object.entries(measurements).map(([name, value]) => {
    const shown =
      value === null
        ? 'None'
        : typeof value === 'boolean'
          ? value
            ? 'True'
            : 'False'
          : String(value);
    return `${name}: ${shown.length > 80 ? `${shown.slice(0, 79).trimEnd()}…` : shown}`;
  });
  if (parts.length === 0) return null;
  const text = parts.join(' · ');
  return text.length > 400 ? `${text.slice(0, 399).trimEnd()}…` : text;
}

export interface MapTestFindingInput {
  message: string;
  code: string | null;
  measurements: Readonly<Record<string, MapTestMeasurement>>;
  seed: number;
  sourcePath: string;
  scriptName: string;
  scriptLine: number;
  scriptColumn: number;
  mapHash: string;
  requestHash: string;
  messageShown: boolean;
}

export function presentMapTestFinding(input: MapTestFindingInput): OutputMessage {
  return withTranslator(englishTranslator, () => wordMapTestFinding(input));
}

function wordMapTestFinding(input: MapTestFindingInput): OutputMessage {
  const values = mapTestValuesText(input.measurements);
  const message =
    input.message.replace(/\s+/gu, ' ').trim() || t('message.map-test.finding.headline');
  const headline = input.messageShown && values ? values : message;
  const detail = [
    `${input.scriptName}, line ${input.scriptLine}, column ${input.scriptColumn}`,
    `${input.sourcePath}, seed ${input.seed}`,
    headline === message ? null : `Message: ${message}`,
    Object.keys(input.measurements).length > 0
      ? `Values: ${JSON.stringify(input.measurements)}`
      : null,
    `Map hash: ${input.mapHash}`,
    `Request hash: ${input.requestHash}`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  return {
    code: input.code ?? 'map-test.finding',
    severity: 'error',
    source: 'Map test',
    headline,
    ...(headline === message && values ? { cause: values } : {}),
    detail,
  };
}

const gameFolderCatalog: Record<string, CatalogEntry> = {
  'game-folder.not-steam': {
    source: 'Game folder',
    severity: 'warning',
    headline: 'message.game-folder.not-steam.headline',
    cause: 'message.game-folder.not-steam.cause',
    action: step('message.game-folder.not-steam.action'),
  },
  'game-folder.unavailable': {
    source: 'Game folder',
    cause: 'message.game-folder.unavailable.cause',
    action: step('message.action.link-game-folder'),
  },
  'game-folder.unsafe': {
    cause: 'message.game-folder.unsafe.cause',
    action: step('message.action.verify-game-files'),
  },
};

const discoveryBudgets: Readonly<Record<string, MessageId>> = {
  'source-catalog.paths': 'file-actions.included-files.budget.paths',
  'source-catalog.metadata': 'file-actions.included-files.budget.metadata',
  'source-catalog.directory-visits': 'file-actions.included-files.budget.directory-visits',
  'source-catalog.depth': 'file-actions.included-files.budget.depth',
};

function numberParam(facts: MessageFacts, name: string): number {
  const value = Number(facts.params[name]);
  return Number.isFinite(value) ? value : 0;
}

const discoveryLimit: CatalogEntry = {
  cause: (facts) =>
    t('file-actions.included-files.discovery-limit', {
      budget: t(discoveryBudgets[facts.code ?? ''] ?? 'file-actions.included-files.budget.paths'),
      scope: param(facts, 'scope'),
      used: numberParam(facts, 'used'),
      maximum: numberParam(facts, 'maximum'),
    }),
  action: step('message.source-catalog.discovery-reduce.action'),
};

const mebibytes = (facts: MessageFacts): number => numberParam(facts, 'maximum') / (1024 * 1024);
const requiredLimitAction = step('message.source-catalog.required-reduce.action');

const batchLimit =
  (id: MessageId, unit: 'count' | 'mebibytes'): CatalogEntry['cause'] =>
  (facts) =>
    t(id, { limit: unit === 'count' ? numberParam(facts, 'maximum') : mebibytes(facts) });

const sourceCatalogCatalog: Record<string, CatalogEntry> = {
  'source-catalog.stale': { cause: 'file-actions.included-files.changed' },
  'source-catalog.changed': { cause: 'message.source-catalog.changed.cause' },
  'source-catalog.preview-stale': { cause: 'message.live.stopped.stale-preview.cause' },
  'source-catalog.unsupported-include': {
    cause: (facts) =>
      t('message.source-catalog.unsupported-include.cause', { path: param(facts, 'path') }),
  },
  'source-catalog.case-variants': {
    cause: (facts) =>
      t('message.source-catalog.case-variants.cause', { path: param(facts, 'path') }),
  },
  'source-catalog.batch.roots': {
    cause: batchLimit('file-actions.map-test-sources.limit.maps', 'count'),
  },
  'source-catalog.batch.records': {
    cause: batchLimit('file-actions.map-test-sources.limit.records', 'count'),
  },
  'source-catalog.batch.bytes': {
    cause: batchLimit('file-actions.map-test-sources.limit.bytes', 'mebibytes'),
  },
  'source-catalog.batch.metadata': {
    cause: batchLimit('file-actions.map-test-sources.limit.metadata', 'mebibytes'),
  },
  'source-catalog.paths': discoveryLimit,
  'source-catalog.metadata': discoveryLimit,
  'source-catalog.directory-visits': discoveryLimit,
  'source-catalog.depth': discoveryLimit,
  'source-catalog.authority': {
    cause: (facts) => t('message.source-catalog.authority.cause', { scope: param(facts, 'scope') }),
    action: step('message.source-catalog.authority.action'),
  },
  'source-catalog.required.file': {
    cause: (facts) =>
      t('file-actions.included-files.required-limit.file', {
        scope: param(facts, 'scope'),
        limit: mebibytes(facts),
      }),
    action: requiredLimitAction,
  },
  'source-catalog.required.bytes': {
    cause: (facts) =>
      t('file-actions.included-files.required-limit.bytes', { limit: mebibytes(facts) }),
    action: requiredLimitAction,
  },
  'source-catalog.required.records': {
    cause: (facts) =>
      t('file-actions.included-files.required-limit.records', {
        limit: numberParam(facts, 'maximum'),
      }),
    action: requiredLimitAction,
  },
  'source-catalog.required.metadata': {
    cause: (facts) =>
      t('file-actions.included-files.required-limit.metadata', { limit: mebibytes(facts) }),
    action: requiredLimitAction,
  },
};

const waitTryAgain = step('message.action.wait-try-again');

const desktopRefusalCatalog: Record<string, CatalogEntry> = {
  'execution.busy': { cause: 'message.execution.busy.cause', action: waitTryAgain },
  'native.exited': {
    cause: (facts) => t('message.native.exited.cause', { name: param(facts, 'name') }),
    action: reportProblem,
  },
  'native.unavailable': {
    cause: (facts) => t('message.native.unavailable.cause', { name: param(facts, 'name') }),
    action: waitTryAgain,
  },
  'native.timeout': {
    cause: (facts) => t('message.native.timeout.cause', { name: param(facts, 'name') }),
    action: waitTryAgain,
  },
  'generation.content-unavailable': {
    cause: 'run-menu.blocked.content-pack-unavailable',
    action: step('message.generation.content-unavailable.action'),
  },
  'shell.open-failed': {
    cause: (facts) => t('message.shell.open-failed.cause', { reason: param(facts, 'reason') }),
  },
  'editor.busy': { cause: 'message.editor.busy.cause', action: waitTryAgain },
  'files.unsupported': { cause: 'message.files.unsupported.cause' },
  'files.too-many': {
    cause: (facts) => t('message.files.too-many.cause', { limit: numberParam(facts, 'limit') }),
  },
  'files.recent-missing': { cause: 'message.files.recent-missing.cause' },
  'files.encoding': { cause: 'message.files.encoding.cause' },
  'files.too-large': {
    cause: (facts) => t('message.files.too-large.cause', { limit: numberParam(facts, 'limit') }),
  },
  'files.protected': { cause: 'code-editor.read-only-message' },
  'files.protected-target': { cause: 'message.files.protected-target.cause' },
  'files.extension-required': {
    cause: (facts) =>
      t('message.files.extension-required.cause', { extension: param(facts, 'extension') }),
  },
  'files.entry-stale': { cause: 'message.files.entry-stale.cause' },
  'files.not-a-file': { cause: 'message.files.not-a-file.cause' },
  'files.outside-folder': { cause: 'message.files.outside-folder.cause' },
  'files.traversal-limit': {
    cause: 'message.files.traversal-limit.cause',
    action: step('message.files.traversal-limit.action'),
  },
  'files.delete-setting-changed': {
    cause: 'message.files.delete-setting-changed.cause',
    action: step('message.files.delete-setting-changed.action'),
  },
  'files.recovery-too-large': {
    cause: 'message.files.recovery-too-large.cause',
    action: step('message.files.recovery-too-large.action'),
  },
  'files.recovery-invalid': { cause: 'message.files.recovery-invalid.cause' },
  'installed-source.clone-destination': {
    cause: 'message.installed-source.clone-destination.cause',
  },
  'installed-source.clone-exists': {
    cause: (facts) =>
      t('message.installed-source.clone-exists.cause', { name: param(facts, 'name') }),
  },
  'installed-source.limit': { cause: 'message.installed-source.limit.cause' },
  'installed-source.changed': {
    cause: 'message.installed-source.changed.cause',
    action: step('message.installed-source.changed.action'),
  },
};

const sessionCatalog: Record<string, CatalogEntry> = {
  'session.save-failed': {
    source: 'App',
    severity: 'warning',
    headline: 'message.session.save-failed.headline',
    cause: 'message.session.save-failed.cause',
  },
};

function withTextureColorsFallback(facts: MessageFacts): string {
  const reason = engineCause(facts);
  return reason
    ? t('message.game-textures.cause.with-reason', { reason })
    : t('message.game-textures.cause');
}

const gameTexturesCatalog: Record<string, CatalogEntry> = {
  'game-textures.failed': {
    source: 'Game textures',
    severity: 'warning',
    headline: 'message.game-textures.failed.headline',
    cause: withTextureColorsFallback,
  },
  'game-textures.unavailable': {
    source: 'Game textures',
    severity: 'warning',
    headline: 'message.game-textures.unavailable.headline',
    cause: withTextureColorsFallback,
  },
  'game-textures.index-unreadable': {
    source: 'Game textures',
    severity: 'warning',
    headline: 'message.game-textures.index-unreadable.headline',
    cause: 'message.game-textures.cause',
  },
  'game-textures.cancelled': {
    source: 'Game textures',
    severity: 'info',
    headline: 'message.game-textures.cancelled.headline',
    cause: 'message.game-textures.cancelled.cause',
  },
  'game-textures.sprites-failed': {
    source: 'Game textures',
    severity: 'warning',
    headline: 'message.game-textures.sprites-failed.headline',
    cause: engineCause,
  },
  'preview.gpu-map-rendering-unavailable': {
    source: 'Preview',
    severity: 'info',
    headline: 'message.preview.gpu-map-rendering-unavailable.headline',
    cause: 'message.preview.gpu-map-rendering-unavailable.cause',
  },
  'preview.gpu-map-rendering-software': {
    source: 'Preview',
    severity: 'info',
    headline: 'message.preview.gpu-map-rendering-software.headline',
    cause: 'message.preview.gpu-map-rendering-software.cause',
  },
  'preview.gpu-map-rendering-lost': {
    source: 'Preview',
    severity: 'info',
    headline: 'message.preview.gpu-map-rendering-lost.headline',
    cause: 'message.preview.gpu-map-rendering-lost.cause',
  },
  'preview.unchecked-constructs': {
    source: 'Run',
    severity: 'info',
    headline: (facts) => {
      const count = Number(param(facts, 'count'));
      return Number.isSafeInteger(count) && count > 0
        ? t('message.preview.unchecked-constructs.headline.count', { count })
        : t('message.preview.unchecked-constructs.headline');
    },
    cause: (facts) => {
      const one = Number(param(facts, 'count')) === 1;
      const list = param(facts, 'constructs');
      return list
        ? t('message.preview.unchecked-constructs.cause.list', { one: one ? 'one' : 'other', list })
        : t('message.preview.unchecked-constructs.cause', { one: one ? 'one' : 'other' });
    },
  },
};

const rollbackFieldNames: Readonly<Record<string, MessageId>> = {
  gameMode: 'message.lobby-setting.game-mode',
  mapSize: 'message.lobby-setting.map-size',
  startingResources: 'message.lobby-setting.starting-resources',
  startingAge: 'message.lobby-setting.starting-age',
  endingAge: 'message.lobby-setting.ending-age',
  revealMap: 'message.lobby-setting.reveal-map',
  playersCount: 'message.lobby-setting.players-count',
  teamsNotTogether: 'message.lobby-setting.team-positions',
  teamPositions: 'message.lobby-setting.team-positions',
  gameModeModifiers: 'message.lobby-setting.game-mode-modifiers',
  turboMode: 'message.lobby-setting.turbo',
  fullTechTree: 'message.lobby-setting.full-tech-tree',
  antiquityMode: 'message.lobby-setting.antiquity',
  walkableFarms: 'message.lobby-setting.solid-farms',
  source: 'message.lobby-setting.selected-map',
  seed: 'message.lobby-setting.seed',
};

const rollbackPlayerFieldNames: Readonly<Record<string, MessageId>> = {
  team: 'message.lobby-setting.player.team',
  resolvedTeam: 'message.lobby-setting.player.team',
  handicap: 'message.lobby-setting.player.handicap',
  color: 'message.lobby-setting.player.color',
  colorMirror: 'message.lobby-setting.player.color',
  civilization: 'message.lobby-setting.player.civilization',
  randomCivilization: 'message.lobby-setting.player.civilization',
  playerType: 'message.lobby-setting.player.player-type',
};

export function rollbackFieldList(fields: string): string | null {
  const names: string[] = [];
  for (const entry of fields.split(',')) {
    const field = entry.trim().replace(/^(?:set|readback):/u, '');
    const player = /^players\[(\d)\]\.(\w+)$/u.exec(field);
    const playerField = player ? rollbackPlayerFieldNames[player[2]!] : undefined;
    const fieldName = rollbackFieldNames[field];
    const name = player
      ? t('message.lobby-setting.player', {
          slot: Number(player[1]) + 1,
          setting: t(playerField ?? 'message.lobby-setting.player.setting'),
        })
      : fieldName
        ? t(fieldName)
        : null;
    if (name && !names.includes(name)) names.push(name);
  }
  if (names.length === 0) return null;
  return activeTranslator().formatList(names);
}

const lobbyOptionCatalog: Record<string, CatalogEntry> = {
  RMSGEN8001: {
    headline: (facts) =>
      /full tech tree or antiquity/u.test(facts.core)
        ? t('message.RMSGEN8001.headline.tech')
        : /later starting age/u.test(facts.core)
          ? t('message.RMSGEN8001.headline.age')
          : t('message.RMSGEN8001.headline'),
    cause: (facts) =>
      /full tech tree or antiquity/u.test(facts.core)
        ? t('message.RMSGEN8001.cause.tech')
        : /later starting age/u.test(facts.core)
          ? t('message.RMSGEN8001.cause.age')
          : engineCause(facts),
    action: (facts) =>
      /full tech tree or antiquity/u.test(facts.core)
        ? step('message.RMSGEN8001.action.tech')
        : /later starting age/u.test(facts.core)
          ? step('message.RMSGEN8001.action.age')
          : null,
  },
};

const lobbyOptionControlFailures: Array<[codes: string[], entry: CatalogEntry]> = [
  [
    ['control-lobby-options-unsupported'],
    {
      headline: 'message.control.control-lobby-options-unsupported.headline',
      cause: 'message.control.control-lobby-options-unsupported.cause',
      action: getNewerControl,
    },
  ],
  [
    ['endpoint-invalid_request-local_player_slot_one_required'],
    {
      headline: 'message.control.endpoint-invalid_request-local_player_slot_one_required.headline',
      cause: 'message.control.endpoint-invalid_request-local_player_slot_one_required.cause',
      action: step(
        'message.control.endpoint-invalid_request-local_player_slot_one_required.action',
      ),
    },
  ],
  [
    ['endpoint-invalid_request-human_player_slot_unsupported'],
    {
      headline: 'message.control.endpoint-invalid_request-human_player_slot_unsupported.headline',
      cause: 'message.control.endpoint-invalid_request-human_player_slot_unsupported.cause',
      action: reportProblem,
    },
  ],
  [
    ['endpoint-invalid_request-computer_player_slots_not_ascending'],
    {
      headline: 'message.control.computer-player-list.headline',
      cause: 'message.control.endpoint-invalid_request-computer_player_slots_not_ascending.cause',
      action: reportProblem,
    },
  ],
  [
    ['endpoint-invalid_request-computer_player_slot_not_a_player'],
    {
      headline: 'message.control.computer-player-list.headline',
      cause: 'message.control.endpoint-invalid_request-computer_player_slot_not_a_player.cause',
      action: reportProblem,
    },
  ],
  [
    ['endpoint-invalid_request-local_player_slot_one_must_be_human'],
    {
      headline:
        'message.control.endpoint-invalid_request-local_player_slot_one_must_be_human.headline',
      cause: 'message.control.endpoint-invalid_request-local_player_slot_one_must_be_human.cause',
      action: reportProblem,
    },
  ],
  [
    ['rollback-incomplete'],
    {
      headline: 'message.control.rollback-incomplete.headline',
      cause: (facts) => {
        const fields = rollbackFieldList(param(facts, 'rollbackFields'));
        return fields
          ? t('message.control.rollback-incomplete.cause.fields', { fields })
          : t('message.control.rollback-incomplete.cause');
      },
      action: step('message.control.rollback-incomplete.action'),
    },
  ],
];

function buildCatalog(): Readonly<Record<string, CatalogEntry>> {
  const catalog: Record<string, CatalogEntry> = {
    ...rmsCatalog,
    ...generationCatalog,
    ...transportCatalog,
    ...liveCatalog,
    ...deployCatalog,
    ...mapTestCatalog,
    ...gameFolderCatalog,
    ...sourceCatalogCatalog,
    ...desktopRefusalCatalog,
    ...sessionCatalog,
    ...gameTexturesCatalog,
    ...lobbyOptionCatalog,
    ...xsCatalog,
    ...rmsLintCatalog,
  };
  for (const [codes, entry] of [...controlFailures, ...lobbyOptionControlFailures]) {
    for (const code of codes) catalog[`control.${code}`] = entry;
  }
  catalog.RMSGEN3302 = generationCatalog.RMSGEN!;
  catalog.RMSGEN7002 = generationCatalog.RMSGEN!;
  return Object.freeze(catalog);
}

export const messageCatalog: Readonly<Record<string, CatalogEntry>> = buildCatalog();

export const engineCatalogKeys: ReadonlySet<string> = new Set([
  ...Object.keys(rmsCatalog),
  ...Object.keys(generationCatalog).filter((key) => key !== 'generation.source-changed'),
  ...Object.keys(transportCatalog),
  ...Object.keys(xsCatalog),
  ...Object.keys(rmsLintCatalog),
  ...Object.keys(mapTestCatalog).filter(
    (key) => key === 'map-test.execution' || key.startsWith('RMSTEST'),
  ),
  ...Object.keys(lobbyOptionCatalog),
  'RMSGEN3302',
  'RMSGEN7002',
]);

export function catalogKeyFor(code: string): string | null {
  if (messageCatalog[code]) return code;
  if (/^RMSGEN1\d{3}$/u.test(code)) return 'RMSGEN1';
  if (/^RMSGEN\d{4}$/u.test(code)) return 'RMSGEN';
  if (/^RMSXS\d{4}$/u.test(code)) return 'RMSXS';
  if (/^XS\d{4}$/u.test(code)) return 'XS';
  if (/^RMS\d{4}$/u.test(code)) return 'RMS';
  if (/^RMSTEST\d{4}$/u.test(code)) return 'RMSTEST';
  for (const family of ['control', 'deploy', 'protocol', 'jsonrpc'] as const) {
    if (code.startsWith(`${family}.`)) return family;
  }
  return null;
}

export function stripTransport(raw: string): string {
  let text = raw.replace(/\s+/gu, ' ').trim();
  for (;;) {
    const next = text
      .replace(/^Error invoking remote method '[^']*':\s*/u, '')
      .replace(/^(?:[A-Za-z]*Error:\s*)+/u, '')
      .replace(/^-?\d+:\s*/u, '');
    if (next === text) return text;
    text = next;
  }
}

export function transportCode(raw: string): string | null {
  const protocol = /ProtocolResponseError:\s*(\d+):/u.exec(raw);
  if (protocol) return `protocol.${protocol[1]}`;
  const jsonRpc = /(?:^|:\s|\s)(-32\d{3}):/u.exec(raw);
  if (jsonRpc) return `jsonrpc.${jsonRpc[1]}`;
  return null;
}

const deploymentPatterns: Array<[RegExp, string]> = [
  [
    /target changed after preview|changed outside the IDE|recovery target/u,
    'deploy.target-changed',
  ],
  [/conflicting external edits/u, 'deploy.external-edits'],
  [
    /preview is stale or unavailable|policy changed after deployment preview/u,
    'deploy.stale-preview',
  ],
  [/not an IDE-managed mod|not IDE-managed/u, 'deploy.not-managed'],
  [
    /numeric (?:AoE2DE user )?profile|user profile (?:is unavailable|could not be identified)/u,
    'deploy.profile',
  ],
  [/built-in sources must be cloned/u, 'deploy.built-in'],
  [/safety limit/u, 'deploy.too-large'],
  [/redirect/u, 'deploy.redirected'],
  [/replacement was not confirmed/u, 'deploy.unconfirmed'],
  [/no authorized user-owned RMS entry/u, 'deploy.no-map'],
  [/managed mod name is reserved/u, 'deploy.reserved-name'],
  [/mod name must be one Windows-safe folder name/u, 'deploy.invalid-name'],
  [/map icon/u, 'deploy.map-icon'],
  [/XS dependency .+ does not parse/u, 'deploy.xs-syntax'],
];

export function deploymentFailureCode(raw: string): string | null {
  const text = stripTransport(raw);
  return deploymentPatterns.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

export function presentDeploymentFailure(
  raw: string,
  fallbackHeadline?: MessageId | OutputText,
): OutputMessage {
  return presentMessage({
    source: 'Deploy',
    raw,
    code: desktopRefusal(raw)?.code ?? deploymentFailureCode(raw) ?? messageCode(raw),
    ...(fallbackHeadline ? { fallbackHeadline } : {}),
  });
}

export function desktopRefusal(raw: string): DesktopErrorFacts | null {
  const facts = desktopErrorFacts(stripTransport(raw));
  if (!facts || !messageCatalog[facts.code] || engineCatalogKeys.has(facts.code)) return null;
  return facts;
}

export function messageCode(raw: string): string | null {
  const desktop = desktopRefusal(raw);
  if (desktop) return desktop.code;
  const text = stripTransport(raw);
  const suffix = /\((RMS(?:GEN|XS)?\d{4})\)\s*$/u.exec(text);
  if (suffix) return suffix[1]!;
  const engine = /\b(RMSGEN\d{4}|RMSXS\d{4}|RMS\d{4})\b/u.exec(text);
  if (engine) return engine[1]!;
  if (/content pack is invalid/u.test(text)) return 'content.invalid';
  if (
    /is not in the game data of the selected game version|game data of the selected game version does not define/u.test(
      text,
    ) ||
    /is not defined by content pack|selected content pack does not define/u.test(text)
  ) {
    return 'content.missing-definition';
  }
  if (/strict source analysis reported errors/u.test(text)) return 'analysis.source-errors';
  return transportCode(raw);
}

const analyzedLocationPattern =
  /\bthe script could not be analyzed in (\S+?)(?: at line (\d+))?:\s+/u;

const locationPattern = /\bin (\S+) at bytes (\d+)\.\.(\d+):\s*/u;

function documentName(uri: string): string {
  let path = uri.replace(/[?#].*$/u, '');
  try {
    path = decodeURIComponent(path);
  } catch {}
  const segments = path.split(/[\\/]/u).filter(Boolean);
  return segments.at(-1) ?? path;
}

export function messageFacts(input: MessageInput): MessageFacts {
  const raw = input.raw ?? '';
  const text = stripTransport(raw);
  const desktop = raw ? desktopRefusal(raw) : null;
  if (desktop) {
    return {
      text,
      core: desktop.english,
      code: input.code ?? desktop.code,
      location: null,
      place: null,
      params: { ...desktop.args, ...(input.params ?? {}) },
      standardIncludeAccess: input.standardIncludeAccess ?? null,
    };
  }
  let core = text;
  let place: { name: string; line: number | null } | null = null;
  const analyzed = analyzedLocationPattern.exec(core);
  const located = analyzed ? null : locationPattern.exec(core);
  if (analyzed) {
    const uri = analyzed[1]!;
    place = input.place ?? {
      name: input.locate?.(uri, 0)?.name ?? documentName(uri),
      line: analyzed[2] ? Number(analyzed[2]) : null,
    };
    core = core.slice(analyzed.index + analyzed[0].length);
  } else if (located) {
    const uri = located[1]!;
    const resolved = input.place ? null : (input.locate?.(uri, Number(located[2])) ?? null);
    place = input.place ?? {
      name: resolved?.name ?? documentName(uri),
      line: resolved?.line ?? null,
    };
    core = core.slice(located.index + located[0].length);
  }
  const location = place
    ? place.line
      ? t('message.format.file-line', { name: place.name, line: place.line })
      : place.name
    : null;
  core = core
    .replace(
      /^(?:the script could not be analyzed|strict semantic analysis is unavailable):\s*/u,
      '',
    )
    .replace(/^the script could not be analyzed \(RMS(?:GEN|XS)?\d{4}\):\s*/u, '')
    .replace(/^invalid generation request RMS\w+:\s*/u, '')
    .replace(/\s*\((RMS(?:GEN|XS)?\d{4})\)\s*$/u, '')
    .replace(/^RMS(?:GEN|XS)?\d{4}:\s*/u, '')
    .trim();
  return {
    text,
    core,
    code: input.code ?? (raw ? messageCode(raw) : null),
    location,
    place,
    params: input.params ?? {},
    standardIncludeAccess: input.standardIncludeAccess ?? null,
  };
}

const fallbackHeadlines: Record<OutputSource, MessageId> = {
  Run: 'message.fallback.run',
  Script: 'message.fallback.script',
  Preview: 'message.fallback.preview',
  'Map test': 'message.fallback.map-test',
  Deploy: 'message.deploy.headline',
  'Live test': 'message.control.headline',
  Recovery: 'message.fallback.recovery',
  Update: 'message.fallback.update',
  Files: 'message.fallback.files',
  'Game folder': 'message.fallback.game-folder',
  'Game textures': 'message.game-textures.failed.headline',
  App: 'message.fallback.app',
};

export function presentMessage(input: MessageInput): OutputMessage {
  const code = input.code ?? (input.raw ? messageCode(input.raw) : null);
  const key = code ? catalogKeyFor(code) : null;
  if (key && engineCatalogKeys.has(key)) {
    return withTranslator(englishTranslator, () => wordMessage(input));
  }
  const message = wordMessage(input);
  const facts = messageFacts(input);
  const fallbackHeadline =
    typeof input.fallbackHeadline === 'string'
      ? { id: input.fallbackHeadline }
      : input.fallbackHeadline;
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(input.params ?? {})) {
    if (value !== undefined) params[name] = value;
  }
  const wording: OutputCatalogWording = {
    kind: 'catalog',
    source: input.source,
    code: input.code ?? null,
    ...(input.raw !== undefined ? { raw: input.raw } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(fallbackHeadline ? { fallbackHeadline } : {}),
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.standardIncludeAccess ? { standardIncludeAccess: input.standardIncludeAccess } : {}),
    ...(facts.place ? { place: facts.place } : {}),
  };
  return { ...message, wording };
}

export function outputPartWording(
  message: OutputMessage,
  part: 'headline' | 'cause' | 'action',
): 'interface' | 'as-written' {
  const wording = message.wording;
  if (!wording) return 'as-written';
  if (wording.kind === 'text') return wording[part] ? 'interface' : 'as-written';
  const code = wording.code ?? (wording.raw ? messageCode(wording.raw) : null);
  const key = code ? catalogKeyFor(code) : null;
  if (part === 'cause' && (!key || !messageCatalog[key])) return 'as-written';
  return 'interface';
}

export function rewordOutputMessage(message: OutputMessage): OutputMessage {
  const wording = message.wording;
  if (!wording) return message;
  if (wording.kind === 'text') return rewordOutputText(message);
  const again = wordMessage({
    source: wording.source,
    code: wording.code,
    ...(wording.raw !== undefined ? { raw: wording.raw } : {}),
    ...(wording.params ? { params: wording.params } : {}),
    ...(wording.fallbackHeadline ? { fallbackHeadline: wording.fallbackHeadline } : {}),
    ...(wording.severity ? { severity: wording.severity } : {}),
    ...(wording.standardIncludeAccess
      ? { standardIncludeAccess: wording.standardIncludeAccess }
      : {}),
    place: wording.place ?? null,
  });
  const { cause: _cause, action: _action, ...rest } = message;
  return {
    ...rest,
    headline: again.headline,
    ...(again.cause ? { cause: again.cause } : {}),
    ...(again.action ? { action: again.action } : {}),
  };
}

function wordFallbackHeadline(input: MessageInput): string {
  const fallback = input.fallbackHeadline;
  if (fallback === undefined) return t(fallbackHeadlines[input.source]);
  return wordOutputText(typeof fallback === 'string' ? { id: fallback } : fallback);
}

function wordMessage(input: MessageInput): OutputMessage {
  const facts = messageFacts(input);
  const key = facts.code ? catalogKeyFor(facts.code) : null;
  const entry = key ? messageCatalog[key] : undefined;
  const raw = input.raw?.trim();
  const detail = raw ? raw : undefined;
  if (!entry) {
    const cause = engineCause(facts);
    return {
      code: facts.code ?? 'unknown',
      severity: input.severity ?? 'error',
      source: input.source,
      headline: wordFallbackHeadline(input),
      ...(cause ? { cause: facts.location ? locatedCause(facts, cause) : cause } : {}),
      ...(detail ? { detail } : {}),
    };
  }
  const headline =
    entry.headline === undefined
      ? wordFallbackHeadline(input)
      : resolveHeadline(entry.headline, facts);
  const cause = resolveCatalogText(entry.cause, facts);
  const action = resolveCatalogAction(entry.action, facts);
  return {
    code: facts.code!,
    severity: entry.severity ?? input.severity ?? 'error',
    source: entry.source ?? input.source,
    headline,
    ...(cause ? { cause } : {}),
    ...(action ? { action } : {}),
    ...(detail ? { detail } : {}),
  };
}

export function inlineErrorText(raw: string): string {
  const desktop = desktopRefusal(raw);
  if (!desktop) return stripTransport(raw);
  const message = wordMessage({ source: 'App', code: desktop.code, raw });
  const parts = [message.cause ?? message.headline, message.action?.label].filter(
    (part): part is string => Boolean(part),
  );
  return parts.map((part) => sentence(part)).join(' ');
}

export function userFacingErrorText(
  raw: string,
  source: OutputSource = 'App',
  fallbackHeadline?: MessageId | OutputText,
): string {
  const message = presentMessage({
    source,
    raw,
    ...(fallbackHeadline ? { fallbackHeadline } : {}),
  });
  const translator = message.wording ? activeTranslator() : englishTranslator;
  return [message.headline, message.cause, message.action?.label]
    .filter((part): part is string => Boolean(part))
    .map((part) => sentence(part, translator))
    .join(' ');
}

export function locateDocumentLine(
  documents: readonly { uri: string; name: string; content: string }[],
  uri: string,
  byteOffset: number,
): { name: string; line: number | null } | null {
  const key = documentUriKey(uri);
  const document = documents.find((candidate) => documentUriKey(candidate.uri) === key);
  if (!document) return null;
  const bytes = new TextEncoder().encode(document.content);
  if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset > bytes.length) {
    return { name: document.name, line: null };
  }
  let line = 1;
  for (let index = 0; index < byteOffset; index += 1) if (bytes[index] === 0x0a) line += 1;
  return { name: document.name, line };
}

function documentUriKey(uri: string): string {
  try {
    return decodeURIComponent(uri).replaceAll('\\', '/').toLowerCase();
  } catch {
    return uri.toLowerCase();
  }
}

export interface DiagnosticInput {
  code?: string | number | null;
  message: string;
  severity: OutputSeverity;
}

const familyKeys = new Set([
  'RMS',
  'RMSGEN',
  'RMSGEN1',
  'RMSXS',
  'XS',
  'control',
  'deploy',
  'protocol',
  'jsonrpc',
]);

export function undefinedNumericNote(
  message: string,
): { symbol: string; value: string; file: string | null } | null {
  const current = /^(\S+) is not defined where (.+) reads it, so it counts as (\S+?)\.?$/u.exec(
    message,
  );
  if (current) return { symbol: current[1]!, file: current[2]!, value: current[3]! };
  const earlier = /resolved undefined numeric (\S+) to (\S+?) in (\S+?)\.?$/u.exec(message);
  if (earlier) return { symbol: earlier[1]!, value: earlier[2]!, file: earlier[3]! };
  return null;
}

export function skippedIncludeNote(message: string): { include: string; file: string } | null {
  const current = /^(.+) skips the missing include (\S+), as the game allows\.?$/u.exec(message);
  if (current) return { file: current[1]!, include: current[2]! };
  const earlier = /ignored the allowlisted missing include (\S+) in (\S+?)\.?$/u.exec(message);
  if (earlier) return { include: earlier[1]!, file: earlier[2]! };
  return null;
}

export function presentDiagnostic(input: DiagnosticInput): OutputMessage {
  return withTranslator(englishTranslator, () => wordDiagnostic(input));
}

function wordDiagnostic(input: DiagnosticInput): OutputMessage {
  const code = input.code === undefined || input.code === null ? 'RMS' : String(input.code);
  const message = input.message.replace(/\s+/gu, ' ').trim();
  const base = { code, severity: input.severity, source: 'Script' as const, detail: input.message };
  if (code === 'RMS2034') {
    const note = undefinedNumericNote(message);
    if (note) {
      return {
        ...base,
        headline: t('message.RMS2034.headline', { symbol: note.symbol, value: note.value }),
        cause: t('message.RMS2034.cause'),
        action: { label: t('message.RMS2034.action') },
      };
    }
  }
  if (code === 'RMS2022') {
    const note = skippedIncludeNote(message);
    if (note) {
      return {
        ...base,
        headline: t('message.RMS2022.headline', { include: note.include }),
        cause: t('message.RMS2022.cause'),
      };
    }
  }
  if (code === 'RMS1003') {
    return {
      ...base,
      headline: t('message.RMS1003.headline'),
      cause: t('message.RMS1003.cause'),
    };
  }
  const key = catalogKeyFor(code);
  if (key && !familyKeys.has(key)) {
    const presented = presentMessage({ source: 'Script', code, raw: input.message });
    return { ...presented, severity: input.severity, source: 'Script' };
  }
  const plain = message.replace(/\.$/u, '');
  return {
    ...base,
    headline: !plain
      ? t('message.problems.headline')
      : /^[a-z]+(?![a-z]|[_\d])/u.test(plain)
        ? plain.charAt(0).toUpperCase() + plain.slice(1)
        : plain,
  };
}

export function presentCompatibilitySummary(input: {
  undefinedNames: readonly string[];
  skippedIncludes: readonly string[];
}): OutputMessage {
  return withTranslator(englishTranslator, () => wordCompatibilitySummary(input));
}

function wordCompatibilitySummary(input: {
  undefinedNames: readonly string[];
  skippedIncludes: readonly string[];
}): OutputMessage {
  const names = input.undefinedNames.length;
  const includes = input.skippedIncludes.length;
  const headline =
    names > 0 && includes > 0
      ? t('message.problems.compatibility-summary.headline.both', { names, includes })
      : names > 0
        ? t('message.problems.compatibility-summary.headline.names', { names })
        : includes > 0
          ? t('message.problems.compatibility-summary.headline.includes', { includes })
          : '';
  const detail = [
    names > 0 ? `Undefined names: ${input.undefinedNames.join(', ')}` : '',
    includes > 0 ? `Skipped includes: ${input.skippedIncludes.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    code: 'problems.compatibility-summary',
    severity: 'info',
    source: 'Script',
    headline,
    cause:
      names > 0
        ? t('message.problems.compatibility-summary.cause.names')
        : t('message.problems.compatibility-summary.cause.includes'),
    detail,
  };
}
