import type { Container, DestroyOptions } from 'pixi.js';

export const pixiTreeDestroyOptions: DestroyOptions = { children: true, context: true };

interface RenderGroupNode {
  readonly renderGroup?: {
    readonly root: unknown;
    readonly instructionSet: { readonly uid: number } | null;
  } | null;
  readonly children?: readonly RenderGroupNode[];
}

interface BatchPipeBatchers {
  _batchersByInstructionSet?: Record<number, Record<string, { destroy(): void }> | undefined>;
}

const trackedBatchPipes = new Set<BatchPipeBatchers>();

export function trackRenderGroupBatchers(renderer: {
  readonly renderPipes: { readonly batch: unknown };
}): () => void {
  const pipe = renderer.renderPipes.batch as BatchPipeBatchers;
  trackedBatchPipes.add(pipe);
  return () => {
    trackedBatchPipes.delete(pipe);
  };
}

function renderGroupInstructionSets(node: RenderGroupNode, found: number[] = []): number[] {
  const group = node.renderGroup;
  if (group && group.root === node && group.instructionSet) found.push(group.instructionSet.uid);
  for (const child of node.children ?? []) renderGroupInstructionSets(child, found);
  return found;
}

function releaseBatchers(instructionSets: readonly number[]): void {
  for (const pipe of trackedBatchPipes) {
    const batchers = pipe._batchersByInstructionSet;
    if (!batchers) continue;
    for (const uid of instructionSets) {
      const set = batchers[uid];
      if (!set) continue;
      for (const name of Object.keys(set)) set[name]!.destroy();
      delete batchers[uid];
    }
  }
}

export function destroyPixiTree(node: Pick<Container, 'destroy'>): void {
  const instructionSets =
    trackedBatchPipes.size > 0 ? renderGroupInstructionSets(node as RenderGroupNode) : [];
  node.destroy(pixiTreeDestroyOptions);
  if (instructionSets.length > 0) releaseBatchers(instructionSets);
}
