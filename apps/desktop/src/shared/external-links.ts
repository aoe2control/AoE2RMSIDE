export const externalLinkTargets = [
  'control-releases',
  'discord',
  'rmside-issues',
  'rmside-documentation',
  'rmside-releases',
] as const;

export type ExternalLinkTarget = (typeof externalLinkTargets)[number];

export const externalLinkUrls: Readonly<Record<ExternalLinkTarget, string>> = Object.freeze({
  'control-releases': 'https://github.com/aoe2control/AoE2Control/releases',
  discord: 'https://discord.gg/CpVxzRfvm7',
  'rmside-issues': 'https://github.com/aoe2control/AoE2RMSIDE/issues',
  'rmside-documentation': 'https://aoe2control.github.io/aoe2rmside/',
  'rmside-releases': 'https://github.com/aoe2control/AoE2RMSIDE/releases',
});

export type DocumentationPage = 'map-tests';

const documentationPagePaths: Readonly<Record<DocumentationPage, string>> = Object.freeze({
  'map-tests': 'map-tests/',
});

export function documentationPageUrl(page: DocumentationPage): string {
  return `${externalLinkUrls['rmside-documentation']}${documentationPagePaths[page]}`;
}

export function isExternalLinkTarget(value: unknown): value is ExternalLinkTarget {
  return typeof value === 'string' && (externalLinkTargets as readonly string[]).includes(value);
}
