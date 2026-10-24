export const connectorIpcChannels = {
  connectorState: 'rmside:connector:state',
  connectorStateEvent: 'rmside:connector:state-event',
  connectorOutputEvent: 'rmside:connector:output-event',
  connectorSettingsSet: 'rmside:connector:settings-set',
  connectorAppRemove: 'rmside:connector:app-remove',
  connectorPairingDecide: 'rmside:connector:pairing-decide',
  connectorSetup: 'rmside:connector:setup',
  connectorRequestEvent: 'rmside:connector:request',
  connectorReply: 'rmside:connector:reply',
} as const;

export const connectorToolNames = [
  'ide_status',
  'list_files',
  'read_file',
  'edit_file',
  'create_file',
  'save_file',
  'get_problems',
  'generate_map',
  'show_map',
  'inspect_map',
  'get_picture',
  'contact_sheet',
  'run_map_test',
  'run_quality_check',
  'run_status',
  'get_details',
  'deploy_mod',
  'live_test',
  'read_guide',
  'lookup_reference',
] as const;
export type ConnectorToolName = (typeof connectorToolNames)[number];

export const connectorErrorCodes = [
  'ide_not_running',
  'version_mismatch',
  'not_approved_yet',
  'not_allowed',
  'invalid_arguments',
  'no_folder_open',
  'outside_workspace',
  'file_type_not_allowed',
  'not_found',
  'already_exists',
  'too_large',
  'binary_file',
  'edit_conflict',
  'saving_off',
  'busy',
  'map_expired',
  'run_expired',
  'stopped',
  'cancelled',
  'user_declined',
  'needs_user_at_pc',
  'blocked_known_crash',
  'game_not_ready',
  'rate_limited',
  'too_many_calls',
  'internal',
] as const;
export type ConnectorErrorCode = (typeof connectorErrorCodes)[number];

export function isConnectorToolName(value: unknown): value is ConnectorToolName {
  return typeof value === 'string' && (connectorToolNames as readonly string[]).includes(value);
}

export function isConnectorErrorCode(value: unknown): value is ConnectorErrorCode {
  return typeof value === 'string' && (connectorErrorCodes as readonly string[]).includes(value);
}

export const connectorBridgeLimits = Object.freeze({
  appName: 64,
  appTitle: 64,
  appVersion: 32,
  launcherImage: 255,
  displayName: 128,
  allowedApps: 32,
  connections: 4,
  pairingRequests: 4,
  setupProgram: 1024,
  setupArguments: 4,
  setupArgument: 1024,
  factText: 260,
  requestId: 64,
  replyMessage: 512,
  bridgePayloadChars: 2 * 1024 * 1024,
  bridgePayloadBytes: 40 * 1024 * 1024,
});

export type ConnectorPairing = 'approved' | 'pending' | 'denied';

export const connectorFailures = ['pipe-in-use', 'key-file', 'catalog', 'internal'] as const;
export type ConnectorFailure = (typeof connectorFailures)[number];

export interface ConnectorConnectionState {
  id: string;
  name: string;
  displayName: string;
  pairing: ConnectorPairing;
  working: boolean;
}

export interface ConnectorAllowedApp {
  name: string;
  title: string;
  firstAllowed: string;
  lastUsed: string;
  connected: boolean;
}

export interface ConnectorPairingRequest {
  id: string;
  name: string;
  displayName: string;
  title: string;
  version: string;
  launcherImage: string;
}

export interface ConnectorState {
  enabled: boolean;
  allowSaving: boolean;
  server: { status: 'off' | 'running' | 'failed'; failure: ConnectorFailure | null };
  connections: ConnectorConnectionState[];
  allowedApps: ConnectorAllowedApp[];
  pairingRequests: ConnectorPairingRequest[];
}

export interface ConnectorSettingsPatch {
  enabled?: boolean;
  allowSaving?: boolean;
}

export type ConnectorPairingDecision = 'allow' | 'deny';

export interface ConnectorSetup {
  program: string;
  args: string[];
}

