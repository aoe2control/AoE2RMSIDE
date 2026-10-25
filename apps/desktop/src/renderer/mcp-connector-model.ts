import type {
  ConnectorAllowedApp,
  ConnectorErrorCode,
  ConnectorOutputFacts,
  ConnectorOutputRow,
  ConnectorState,
  ConnectorToolName,
} from '../shared/connector-api';
import type { MessageId } from '../shared/i18n/translator';
import { outputNote, type OutputMessage, type OutputText } from '../shared/output-message';

export type ConnectorIndicatorState =
  | { kind: 'hidden' }
  | {
      kind: 'connected';
      apps: string[];
      working: string | null;
    };

export function connectorIndicatorState(state: ConnectorState | null): ConnectorIndicatorState {
  if (!state?.enabled) return { kind: 'hidden' };
  const approved = state.connections.filter((connection) => connection.pairing === 'approved');
  if (approved.length === 0) return { kind: 'hidden' };
  const apps = [...new Set(approved.map((connection) => connection.displayName))];
  const working = approved.find((connection) => connection.working)?.displayName ?? null;
  return { kind: 'connected', apps, working };
}

export function connectorAppsConnected(state: ConnectorState | null): boolean {
  return connectorIndicatorState(state).kind === 'connected';
}

export interface ConnectorAppRow {
  name: string;
  label: string;
  connected: boolean;
  lastUsed: Date;
}

export function connectorAppRows(apps: readonly ConnectorAllowedApp[]): ConnectorAppRow[] {
  return apps.map((app) => ({
    name: app.name,
    label: app.title.trim() === '' ? app.name : app.title,
    connected: app.connected,
    lastUsed: new Date(app.lastUsed),
  }));
}

export function connectPanelOpensOnEnable(
  before: ConnectorState | null,
  after: ConnectorState,
  latest: ConnectorState | null = after,
): boolean {
  return (
    before?.enabled !== true &&
    after.enabled &&
    after.server.status === 'running' &&
    after.allowedApps.length === 0 &&
    after.pairingRequests.length === 0 &&
    (latest?.pairingRequests.length ?? 0) === 0
  );
}

export function connectRowVariant(state: ConnectorState | null): 'secondary' | 'ghost' {
  return (state?.allowedApps.length ?? 0) === 0 ? 'secondary' : 'ghost';
}

type ActionWords = (facts: ConnectorOutputFacts) => OutputText | null;

const generic = (tool: string): OutputText => ({ id: 'mcp.action.tool', args: { tool } });

function withFile(id: MessageId): ActionWords {
  return (facts) => (facts.file ? { id, args: { file: facts.file } } : null);
}

function plain(id: MessageId): ActionWords {
  return () => ({ id });
}

const actionWords: Readonly<Record<ConnectorToolName | 'show_map', ActionWords>> = {
  ide_status: plain('mcp.action.status'),
  list_files: plain('mcp.action.list-files'),
  read_file: withFile('mcp.action.read-file'),
  edit_file: withFile('mcp.action.edit-file'),
  create_file: withFile('mcp.action.create-file'),
  save_file: withFile('mcp.action.save-file'),
  get_problems: withFile('mcp.action.problems'),
  generate_map: (facts) =>
    facts.file && facts.seed !== undefined
      ? { id: 'mcp.action.generate', args: { file: facts.file, seed: facts.seed } }
      : null,
  show_map: withFile('mcp.action.show-map'),
  inspect_map: plain('mcp.action.inspect'),
  get_picture: withFile('mcp.action.picture'),
  contact_sheet: (facts) =>
    facts.file && facts.count !== undefined
      ? { id: 'mcp.action.contact-sheet', args: { file: facts.file, count: facts.count } }
      : null,
  run_map_test: withFile('mcp.action.map-test'),
  run_quality_check: (facts) =>
    facts.file && facts.seeds !== undefined
      ? { id: 'mcp.action.quality-check', args: { file: facts.file, seeds: facts.seeds } }
      : null,
  run_status: plain('mcp.action.run-status'),
  get_details: plain('mcp.action.details'),
  deploy_mod: (facts) =>
    facts.file && facts.mod
      ? { id: 'mcp.action.deploy', args: { file: facts.file, mod: facts.mod } }
      : null,
  live_test: withFile('mcp.action.live-test'),
  read_guide: plain('mcp.action.guide'),
  lookup_reference: (facts) =>
    facts.name ? { id: 'mcp.action.reference', args: { name: facts.name } } : null,
  list_folders: plain('mcp.action.list-folders'),
  open_folder: (facts) =>
    facts.name
      ? { id: 'mcp.action.open-folder', args: { name: facts.name } }
      : { id: 'mcp.action.open-folder-open' },
};

