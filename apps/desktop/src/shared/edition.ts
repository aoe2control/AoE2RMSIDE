import { ipcChannels, type ExternalLinkTarget, type NativeProcessName } from './api';
import { t, type MessageId } from './i18n/translator';

export const editions = ['full', 'xs-preview', 'rms-preview'] as const;
export type Edition = (typeof editions)[number];

export interface EditionCapabilities {
  preview: boolean;
  generationEngine: boolean;
  sourceCatalog: boolean;
  mapTests: boolean;
  deployment: boolean;
  liveTests: boolean;
  mapIcons: boolean;
  gameTextures: boolean;
  executionProfiler: boolean;
  installedSourceBrowser: boolean;
  newRmsScript: boolean;
  issueTracker: boolean;
  documentation: boolean;
  windowsRegistration: boolean;
  releaseCheck: boolean;
  nativeProcesses: readonly NativeProcessName[];
}

const fullCapabilities: EditionCapabilities = Object.freeze({
  preview: true,
  generationEngine: true,
  sourceCatalog: true,
  mapTests: true,
  deployment: true,
  liveTests: true,
  mapIcons: true,
  gameTextures: true,
  executionProfiler: true,
  installedSourceBrowser: true,
  newRmsScript: true,
  issueTracker: true,
  documentation: true,
  windowsRegistration: true,
  releaseCheck: true,
  nativeProcesses: Object.freeze(['rmsd', 'rms-ls', 'rms-test', 'rms-test-lsp'] as const),
});

const xsPreviewCapabilities: EditionCapabilities = Object.freeze({
  preview: false,
  generationEngine: false,
  sourceCatalog: false,
  mapTests: false,
  deployment: false,
  liveTests: false,
  mapIcons: false,
  gameTextures: false,
  executionProfiler: false,
  installedSourceBrowser: false,
  newRmsScript: false,
  issueTracker: false,
  documentation: false,
  windowsRegistration: false,
  releaseCheck: false,
  nativeProcesses: Object.freeze(['rms-ls'] as const),
});

const rmsPreviewCapabilities: EditionCapabilities = Object.freeze({
  preview: false,
  generationEngine: false,
  sourceCatalog: true,
  mapTests: false,
  deployment: false,
  liveTests: false,
  mapIcons: false,
  gameTextures: false,
  executionProfiler: false,
  installedSourceBrowser: true,
  newRmsScript: true,
  issueTracker: false,
  documentation: false,
  windowsRegistration: false,
  releaseCheck: false,
  nativeProcesses: Object.freeze(['rmsd', 'rms-ls'] as const),
});

const editionCapabilityTable: Readonly<Record<Edition, EditionCapabilities>> = Object.freeze({
  full: fullCapabilities,
  'xs-preview': xsPreviewCapabilities,
  'rms-preview': rmsPreviewCapabilities,
});

export function parseEdition(value: unknown): Edition {
  if (value === undefined || value === null || value === '') return 'full';
  if (typeof value === 'string' && (editions as readonly string[]).includes(value)) {
    return value as Edition;
  }
  throw new Error(`unsupported RMSIDE edition: ${String(value)}`);
}

export function capabilitiesFor(edition: Edition): EditionCapabilities {
  return editionCapabilityTable[edition];
}

export const rmsdRequestKinds = [
  'handshakeRequest',
  'shutdownRequest',
  'configurationCatalogRequest',
  'presentationStringIdsRequest',
  'localContentImportRequest',
  'generationRequest',
  'cancellationRequest',
  'gameArtPrepareRequest',
  'gameArtSpritesRequest',
  'controlPipeExchangeRequest',
] as const;
export type RmsdRequestKind = (typeof rmsdRequestKinds)[number];

export function rmsdRequestAllowed(kind: string, capabilities: EditionCapabilities): boolean {
  if (!capabilities.nativeProcesses.includes('rmsd')) return false;
  switch (kind as RmsdRequestKind) {
    case 'handshakeRequest':
    case 'shutdownRequest':
      return true;
    case 'configurationCatalogRequest':
    case 'presentationStringIdsRequest':
    case 'localContentImportRequest':
      return capabilities.sourceCatalog || capabilities.generationEngine;
    case 'generationRequest':
      return capabilities.generationEngine;
    case 'cancellationRequest':
      return capabilities.generationEngine || capabilities.gameTextures || capabilities.liveTests;
    case 'gameArtPrepareRequest':
    case 'gameArtSpritesRequest':
      return capabilities.gameTextures;
    case 'controlPipeExchangeRequest':
      return capabilities.liveTests;
    default:
      return false;
  }
}

