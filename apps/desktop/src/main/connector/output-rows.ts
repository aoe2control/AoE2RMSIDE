import {
  connectorBridgeLimits,
  isConnectorDisplayText,
  type ConnectorCallOutcome,
  type ConnectorErrorCode,
  type ConnectorOutputFacts,
  type ConnectorOutputRow,
  type ConnectorToolName,
} from '../../shared/connector-api';

export function boundedOutputFacts(
  facts: ConnectorOutputFacts | undefined,
): ConnectorOutputFacts | undefined {
  if (!facts) return undefined;
  const result: ConnectorOutputFacts = {};
  for (const key of ['file', 'mod', 'name', 'running'] as const) {
    const value = facts[key];
    if (isConnectorDisplayText(value, 1, connectorBridgeLimits.factText)) result[key] = value;
  }
  if (Number.isSafeInteger(facts.seed) && facts.seed! >= -2147483648 && facts.seed! <= 4294967295) {
    result.seed = facts.seed!;
  }
  for (const key of ['count', 'seeds'] as const) {
    const value = facts[key];
    if (Number.isSafeInteger(value) && value! >= 0 && value! <= 100_000) result[key] = value!;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function callOutputRow(options: {
  app: string;
  tool: ConnectorToolName;
  outcome: ConnectorCallOutcome;
  error?: ConnectorErrorCode;
  facts?: ConnectorOutputFacts;
  durationMs: number;
}): ConnectorOutputRow {
  const facts = boundedOutputFacts(options.facts);
  return {
    kind: 'call',
    app: options.app,
    tool: options.tool,
    outcome: options.outcome,
    severity: options.outcome === 'done' || options.outcome === 'failed' ? 'info' : 'warning',
    ...(options.error ? { error: options.error } : {}),
    ...(facts ? { facts } : {}),
    durationMs: Math.min(24 * 60 * 60 * 1000, Math.max(0, Math.round(options.durationMs))),
  };
}

export function connectionOutputRow(
  kind: 'connected' | 'disconnected' | 'denied',
  app: string,
): ConnectorOutputRow {
  return { kind, app, severity: kind === 'denied' ? 'warning' : 'info' };
}