export interface ConnectorOutputFacts {
  file?: string;
  seed?: number;
  count?: number;
  seeds?: number;
  mod?: string;
  name?: string;
  running?: string;
}

export type ConnectorCallOutcome = 'done' | 'failed' | 'refused' | 'cancelled';

export type ConnectorOutputRow =
  | {
      kind: 'call';
      app: string;
      tool: ConnectorToolName;
      outcome: ConnectorCallOutcome;
      severity: 'info' | 'warning';
      error?: ConnectorErrorCode;
      facts?: ConnectorOutputFacts;
      durationMs: number;
    }
  | { kind: 'connected' | 'disconnected' | 'denied'; app: string; severity: 'info' | 'warning' };

export const connectorRendererRequestKinds = [
  'applyEdit',
  'openBackground',
  'save',
  'editorState',
  'run',
  'resolveRunContext',
  'deploy',
  'liveTest',
  'prompt',
  'pictureView',
  'pictureInput',
  'pictureTextures',
] as const;
export type ConnectorRendererRequestKind = (typeof connectorRendererRequestKinds)[number];

export interface ConnectorRendererRequest {
  requestId: string;
  kind: ConnectorRendererRequestKind;
  payload: unknown;
}

export type ConnectorRendererReply =
  | { requestId: string; ok: true; payload: unknown }
  | { requestId: string; ok: false; error: { code: ConnectorErrorCode; message: string } };

export interface ConnectorDesktopApi {
  getConnectorState(): Promise<ConnectorState>;
  onConnectorState(listener: (state: ConnectorState) => void): () => void;
  onConnectorOutput(listener: (row: ConnectorOutputRow) => void): () => void;
  setConnectorSettings(patch: ConnectorSettingsPatch): Promise<ConnectorState>;
  removeConnectorApp(name: string): Promise<void>;
  decideConnectorPairing(requestId: string, decision: ConnectorPairingDecision): Promise<void>;
  getConnectorSetup(): Promise<ConnectorSetup>;
  onConnectorRequest(listener: (request: ConnectorRendererRequest) => void): () => void;
  replyToConnectorRequest(reply: ConnectorRendererReply): Promise<void>;
}

const requestIdPattern = /^[A-Za-z0-9-]{1,64}$/u;
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${label} has the unknown field ${key}`);
  }
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} is not a boolean`);
  return value;
}

export function isConnectorDisplayText(value: unknown, minimum: number, maximum: number): boolean {
  if (typeof value !== 'string') return false;
  const count = [...value].length;
  return count >= minimum && count <= maximum && !/\p{Cc}/u.test(value);
}

function text(value: unknown, minimum: number, maximum: number, label: string): string {
  if (!isConnectorDisplayText(value, minimum, maximum)) {
    throw new Error(`${label} is not text of ${minimum} to ${maximum} characters`);
  }
  return value as string;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new Error(`${label} is not one of ${values.join(', ')}`);
  }
  return value as T;
}

function list<T>(
  value: unknown,
  maximum: number,
  label: string,
  item: (entry: unknown, label: string) => T,
): T[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} is not a list of at most ${maximum}`);
  }
  return value.map((entry, index) => item(entry, `${label}[${index}]`));
}

function requestId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !requestIdPattern.test(value)) {
    throw new Error(`${label} is not a request id`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isoTimestampPattern.test(value)) {
    throw new Error(`${label} is not an ISO timestamp`);
  }
  return value;
}

function boundedInteger(value: unknown, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${label} is not an integer from 0 to ${maximum}`);
  }
  return value as number;
}

const limits = connectorBridgeLimits;

