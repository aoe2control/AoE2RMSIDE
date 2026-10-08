export type DesktopErrorArgument = string | number;
export type DesktopErrorArguments = Readonly<Record<string, DesktopErrorArgument>>;

export interface DesktopErrorFacts {
  code: string;
  args: DesktopErrorArguments;
  english: string;
}

const codePattern = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/u;
const argumentNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const maximumArguments = 8;
const maximumArgumentText = 512;
const suffixPattern = /\s\(([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)(?: (\{.*\}))?\)$/su;

export function desktopErrorMessage(
  code: string,
  english: string,
  args: DesktopErrorArguments = {},
): string {
  if (!codePattern.test(code)) throw new Error(`desktop error code ${code} is malformed`);
  const bounded = boundedArguments(args);
  if (!bounded) throw new Error(`desktop error ${code} has malformed arguments`);
  const json = Object.keys(bounded).length > 0 ? ` ${JSON.stringify(bounded)}` : '';
  return `${english.trim()} (${code}${json})`;
}

export class DesktopError extends Error {
  constructor(
    readonly code: string,
    english: string,
    readonly args: DesktopErrorArguments = {},
  ) {
    super(desktopErrorMessage(code, english, args));
    this.name = 'DesktopError';
  }
}

export function desktopErrorFacts(raw: string): DesktopErrorFacts | null {
  const text = raw.trim();
  const match = suffixPattern.exec(text);
  if (!match) return null;
  let args: DesktopErrorArguments = {};
  if (match[2] !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[2]);
    } catch {
      return null;
    }
    const bounded = boundedArguments(parsed);
    if (!bounded) return null;
    args = bounded;
  }
  return { code: match[1]!, args, english: text.slice(0, match.index).trim() };
}

function boundedArguments(value: unknown): Record<string, DesktopErrorArgument> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maximumArguments) return null;
  const result: Record<string, DesktopErrorArgument> = {};
  for (const [name, argument] of entries) {
    if (!argumentNamePattern.test(name)) return null;
    if (typeof argument === 'number') {
      if (!Number.isFinite(argument)) return null;
      result[name] = argument;
    } else if (typeof argument === 'string') {
      result[name] = argument.slice(0, maximumArgumentText);
    } else {
      return null;
    }
  }
  return result;
}
