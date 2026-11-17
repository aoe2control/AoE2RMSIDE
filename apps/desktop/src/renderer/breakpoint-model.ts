import type { PreviewBreakpoint } from '../shared/breakpoints';

export interface BreakpointSite {
  line: number;
  endLine: number;
  ownsUntilLine: number;
  kind: 'command' | 'section' | 'branch';
}

export function parseBreakpointSites(value: unknown): BreakpointSite[] | null {
  if (!value || typeof value !== 'object') return null;
  const sites = (value as { sites?: unknown }).sites;
  if (!Array.isArray(sites) || sites.length > 1_000_000) return null;
  const parsed: BreakpointSite[] = [];
  for (const entry of sites) {
    const site = entry as Partial<BreakpointSite> | null;
    if (
      !site ||
      !Number.isInteger(site.line) ||
      !Number.isInteger(site.endLine) ||
      !Number.isInteger(site.ownsUntilLine) ||
      site.line! < 0 ||
      site.endLine! <= site.line! ||
      site.ownsUntilLine! < site.line! ||
      (site.kind !== 'command' && site.kind !== 'section' && site.kind !== 'branch')
    ) {
      return null;
    }
    parsed.push({
      line: site.line!,
      endLine: site.endLine!,
      ownsUntilLine: site.ownsUntilLine!,
      kind: site.kind,
    });
  }
  return parsed;
}

const kindPriority = { command: 0, section: 1, branch: 2 } as const;

export function sitesByLine(sites: readonly BreakpointSite[]): Map<number, BreakpointSite> {
  const byLine = new Map<number, BreakpointSite>();
  for (const site of sites) {
    const current = byLine.get(site.line);
    if (!current || kindPriority[site.kind] < kindPriority[current.kind]) {
      byLine.set(site.line, site);
    }
  }
  return byLine;
}

export function breakpointTargetLine(
  sites: readonly BreakpointSite[],
  line: number,
): number | null {
  const byLine = sitesByLine(sites);
  if (byLine.has(line)) return line;
  let owner: number | null = null;
  for (const site of sites) {
    if (site.line < line && line <= site.ownsUntilLine && (owner === null || site.line > owner)) {
      owner = site.line;
    }
  }
  return owner;
}

export function snapBreakpointLines(
  lines: readonly number[],
  sites: readonly BreakpointSite[],
): number[] {
  const snapped = new Set<number>();
  for (const line of lines) {
    const target = breakpointTargetLine(sites, line);
    if (target !== null) snapped.add(target);
  }
  return [...snapped].sort((left, right) => left - right);
}

export function breakpointRequestRanges(
  lines: readonly number[],
  sites: readonly BreakpointSite[],
  lineByteStarts: readonly number[],
  sourceId: string,
  firstId: number,
): { breakpoints: PreviewBreakpoint[]; lineOfId: Map<number, number> } {
  const byLine = sitesByLine(sites);
  const textEnd = lineByteStarts.at(-1) ?? 0;
  const byteAt = (line: number) =>
    lineByteStarts[Math.min(line, lineByteStarts.length - 1)] ?? textEnd;
  const breakpoints: PreviewBreakpoint[] = [];
  const lineOfId = new Map<number, number>();
  for (const line of lines) {
    const site = byLine.get(line);
    if (!site || line >= lineByteStarts.length - 1) continue;
    const id = firstId + breakpoints.length;
    breakpoints.push({
      id,
      sourceId,
      byteStart: byteAt(site.line),
      byteEnd: Math.max(byteAt(site.line), byteAt(site.endLine)),
      edge: site.kind === 'command' ? 'after' : 'before',
    });
    lineOfId.set(id, line);
  }
  return { breakpoints, lineOfId };
}

export function utf8LineStarts(text: string): number[] {
  const starts = [0];
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0d && text.charCodeAt(index + 1) === 0x0a) {
      bytes += 2;
      index += 1;
      starts.push(bytes);
      continue;
    }
    if (code === 0x0a || code === 0x0d) {
      bytes += 1;
      starts.push(bytes);
      continue;
    }
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  starts.push(bytes);
  return starts;
}
