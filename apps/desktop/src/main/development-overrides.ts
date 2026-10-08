export interface DevelopmentOverrides {
  rmsdPath?: string;
  rmsLsPath?: string;
  rmsTestPath?: string;
  steamRoots?: string;
  userProfileRoot?: string;
  protectedSourceRoots?: string;
  windowDisplay?: string;
  pseudoLocale?: string;
  developmentFixtures: boolean;
  releaseCheckFixture?: string;
}

export const developmentOverrideVariables = [
  'RMSIDE_RMSD_PATH',
  'RMSIDE_RMS_LS_PATH',
  'RMSIDE_RMS_TEST_PATH',
  'RMSIDE_STEAM_ROOTS',
  'RMSIDE_USER_PROFILE_ROOT',
  'RMSIDE_PROTECTED_SOURCE_ROOTS',
  'RMSIDE_WINDOW_DISPLAY',
  'RMSIDE_PSEUDO_LOCALE',
  'RMSIDE_DEVELOPMENT_FIXTURES',
  'RMSIDE_RELEASE_CHECK_FIXTURE',
] as const;

export function readDevelopmentOverrides(
  isPackaged: boolean,
  environment: NodeJS.ProcessEnv,
): DevelopmentOverrides {
  if (isPackaged) return { developmentFixtures: false };
  const value = (name: (typeof developmentOverrideVariables)[number]) => environment[name];
  const overrides: DevelopmentOverrides = {
    developmentFixtures: environment.RMSIDE_DEVELOPMENT_FIXTURES === '1',
  };
  const assign = <Key extends Exclude<keyof DevelopmentOverrides, 'developmentFixtures'>>(
    key: Key,
    found: string | undefined,
  ) => {
    if (found !== undefined) overrides[key] = found;
  };
  assign('rmsdPath', value('RMSIDE_RMSD_PATH'));
  assign('rmsLsPath', value('RMSIDE_RMS_LS_PATH'));
  assign('rmsTestPath', value('RMSIDE_RMS_TEST_PATH'));
  assign('steamRoots', value('RMSIDE_STEAM_ROOTS'));
  assign('userProfileRoot', value('RMSIDE_USER_PROFILE_ROOT'));
  assign('protectedSourceRoots', value('RMSIDE_PROTECTED_SOURCE_ROOTS'));
  assign('windowDisplay', value('RMSIDE_WINDOW_DISPLAY'));
  assign('pseudoLocale', value('RMSIDE_PSEUDO_LOCALE'));
  assign('releaseCheckFixture', value('RMSIDE_RELEASE_CHECK_FIXTURE'));
  return overrides;
}