export function connectorActionText(tool: string, facts: ConnectorOutputFacts = {}): OutputText {
  const words = (actionWords as Readonly<Record<string, ActionWords | undefined>>)[tool];
  return words?.(facts) ?? generic(tool);
}

const refusalCauses: Readonly<Partial<Record<ConnectorErrorCode, MessageId>>> = {
  not_approved_yet: 'mcp.refusal.waiting',
  needs_user_at_pc: 'mcp.refusal.waiting',
  not_allowed: 'mcp.refusal.not-allowed',
  invalid_arguments: 'mcp.refusal.invalid-arguments',
  no_folder_open: 'mcp.refusal.no-folder-open',
  outside_workspace: 'mcp.refusal.outside-workspace',
  file_type_not_allowed: 'mcp.refusal.file-type',
  not_found: 'mcp.refusal.not-found',
  already_exists: 'mcp.refusal.already-exists',
  too_large: 'mcp.refusal.too-large',
  binary_file: 'mcp.refusal.binary-file',
  edit_conflict: 'mcp.refusal.edit-conflict',
  saving_off: 'mcp.refusal.saving-off',
  busy: 'mcp.refusal.busy',
  map_expired: 'mcp.refusal.map-expired',
  run_expired: 'mcp.refusal.run-expired',
  stopped: 'mcp.refusal.stopped',
  cancelled: 'mcp.refusal.cancelled',
  user_declined: 'mcp.refusal.user-declined',
  blocked_known_crash: 'mcp.refusal.known-crash',
  game_not_ready: 'mcp.refusal.game-not-ready',
  rate_limited: 'mcp.refusal.too-many',
  too_many_calls: 'mcp.refusal.too-many',
  internal: 'mcp.refusal.internal',
};

const toolRefusalCauses: Readonly<
  Partial<Record<ConnectorToolName, Partial<Record<ConnectorErrorCode, MessageId>>>>
> = {
  open_folder: { not_found: 'mcp.refusal.folder-gone', busy: 'mcp.refusal.folder-busy' },
};

function rowCode(kind: string): string {
  return `connector.${kind}`;
}

export function connectorOutputMessage(row: ConnectorOutputRow): OutputMessage {
  if (row.kind !== 'call') {
    const id: MessageId =
      row.kind === 'connected'
        ? 'mcp.output.connected'
        : row.kind === 'disconnected'
          ? 'mcp.output.disconnected'
          : 'mcp.output.denied';
    return outputNote(
      'MCP',
      rowCode(row.kind),
      { id, args: { app: row.app } },
      {
        severity: row.severity,
      },
    );
  }
  const facts = row.facts ?? {};
  if (row.outcome === 'done' || row.outcome === 'failed') {
    return outputNote(
      'MCP',
      rowCode('call'),
      {
        id: 'mcp.output.call',
        args: { app: row.app, action: connectorActionText(row.tool, facts) },
      },
      {
        severity: row.severity,
        detail: row.tool,
        ...(row.outcome === 'failed' ? { cause: { id: 'mcp.output.call-failed' } } : {}),
      },
    );
  }
  const detail = row.error ? `${row.tool}: ${row.error}` : row.tool;
  if (row.error === 'busy' && facts.running) {
    return outputNote(
      'MCP',
      rowCode('busy'),
      { id: 'mcp.output.busy', args: { app: row.app, running: facts.running } },
      { severity: row.severity, detail },
    );
  }
  const cause = row.error
    ? (toolRefusalCauses[row.tool]?.[row.error] ?? refusalCauses[row.error])
    : undefined;
  return outputNote(
    'MCP',
    rowCode(row.outcome),
    {
      id: row.outcome === 'cancelled' ? 'mcp.output.cancelled' : 'mcp.output.refused',
      args: { app: row.app, tool: row.tool },
    },
    { severity: row.severity, detail, ...(cause ? { cause: { id: cause } } : {}) },
  );
}

export interface ConnectorDeployNotice {
  app: string;
  file: string;
  mod: string;
}

export function connectorDeployNotice(row: ConnectorOutputRow): ConnectorDeployNotice | null {
  if (row.kind !== 'call' || row.tool !== 'deploy_mod' || row.outcome !== 'done') return null;
  const { file, mod } = row.facts ?? {};
  return file && mod ? { app: row.app, file, mod } : null;
}