export interface ProductIdentity {
  edition: Edition;
  displayName: string;
  version: string;
  commit: string;
  userDataName: string | null;
}

const editionDisplayNames: Readonly<Record<Edition, string>> = Object.freeze({
  full: 'AoE2RMSIDE',
  'xs-preview': 'AoE2RMSIDE XS Editor Preview',
  'rms-preview': 'AoE2RMSIDE RMS Editor Preview',
});

const editionDescriptions: Readonly<Record<Exclude<Edition, 'full'>, MessageId>> = Object.freeze({
  'xs-preview': 'about.edition.xs-preview',
  'rms-preview': 'about.edition.rms-preview',
});

export const projectMaintainer = 'matkhl/BigJohn';

export const researchCredit = Object.freeze({
  author: 'Zetnus',
  guide: 'Definitive Random Map Scripting Guide',
});

export const xsResearchCredit = Object.freeze({
  author: 'Alian713',
  guide: 'AoE2DE UGC Guide',
});

export function productIdentityFor(
  edition: Edition,
  version: string,
  commit: string,
): ProductIdentity {
  const displayName = editionDisplayNames[edition];
  return {
    edition,
    displayName,
    version,
    commit,
    userDataName: edition === 'full' ? null : displayName,
  };
}

export function aboutDisclosureFor(
  capabilities: Pick<EditionCapabilities, 'preview' | 'gameTextures'>,
): readonly string[] {
  return [
    t(
      capabilities.preview
        ? 'about.disclosure.independent.preview'
        : 'about.disclosure.independent',
    ),
    ...(capabilities.preview ? [t('about.disclosure.verified-versions')] : []),
    t(
      capabilities.gameTextures
        ? 'about.disclosure.game-files.textures'
        : 'about.disclosure.game-files',
    ),
    t('about.disclosure.affiliation'),
  ];
}

export const aboutDisclosure: readonly string[] = Object.freeze(
  aboutDisclosureFor({ preview: true, gameTextures: true }),
);

export function aboutDialogText(identity: ProductIdentity): { message: string; detail: string } {
  const credits = [
    t('about.credits', { maintainer: projectMaintainer }),
    t('about.credits.research', researchCredit),
    t('about.credits.xs-research', xsResearchCredit),
  ].join('\n');
  const version = t('about.version', { version: identity.version, commit: identity.commit });
  const disclosure = aboutDisclosureFor(capabilitiesFor(identity.edition));
  return {
    message: identity.displayName,
    detail:
      identity.edition === 'full'
        ? [version, ...disclosure, credits].join('\n\n')
        : [version, t(editionDescriptions[identity.edition]), ...disclosure, credits].join('\n\n'),
  };
}

export function aboutDialogButtons(capabilities: Pick<EditionCapabilities, 'documentation'>): {
  buttons: string[];
  documentationButton: number | null;
} {
  return capabilities.documentation
    ? { buttons: [t('about.close'), t('about.documentation')], documentationButton: 1 }
    : { buttons: [t('about.close')], documentationButton: null };
}

type IpcChannelName = keyof typeof ipcChannels;

const featureChannels: Record<
  Exclude<
    keyof EditionCapabilities,
    'nativeProcesses' | 'newRmsScript' | 'issueTracker' | 'documentation' | 'windowsRegistration'
  >,
  readonly IpcChannelName[]