export function validateConnectorState(value: unknown): ConnectorState {
  const state = record(value, 'connector state');
  knownKeys(
    state,
    ['enabled', 'allowSaving', 'server', 'connections', 'allowedApps', 'pairingRequests'],
    'connector state',
  );
  const server = record(state.server, 'connector server');
  knownKeys(server, ['status', 'failure'], 'connector server');
  const status = oneOf(server.status, ['off', 'running', 'failed'] as const, 'server status');
  const failure =
    server.failure === null ? null : oneOf(server.failure, connectorFailures, 'server failure');
  if ((status === 'failed') !== (failure !== null)) {
    throw new Error('server failure must be given if and only if the server failed');
  }
  return {
    enabled: bool(state.enabled, 'enabled'),
    allowSaving: bool(state.allowSaving, 'allowSaving'),
    server: { status, failure },
    connections: list(state.connections, limits.connections, 'connections', (entry, label) => {
      const connection = record(entry, label);
      knownKeys(connection, ['id', 'name', 'displayName', 'pairing', 'working'], label);
      return {
        id: requestId(connection.id, `${label}.id`),
        name: text(connection.name, 1, limits.appName, `${label}.name`),
        displayName: text(connection.displayName, 1, limits.displayName, `${label}.displayName`),
        pairing: oneOf(
          connection.pairing,
          ['approved', 'pending', 'denied'] as const,
          `${label}.pairing`,
        ),
        working: bool(connection.working, `${label}.working`),
      };
    }),
    allowedApps: list(state.allowedApps, limits.allowedApps, 'allowedApps', (entry, label) => {
      const app = record(entry, label);
      knownKeys(app, ['name', 'title', 'firstAllowed', 'lastUsed', 'connected'], label);
      return {
        name: text(app.name, 1, limits.appName, `${label}.name`),
        title: text(app.title, 0, limits.appTitle, `${label}.title`),
        firstAllowed: timestamp(app.firstAllowed, `${label}.firstAllowed`),
        lastUsed: timestamp(app.lastUsed, `${label}.lastUsed`),
        connected: bool(app.connected, `${label}.connected`),
      };
    }),
    pairingRequests: list(
      state.pairingRequests,
      limits.pairingRequests,
      'pairingRequests',
      (entry, label) => {
        const request = record(entry, label);
        knownKeys(
          request,
          ['id', 'name', 'displayName', 'title', 'version', 'launcherImage'],
          label,
        );
        return {
          id: requestId(request.id, `${label}.id`),
          name: text(request.name, 1, limits.appName, `${label}.name`),
          displayName: text(request.displayName, 1, limits.displayName, `${label}.displayName`),
          title: text(request.title, 0, limits.appTitle, `${label}.title`),
          version: text(request.version, 0, limits.appVersion, `${label}.version`),
          launcherImage: text(
            request.launcherImage,
            0,
            limits.launcherImage,
            `${label}.launcherImage`,
          ),
        };
      },
    ),
  };
}

function validateFacts(value: unknown, label: string): ConnectorOutputFacts {
  const facts = record(value, label);
  knownKeys(facts, ['file', 'seed', 'count', 'seeds', 'mod', 'name', 'running'], label);
  const result: ConnectorOutputFacts = {};
  for (const key of ['file', 'mod', 'name', 'running'] as const) {
    if (facts[key] !== undefined) result[key] = text(facts[key], 1, limits.factText, key);
  }
  if (facts.seed !== undefined) {
    if (
      !Number.isSafeInteger(facts.seed) ||
      (facts.seed as number) < -2147483648 ||
      (facts.seed as number) > 4294967295
    ) {
      throw new Error(`${label}.seed is not a seed`);
    }
    result.seed = facts.seed as number;
  }
  for (const key of ['count', 'seeds'] as const) {
    if (facts[key] !== undefined) result[key] = boundedInteger(facts[key], 100_000, key);
  }
  return result;
}

export function validateConnectorOutputRow(value: unknown): ConnectorOutputRow {
  const row = record(value, 'connector output row');
  const app = text(row.app, 1, limits.displayName, 'row app');
  const severity = oneOf(row.severity, ['info', 'warning'] as const, 'row severity');
  if (row.kind === 'call') {
    knownKeys(
      row,
      ['kind', 'app', 'tool', 'outcome', 'severity', 'error', 'facts', 'durationMs'],
      'row',
    );
    if (!isConnectorToolName(row.tool)) throw new Error('row tool is not a catalog tool');
    if (row.error !== undefined && !isConnectorErrorCode(row.error)) {
      throw new Error('row error is not a catalog error code');
    }
    return {
      kind: 'call',
      app,
      tool: row.tool,
      outcome: oneOf(
        row.outcome,
        ['done', 'failed', 'refused', 'cancelled'] as const,
        'row outcome',
      ),
      severity,
      ...(row.error === undefined ? {} : { error: row.error }),
      ...(row.facts === undefined ? {} : { facts: validateFacts(row.facts, 'row facts') }),
      durationMs: boundedInteger(row.durationMs, 24 * 60 * 60 * 1000, 'row durationMs'),
    };
  }
  knownKeys(row, ['kind', 'app', 'severity'], 'row');
  return {
    kind: oneOf(row.kind, ['connected', 'disconnected', 'denied'] as const, 'row kind'),
    app,
    severity,
  };
}

