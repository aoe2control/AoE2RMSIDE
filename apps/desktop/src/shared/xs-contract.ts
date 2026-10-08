import { editionCapabilities, type EditionCapabilities } from './edition';

export const xsScriptExtension = '.xs' as const;

export const xsFormatterConvention = 1;

export function xsStarterTemplateFor(capabilities: Pick<EditionCapabilities, 'preview'>): string {
  const loading = capabilities.preview
    ? '// and the file is deployed with the map (resources/_common/xs).'
    : '// and the game reads the file from resources/_common/xs.';
  const effects = capabilities.preview
    ? '// terrain or elevation. The preview does not run XS.'
    : '// terrain or elevation.';
  return `// XS script for a random map. A map loads it with a line such as
//     #includeXS my_script.xs
${loading}
//
// The game runs main() once when the match starts, after the map has been
// generated: XS can change players, objects, and game data, but never the
${effects}

void main() {
    xsChatData("XS script loaded.");
}
`;
}

export const xsStarterTemplate = xsStarterTemplateFor(editionCapabilities);

export function isXsScriptName(name: string): boolean {
  return /\.xs$/iu.test(name);
}

export type SourceLanguageId = 'rms' | 'starlark' | 'xs';

export function sourceLanguageIdForName(name: string): SourceLanguageId {
  if (/\.rmstest$/iu.test(name)) return 'starlark';
  if (isXsScriptName(name)) return 'xs';
  return 'rms';
}
