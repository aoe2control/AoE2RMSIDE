import type { PreviewGenerationResult } from './api';

export type PreviewBreakpointEdge = 'before' | 'after';

export interface PreviewBreakpoint {
  id: number;
  sourceId: string;
  byteStart: number;
  byteEnd: number;
  edge: PreviewBreakpointEdge;
}

export type PreviewBreakpointAction = 'continue' | 'step';

export interface PreviewBreakpointStop {
  executionId: string;
  stopSequence: number;
  breakpointIds: number[];
  stage: string;
  edge: PreviewBreakpointEdge;
  operationIndices: number[];
  map: PreviewGenerationResult | null;
}

export const maximumPreviewBreakpoints = 1024;

export function isPreviewBreakpointList(value: unknown): value is PreviewBreakpoint[] {
  if (!Array.isArray(value) || value.length > maximumPreviewBreakpoints) return false;
  const ids = new Set<number>();
  return value.every((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return false;
    const breakpoint = entry as Partial<PreviewBreakpoint>;
    const valid =
      Number.isInteger(breakpoint.id) &&
      breakpoint.id! >= 0 &&
      breakpoint.id! <= 0xffff_ffff &&
      !ids.has(breakpoint.id!) &&
      typeof breakpoint.sourceId === 'string' &&
      breakpoint.sourceId.length >= 1 &&
      breakpoint.sourceId.length <= 4096 &&
      Number.isInteger(breakpoint.byteStart) &&
      Number.isInteger(breakpoint.byteEnd) &&
      breakpoint.byteStart! >= 0 &&
      breakpoint.byteStart! <= breakpoint.byteEnd! &&
      breakpoint.byteEnd! <= 0xffff_ffff &&
      (breakpoint.edge === 'before' || breakpoint.edge === 'after');
    if (valid) ids.add(breakpoint.id!);
    return valid;
  });
}

export function isPreviewBreakpointAction(value: unknown): value is PreviewBreakpointAction {
  return value === 'continue' || value === 'step';
}
