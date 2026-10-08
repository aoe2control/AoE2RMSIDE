export const packageEditions = Object.freeze({
  full: Object.freeze({
    edition: 'full',
    displayName: 'AoE2RMSIDE',
    artifactStem: 'AoE2RMSIDE',
    natives: Object.freeze(['rmsd.exe', 'rms-ls.exe', 'rms-test.exe']),
    windowsRegistration: true,
    requiredPackedMarkers: Object.freeze(['rms-session-3', 'rmside-multiplayer-refusal-1']),
    requiredNativeMarkers: Object.freeze({ 'rmsd.exe': Object.freeze(['AoE2ControlRmsIdeV1']) }),
    forbiddenPackedMarkers: Object.freeze([]),
  }),
  'xs-preview': Object.freeze({
    edition: 'xs-preview',
    displayName: 'AoE2RMSIDE XS Editor Preview',
    artifactStem: 'AoE2RMSIDE-XS-Editor-Preview',
    natives: Object.freeze(['rms-ls.exe']),
    windowsRegistration: false,
    requiredPackedMarkers: Object.freeze([]),
    requiredNativeMarkers: Object.freeze({}),
    forbiddenPackedMarkers: Object.freeze([
      'PixiJS',
      'top-down-map-canvas',
      'data:image/webp;base64',
    ]),
  }),
  'rms-preview': Object.freeze({
    edition: 'rms-preview',
    displayName: 'AoE2RMSIDE RMS Editor Preview',
    artifactStem: 'AoE2RMSIDE-RMS-Editor-Preview',
    natives: Object.freeze(['rmsd.exe', 'rms-ls.exe']),
    windowsRegistration: false,
    requiredPackedMarkers: Object.freeze([]),
    requiredNativeMarkers: Object.freeze({}),
    forbiddenPackedMarkers: Object.freeze([
      'PixiJS',
      'top-down-map-canvas',
      'data:image/webp;base64',
    ]),
  }),
});

export function packageEdition(name = 'full') {
  const edition = Object.hasOwn(packageEditions, name) ? packageEditions[name] : undefined;
  if (!edition) throw new Error(`unsupported RMSIDE edition: ${String(name)}`);
  return edition;
}

export function nativeCargoPackages(edition) {
  return edition.natives.map((name) => name.replace(/\.exe$/u, ''));
}

export function allPackagedNatives() {
  return [...new Set(Object.values(packageEditions).flatMap((edition) => edition.natives))].sort();
}
