import type { Plugin, Rolldown } from 'vite';

type OutputBundle = Rolldown.OutputBundle;
type OutputChunk = Rolldown.OutputChunk;

export function rendererHeadPlugin(appModuleSuffix: string): Plugin {
  return {
    name: 'rmside-renderer-head',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (!context.bundle || !context.chunk) return html;
        return listDynamicAppInHead(html, context.bundle, context.chunk, appModuleSuffix);
      },
    },
  };
}

export function listDynamicAppInHead(
  html: string,
  bundle: OutputBundle,
  entry: OutputChunk,
  appModuleSuffix: string,
): string {
  const isApp = (chunk: OutputChunk) =>
    chunk.facadeModuleId?.replaceAll('\\', '/').endsWith(appModuleSuffix) === true;
  const app = entry.dynamicImports
    .map((file) => bundle[file])
    .find((output): output is OutputChunk => output?.type === 'chunk' && isApp(output));
  if (!app) throw new Error(`the renderer entry does not import ${appModuleSuffix} dynamically`);
  const listed = new Set([...html.matchAll(/<link\s[^>]*href="\.\/([^"]+)"/gu)].map((m) => m[1]));
  const firstStylesheet = html.search(/<link\s+rel="stylesheet"/u);
  if (firstStylesheet < 0) throw new Error('the renderer page lists no stylesheet');

  const chunks: OutputChunk[] = [];
  const stylesheets: string[] = [];
  const seen = new Set<string>();
  const visit = (chunk: OutputChunk) => {
    if (seen.has(chunk.fileName)) return;
    seen.add(chunk.fileName);
    for (const file of chunk.imports) {
      const imported = bundle[file];
      if (imported?.type === 'chunk') visit(imported);
    }
    chunks.push(chunk);
    for (const stylesheet of chunk.viteMetadata?.importedCss ?? []) stylesheets.push(stylesheet);
  };
  visit(app);

  const preloads = chunks
    .map((chunk) => chunk.fileName)
    .filter((file) => !listed.has(file))
    .map((file) => `<link rel="modulepreload" crossorigin href="./${file}">\n    `);
  const links = [...new Set(stylesheets)]
    .filter((file) => !listed.has(file))
    .map((file) => `<link rel="stylesheet" crossorigin href="./${file}">\n    `);
  return `${html.slice(0, firstStylesheet)}${preloads.join('')}${links.join('')}${html.slice(firstStylesheet)}`;
}