> = {
  preview: [
    'generatePreview',
    'cancelPreviewGeneration',
    'executionState',
    'executionStop',
    'developmentFixtures',
    'runDevelopmentFixture',
    'previewCandidateAcknowledge',
    'standardIncludeAccess',
  ],
  generationEngine: ['configurationCatalog'],
  sourceCatalog: ['localPresentationNames', 'definitionFilePrepare', 'definitionFileGenerate'],
  mapTests: [
    'mapTestRun',
    'mapTestReplay',
    'mapTestReportExport',
    'mapTestReportImport',
    'syncMapTestResultsVisibility',
    'syncMapTestPreviewShown',
  ],
  deployment: [
    'managedDeploymentPreview',
    'managedDeploymentApply',
    'manualDeploymentContext',
    'manualDeploymentPreview',
    'manualDeploymentApply',
    'manualDeploymentOpenFolder',
    'manualDeploymentOpenTargetFolder',
  ],
  liveTests: [
    'controlLauncherStatus',
    'controlLauncherSelect',
    'controlLauncherForget',
    'controlSessionStatus',
    'controlSessionConnect',
    'controlSessionDisconnect',
    'controlLiveSynchronize',
    'controlLiveCancel',
  ],
  mapIcons: [
    'manualDeploymentMapIconRead',
    'manualDeploymentMapIconSave',
    'mapIconGeneratedSave',
    'mapIconRenderInputGet',
    'mapIconRenderInputSet',
    'mapIconSourceGenerate',
    'mapIconSourceCancel',
  ],
  gameTextures: [
    'gameArtStatus',
    'gameArtPrepare',
    'gameArtCancel',
    'gameArtTerrain',
    'gameArtSprites',
    'gameArtImages',
  ],
  executionProfiler: [],
  installedSourceBrowser: [
    'installedSourcesDiscover',
    'installedSourcesOpen',
    'installedSourcesClone',
    'installedSourcesSelectProfile',
  ],
  releaseCheck: ['releaseNoticeTake'],
};

export function refusedIpcChannels(capabilities: EditionCapabilities): ReadonlySet<string> {
  const refused = new Set<string>();
  for (const [feature, channels] of Object.entries(featureChannels)) {
    if (capabilities[feature as keyof typeof featureChannels]) continue;
    for (const channel of channels) refused.add(ipcChannels[channel]);
  }
  return refused;
}

export function definitionFilesAvailable(
  capabilities: Pick<EditionCapabilities, 'newRmsScript' | 'sourceCatalog'>,
): boolean {
  return capabilities.newRmsScript && capabilities.sourceCatalog;
}

export function externalLinkAllowed(
  target: ExternalLinkTarget,
  capabilities: EditionCapabilities,
): boolean {
  if (target === 'control-releases') return capabilities.liveTests;
  if (target === 'rmside-issues') return capabilities.issueTracker;
  if (target === 'rmside-documentation') return capabilities.documentation;
  if (target === 'rmside-releases') return capabilities.releaseCheck;
  return true;
}

const previewDiagnosticCodes: ReadonlySet<string> = new Set(['RMSXS0001', 'RMSGEN1009']);

export function editionLanguageNotificationParams(
  method: string,
  params: unknown,
  capabilities: Pick<EditionCapabilities, 'preview'>,
): unknown {
  if (capabilities.preview || method !== 'textDocument/publishDiagnostics') return params;
  const diagnostics = (params as { diagnostics?: unknown } | null)?.diagnostics;
  if (!Array.isArray(diagnostics)) return params;
  const kept = diagnostics.filter(
    (diagnostic) =>
      !previewDiagnosticCodes.has(String((diagnostic as { code?: unknown } | null)?.code)),
  );
  return kept.length === diagnostics.length ? params : { ...(params as object), diagnostics: kept };
}

export function nativeProcessAllowed(
  name: NativeProcessName,
  capabilities: EditionCapabilities,
): boolean {
  return capabilities.nativeProcesses.includes(name);
}

declare const __RMSIDE_EDITION__: string | undefined;
declare const __RMSIDE_VERSION__: string | undefined;
declare const __RMSIDE_COMMIT__: string | undefined;

export const buildEdition: Edition = parseEdition(
  typeof __RMSIDE_EDITION__ === 'undefined' ? undefined : __RMSIDE_EDITION__,
);

export const editionCapabilities: EditionCapabilities = capabilitiesFor(buildEdition);

export const productIdentity: ProductIdentity = productIdentityFor(
  buildEdition,
  typeof __RMSIDE_VERSION__ === 'undefined' ? '0.0.0-development' : __RMSIDE_VERSION__,
  typeof __RMSIDE_COMMIT__ === 'undefined' ? 'unknown' : __RMSIDE_COMMIT__,
);