export function validateConnectorSettingsPatch(value: unknown): ConnectorSettingsPatch {
  const patch = record(value, 'connector settings');
  knownKeys(patch, ['enabled', 'allowSaving'], 'connector settings');
  return {
    ...(patch.enabled === undefined ? {} : { enabled: bool(patch.enabled, 'enabled') }),
    ...(patch.allowSaving === undefined
      ? {}
      : { allowSaving: bool(patch.allowSaving, 'allowSaving') }),
  };
}

export function validateConnectorAppName(value: unknown): string {
  return text(value, 1, limits.appName, 'app name');
}

export function validateConnectorPairingAnswer(
  id: unknown,
  decision: unknown,
): { requestId: string; decision: ConnectorPairingDecision } {
  return {
    requestId: requestId(id, 'pairing request id'),
    decision: oneOf(decision, ['allow', 'deny'] as const, 'pairing decision'),
  };
}

export function validateConnectorSetup(value: unknown): ConnectorSetup {
  const setup = record(value, 'connector setup');
  knownKeys(setup, ['program', 'args'], 'connector setup');
  return {
    program: text(setup.program, 1, limits.setupProgram, 'setup program'),
    args: list(setup.args, limits.setupArguments, 'setup args', (entry, label) =>
      text(entry, 1, limits.setupArgument, label),
    ),
  };
}

function boundedPayload(value: unknown, label: string): unknown {
  let json: string | undefined;
  let bytes = 0;
  try {
    json = JSON.stringify(value, (_key, entry: unknown) => {
      if (ArrayBuffer.isView(entry) || entry instanceof ArrayBuffer) {
        bytes += entry.byteLength;
        return '';
      }
      return entry;
    });
  } catch {
    throw new Error(`${label} is not JSON`);
  }
  if (
    (json !== undefined && json.length > limits.bridgePayloadChars) ||
    bytes > limits.bridgePayloadBytes
  ) {
    throw new Error(`${label} exceeds its bounded size`);
  }
  return value;
}

export function validateConnectorRendererRequest(value: unknown): ConnectorRendererRequest {
  const request = record(value, 'connector request');
  knownKeys(request, ['requestId', 'kind', 'payload'], 'connector request');
  return {
    requestId: requestId(request.requestId, 'connector request id'),
    kind: oneOf(request.kind, connectorRendererRequestKinds, 'connector request kind'),
    payload: boundedPayload(request.payload, 'connector request payload'),
  };
}

export function validateConnectorRendererReply(value: unknown): ConnectorRendererReply {
  const reply = record(value, 'connector reply');
  const id = requestId(reply.requestId, 'connector reply id');
  if (bool(reply.ok, 'connector reply ok')) {
    knownKeys(reply, ['requestId', 'ok', 'payload'], 'connector reply');
    return { requestId: id, ok: true, payload: boundedPayload(reply.payload, 'reply payload') };
  }
  knownKeys(reply, ['requestId', 'ok', 'error'], 'connector reply');
  const error = record(reply.error, 'connector reply error');
  knownKeys(error, ['code', 'message'], 'connector reply error');
  if (!isConnectorErrorCode(error.code)) throw new Error('reply error code is not a catalog code');
  return {
    requestId: id,
    ok: false,
    error: {
      code: error.code,
      message: text(error.message, 1, limits.replyMessage, 'reply error message'),
    },
  };
}
