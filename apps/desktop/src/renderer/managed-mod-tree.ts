export function formatManagedModTree(
  rootName: string,
  paths: readonly string[],
  annotations: ReadonlyMap<string, string> = new Map(),
): string {
  const root: TreeNode = { children: new Map() };
  const annotationByPath = new Map(
    [...annotations].map(([path, annotation]) => [treePathKey(path), annotation] as const),
  );
  for (const path of paths) {
    const parts = path.split(/[\\/]/u).filter(Boolean);
    let parent = root;
    for (const part of parts) {
      let child = parent.children.get(part);
      if (!child) {
        child = { children: new Map() };
        parent.children.set(part, child);
      }
      parent = child;
    }
    const annotation = annotationByPath.get(parts.join('/'));
    if (annotation && parent !== root) parent.annotation = annotation;
  }

  const lines = [`${rootName || 'MyRMSMod'}/`];
  appendChildren(lines, root, '');
  return lines.join('\n');
}

interface TreeNode {
  children: Map<string, TreeNode>;
  annotation?: string;
}

function treePathKey(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).join('/');
}

function appendChildren(lines: string[], parent: TreeNode, prefix: string): void {
  const children = [...parent.children.entries()].sort(([leftName, left], [rightName, right]) => {
    const kindOrder = Number(left.children.size > 0) - Number(right.children.size > 0);
    return kindOrder || leftName.localeCompare(rightName, 'en-US');
  });
  children.forEach(([name, child], index) => {
    const last = index === children.length - 1;
    const directory = child.children.size > 0;
    const annotation = !directory && child.annotation ? `  (${child.annotation})` : '';
    lines.push(`${prefix}${last ? '└─' : '├─'} ${name}${directory ? '/' : ''}${annotation}`);
    if (directory) appendChildren(lines, child, `${prefix}${last ? '   ' : '│  '}`);
  });
}
