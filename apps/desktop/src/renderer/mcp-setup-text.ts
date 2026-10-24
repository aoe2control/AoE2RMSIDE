import type { ConnectorSetup } from '../shared/connector-api';

export const connectorSetupChoices = ['claude-desktop', 'claude-code', 'codex', 'other'] as const;
export type ConnectorSetupChoice = (typeof connectorSetupChoices)[number];

export const connectorServerName = 'aoe2rmside';

export function commandLineArgument(value: string): string {
  return /^[A-Za-z0-9_\-.:\\/=]+$/u.test(value) ? value : `"${value}"`;
}

function commandLine(setup: ConnectorSetup): string {
  return [`"${setup.program}"`, ...setup.args.map(commandLineArgument)].join(' ');
}

export function connectorSetupText(choice: ConnectorSetupChoice, setup: ConnectorSetup): string {
  if (choice === 'claude-desktop') {
    return JSON.stringify(
      { mcpServers: { [connectorServerName]: { command: setup.program, args: setup.args } } },
      null,
      2,
    );
  }
  if (choice === 'claude-code') {
    return `claude mcp add --scope user ${connectorServerName} -- ${commandLine(setup)}`;
  }
  if (choice === 'codex') {
    return `codex mcp add ${connectorServerName} -- ${commandLine(setup)}`;
  }
  return commandLine(setup);
}

export function connectorPromptText(setup: ConnectorSetup): string {
  const args = setup.args.length === 0 ? 'none' : setup.args.map(commandLineArgument).join(' ');
  return [
    'Connect yourself to AoE2RMSIDE, the Age of Empires II map script editor running on this computer, through its MCP server. Reply to me in the language I use with you.',
    '',
    'Server',
    `- Name: ${connectorServerName}`,
    '- Type: local stdio server (Windows)',
    `- Command: "${setup.program}"`,
    `- Arguments: ${args}`,
    '',
    'Steps',
    '1. Add the server to your own MCP configuration and keep the existing entries.',
    `   - Claude Code: run  ${connectorSetupText('claude-code', setup)}`,
    `   - Codex: run  ${connectorSetupText('codex', setup)}`,
    '   - Claude Desktop: add it under "mcpServers" in claude_desktop_config.json (usually in %APPDATA%\\Claude\\); I then restart Claude Desktop.',
    '   - Another app: register it as a local stdio MCP server the way that app does.',
    '2. If your app has to restart or reload before new servers work, tell me precisely what to do.',
    '3. Call the tool ide_status. AoE2RMSIDE then asks me to allow you; tell me to click Allow there.',
    "4. If something blocks you (you cannot change your configuration, the program is missing, the connection is refused, or AoE2RMSIDE answers that MCP is off), stop and tell me in plain words what blocks you and what I can do. Don't work around it.",
  ].join('\n');
}
