import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { allPackagedNatives, packageEdition } from './package-editions.mjs';
import {
  innoRegistrationCleanupProcedure,
  innoRegistrySection,
  installationMarkerText,
  windowsRegistration,
} from './windows-registration.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = resolve(repositoryRoot, 'apps/desktop');

export const pinnedInnoSetupVersion = '6.7.3';
export const uninstallDisplayName = 'AoE2RMSIDE';
export const buildMetadataSchema = 'https://rmside.invalid/schemas/build-metadata/v1';
const executableName = windowsRegistration.executableName;

export function locateInnoCompiler({ env = process.env, exists = existsSync } = {}) {
  const override = env.RMSIDE_ISCC?.trim();
  if (override) {
    if (!isAbsolute(override) || !exists(override)) {
      throw new Error(`RMSIDE_ISCC names ${override}, which is not an existing absolute path`);
    }
    return override;
  }
  const candidates = [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Inno Setup 6', 'ISCC.exe'),
    env.ProgramFiles && join(env.ProgramFiles, 'Inno Setup 6', 'ISCC.exe'),
  ].filter(Boolean);
  const found = candidates.find((candidate) => exists(candidate));
  if (found) return found;
  throw new Error(
    [
      `The installer needs the Inno Setup ${pinnedInnoSetupVersion} compiler (ISCC.exe), which was not found.`,
      `Install it with: winget install --id JRSoftware.InnoSetup --version ${pinnedInnoSetupVersion} --scope user`,
      'or set RMSIDE_ISCC to the full path of ISCC.exe.',
      `Searched: ${candidates.join(', ') || '(no Windows program folders in the environment)'}`,
    ].join('\n'),
  );
}

export function innoCompilerVersion(output) {
  return /Compiler engine version: Inno Setup (\d+\.\d+\.\d+)/u.exec(output)?.[1] ?? null;
}

const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/u;

export function numericFileVersion(version) {
  const match = versionPattern.exec(version);
  if (!match) throw new Error(`invalid product version ${version}`);
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}.0`;
}

export function installerStem(edition, version) {
  return `${edition.artifactStem}-${version}-win32-x64-setup`;
}

function plainText(text, label) {
  if (typeof text !== 'string' || text.length === 0 || /["{}\r\n]/u.test(text)) {
    throw new Error(`${label} cannot be written into the installer script: ${String(text)}`);
  }
  return text;
}

function pascal(text) {
  if (/[\r\n]/u.test(text)) throw new Error(`a script string contains a line break: ${text}`);
  return `'${text.replaceAll("'", "''")}'`;
}

export const versionComparisonCode = Object.freeze([
  'function IsDigits(const Text: String): Boolean;',
  'var',
  '  Index: Integer;',
  'begin',
  '  Result := Length(Text) > 0;',
  '  for Index := 1 to Length(Text) do',
  "    if (Text[Index] < '0') or (Text[Index] > '9') then Result := False;",
  'end;',
  '',
  'function TakePart(var Text: String; const Separator: String): String;',
  'var',
  '  Position: Integer;',
  'begin',
  '  Position := Pos(Separator, Text);',
  '  if Position = 0 then',
  '  begin',
  '    Result := Text;',
  "    Text := '';",
  '  end',
  '  else',
  '  begin',
  '    Result := Copy(Text, 1, Position - 1);',
  '    Text := Copy(Text, Position + Length(Separator), Length(Text));',
  '  end;',
  'end;',
  '',
  'function Sign(Value: Int64): Integer;',
  'begin',
  '  if Value < 0 then Result := -1',
  '  else if Value > 0 then Result := 1',
  '  else Result := 0;',
  'end;',
  '',
  '{ Semantic version identifiers: numbers compare numerically and sort before words. }',
  'function CompareIdentifiers(const Left, Right: String): Integer;',
  'begin',
  '  if IsDigits(Left) and IsDigits(Right) then',
  '    Result := Sign(StrToInt64Def(Left, 0) - StrToInt64Def(Right, 0))',
  '  else if IsDigits(Left) then Result := -1',
  '  else if IsDigits(Right) then Result := 1',
  '  else Result := Sign(CompareStr(Left, Right));',
  'end;',
  '',
  '{ Compares two semantic versions (major.minor.patch with an optional pre-release).',
  '  A variable passed to TakePart is never assigned its result: Pascal Script',
  '  writes the var parameter back after the assignment. }',
  'function CompareVersions(const LeftVersion, RightVersion: String): Integer;',
  'var',
  '  LeftRest, RightRest, LeftCore, RightCore, LeftPre, RightPre: String;',
  '  Part: Integer;',
  'begin',
  '  LeftRest := LeftVersion;',
  "  LeftPre := TakePart(LeftRest, '+');",
  "  LeftCore := TakePart(LeftPre, '-');",
  '  RightRest := RightVersion;',
  "  RightPre := TakePart(RightRest, '+');",
  "  RightCore := TakePart(RightPre, '-');",
  '  Result := 0;',
  '  for Part := 1 to 3 do',
  "    if Result = 0 then Result := CompareIdentifiers(TakePart(LeftCore, '.'), TakePart(RightCore, '.'));",
  '  if Result <> 0 then Exit;',
  "  if (LeftPre = '') and (RightPre = '') then Exit;",
  "  if LeftPre = '' then begin Result := 1; Exit; end;",
  "  if RightPre = '' then begin Result := -1; Exit; end;",
  "  while (Result = 0) and ((LeftPre <> '') or (RightPre <> '')) do",
  '  begin',
  "    if LeftPre = '' then Result := -1",
  "    else if RightPre = '' then Result := 1",
  "    else Result := CompareIdentifiers(TakePart(LeftPre, '.'), TakePart(RightPre, '.'));",
  '  end;',
  'end;',
]);

function markerWriterLines() {
  const sentinel = '\u0000directory\u0000';
  const lines = installationMarkerText(sentinel).split('\r\n');
  if (lines.at(-1) !== '') throw new Error('the installation marker must end with a line break');
  lines.pop();
  const assignments = lines.map((line, index) => {
    if (!line.includes(sentinel)) return `  Lines[${index}] := ${pascal(line)};`;
    const [before, after] = line.split(sentinel);
    if (after !== '') throw new Error('the installation folder must end its marker line');
    return `  Lines[${index}] := ${pascal(before)} + ExpandConstant('{app}');`;
  });
  return [
    'procedure WriteInstallationMarker;',
    'var',
    '  Lines: TArrayOfString;',
    'begin',
    `  SetArrayLength(Lines, ${lines.length});`,
    ...assignments,
    `  if not SaveStringsToUTF8FileWithoutBOM(ExpandConstant(${pascal(`{app}\\${windowsRegistration.installationMarker.relativePath}`)}), Lines, False) then`,
    "    SuppressibleMsgBox('Setup could not write the installation marker. AoE2RMSIDE will run as a portable copy until it is installed again.', mbError, MB_OK, IDOK);",
    'end;',
  ];
}

export function innoSetupScript({
  edition,
  metadata,
  packageRoot,
  outputDirectory,
  outputBaseFilename,
}) {
  if (metadata?.$schema !== buildMetadataSchema || metadata.product !== 'AoE2RMSIDE') {
    throw new Error('the package carries no AoE2RMSIDE build metadata');
  }
  if (metadata.edition !== edition.edition || metadata.displayName !== edition.displayName) {
    throw new Error(
      `the package is the ${String(metadata.edition)} edition, not ${edition.edition}`,
    );
  }
  const version = plainText(metadata.version, 'the version');
  const fileVersion = numericFileVersion(version);
  const displayName = plainText(edition.displayName, 'the display name');
  if (!/^[A-Za-z0-9 ]+$/u.test(displayName)) throw new Error(`unsupported name ${displayName}`);
  for (const [label, path] of [
    ['the package folder', packageRoot],
    ['the output folder', outputDirectory],
  ]) {
    if (!isAbsolute(path)) throw new Error(`${label} must be absolute: ${path}`);
    plainText(path, label);
  }
  plainText(outputBaseFilename, 'the output file name');
  const appId = windowsRegistration.appId;
  if (!/^\{[0-9A-F-]{36}\}$/u.test(appId)) throw new Error(`invalid AppId ${appId}`);
  const uninstallKey = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appId}_is1`;
  const registers = edition.windowsRegistration === true;
  const natives = allPackagedNatives();
  const extensions = windowsRegistration.associatedExtensions.join(' and ');
  const folderLabel = windowsRegistration.folderVerbLabel;
  const markerPath = `{app}\\${windowsRegistration.installationMarker.relativePath}`;

  const setup = [
    '[Setup]',
    `AppId={${appId}`,
    `AppName=${displayName}`,
    `AppVersion=${version}`,
    `AppVerName=${displayName} ${version}`,
    `AppComments=${displayName} ${version}`,
    `UninstallDisplayName=${uninstallDisplayName}`,
    `UninstallDisplayIcon={app}\\${executableName}`,
    `DefaultDirName=${windowsRegistration.defaultInstallDirectory}`,
    'DisableDirPage=auto',
    'DisableProgramGroupPage=yes',
    'UsePreviousAppDir=yes',
    'UsePreviousTasks=yes',
    'PrivilegesRequired=lowest',
    'ArchitecturesAllowed=x64compatible',
    'ArchitecturesInstallIn64BitMode=x64compatible',
    'MinVersion=10.0',
    'ChangesAssociations=yes',
    'CloseApplications=force',
    'CloseApplicationsFilter=*.exe,*.dll,*.chm',
    `CloseApplicationsFilterExcludes=${natives.join(',')}`,
    'RestartApplications=no',
    'AllowCancelDuringInstall=no',
    'SetupMutex=AoE2RMSIDE.Setup',
    'WizardStyle=modern',
    `SetupIconFile=${packageRoot}\\resources\\aoe2rmside-icon.ico`,
    'Compression=lzma2/max',
    'SolidCompression=yes',
    `OutputDir=${outputDirectory}`,
    `OutputBaseFilename=${outputBaseFilename}`,
    `VersionInfoVersion=${fileVersion}`,
    `VersionInfoProductVersion=${fileVersion}`,
    `VersionInfoTextVersion=${version}`,
    `VersionInfoProductTextVersion=${version}`,
    `VersionInfoProductName=${displayName}`,
    `VersionInfoDescription=${displayName} Setup`,
  ];

  const sections = [
    '[Languages]',
    'Name: "english"; MessagesFile: "compiler:Default.isl"',
    '',
    '[Tasks]',
    'Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked',
    '',
    '[Dirs]',
    'Name: "{app}"; BeforeInstall: ReplaceInstalledBuild',
    '',
    '[Files]',
    `Source: "${packageRoot}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs`,
    '',
    '[Icons]',
    `Name: "{userprograms}\\${displayName}"; Filename: "{app}\\${executableName}"; WorkingDir: "{app}"`,
    `Name: "{userdesktop}\\${displayName}"; Filename: "{app}\\${executableName}"; WorkingDir: "{app}"; Tasks: desktopicon`,
    '',
    '[UninstallDelete]',
    `Type: files; Name: "${markerPath}"`,
    'Type: dirifempty; Name: "{app}\\resources"',
    'Type: dirifempty; Name: "{app}"',
    '',
    '[Run]',
    `Filename: "{app}\\${executableName}"; Description: "{cm:LaunchProgram,${displayName}}"; Flags: nowait postinstall skipifsilent`,
    '',
  ];

  const code = [
    '[Code]',
    'const',
    `  UninstallKey = ${pascal(uninstallKey)};`,
    `  NewDisplayName = ${pascal(displayName)};`,
    `  NewVersion = ${pascal(version)};`,
    `  NewEdition = ${pascal(edition.edition)};`,
    `  ProgIdKey = ${pascal(`Software\\Classes\\${windowsRegistration.progId}`)};`,
    '  GENERIC_WRITE = $40000000;',
    '  OPEN_EXISTING = 3;',
    '',
    'var',
    '  PreviousUninstaller: String;',
    '  PreviousDirectory: String;',
    '  PreviousVersion: String;',
    '  PreviousDisplayName: String;',
    '  PreviousEdition: String;',
    '  PreviousRegistered: Boolean;',
    '  ReplaceNotice: String;',
    '  ReplacePage: TOutputMsgWizardPage;',
    '  Replaced: Boolean;',
    '',
    'function CreateFile(lpFileName: String; dwDesiredAccess, dwShareMode, lpSecurityAttributes, dwCreationDisposition, dwFlagsAndAttributes: Cardinal; hTemplateFile: THandle): THandle;',
    "  external 'CreateFileW@kernel32.dll stdcall';",
    'function CloseHandle(hObject: THandle): Boolean;',
    "  external 'CloseHandle@kernel32.dll stdcall';",
    '',
    'function NewEditionRegisters: Boolean;',
    'begin',
    `  Result := ${registers ? 'True' : 'False'};`,
    'end;',
    '',
    ...innoRegistrationCleanupProcedure().trimEnd().split('\r\n'),
    '',
    ...markerWriterLines(),
    '',
    '{ True while a running program holds the file (an executable that runs cannot be opened for writing). }',
    'function FileInUse(const Path: String): Boolean;',
    'var',
    '  Handle: THandle;',
    'begin',
    '  Result := False;',
    '  if not FileExists(Path) then Exit;',
    '  Handle := CreateFile(Path, GENERIC_WRITE, 0, 0, OPEN_EXISTING, 0, 0);',
    '  if Handle = THandle(-1) then',
    '    Result := True',
    '  else',
    '    CloseHandle(Handle);',
    'end;',
    '',
    '{ The first AoE2RMSIDE program file in Directory that is still running, or an empty string. }',
    'function RunningProgram(const Directory: String): String;',
    'begin',
    "  Result := '';",
    `  if FileInUse(Directory + ${pascal(`\\${executableName}`)}) then Result := ${pascal(executableName)}`,
    ...natives.map(
      (name) =>
        `  else if FileInUse(Directory + ${pascal(`\\resources\\native\\${name}`)}) then Result := ${pascal(name)}`,
    ),
    '  ;',
    'end;',
    '',
    'function WaitUntilClosed(const Directory: String; Seconds: Integer): String;',
    'var',
    '  Attempt: Integer;',
    'begin',
    '  Result := RunningProgram(Directory);',
    '  Attempt := 0;',
    "  while (Result <> '') and (Attempt < Seconds * 4) do",
    '  begin',
    '    Sleep(250);',
    '    Attempt := Attempt + 1;',
    '    Result := RunningProgram(Directory);',
    '  end;',
    'end;',
    '',
    ...versionComparisonCode,
    '',
    '{ A string field of the build metadata the installed copy carries (resources\\rmside-build.json). }',
    'function BuildField(const Text, Name: String): String;',
    'var',
    '  Marker: String;',
    '  Position: Integer;',
    'begin',
    "  Result := '';",
    "  Marker := '\"' + Name + '\": \"';",
    '  Position := Pos(Marker, Text);',
    '  if Position = 0 then Exit;',
    '  Result := Copy(Text, Position + Length(Marker), Length(Text));',
    "  Position := Pos('\"', Result);",
    "  if Position = 0 then Result := '' else Result := Copy(Result, 1, Position - 1);",
    'end;',
    '',
    'procedure DetectPreviousInstallation;',
    'var',
    '  Metadata: AnsiString;',
    '  Order: Integer;',
    'begin',
    "  PreviousDirectory := '';",
    "  PreviousUninstaller := '';",
    "  if not RegQueryStringValue(HKCU, UninstallKey, 'Inno Setup: App Path', PreviousDirectory) then Exit;",
    "  RegQueryStringValue(HKCU, UninstallKey, 'UninstallString', PreviousUninstaller);",
    '  PreviousUninstaller := RemoveQuotes(PreviousUninstaller);',
    "  RegQueryStringValue(HKCU, UninstallKey, 'DisplayVersion', PreviousVersion);",
    "  PreviousDisplayName := 'AoE2RMSIDE';",
    "  PreviousEdition := '';",
    "  if LoadStringFromFile(PreviousDirectory + '\\resources\\rmside-build.json', Metadata) then",
    '  begin',
    "    PreviousEdition := BuildField(String(Metadata), 'edition');",
    "    if BuildField(String(Metadata), 'displayName') <> '' then",
    "      PreviousDisplayName := BuildField(String(Metadata), 'displayName');",
    '  end;',
    '  PreviousRegistered := RegKeyExists(HKCU, ProgIdKey);',
    '',
    "  ReplaceNotice := PreviousDisplayName + ' ' + PreviousVersion + ' is installed in ' + PreviousDirectory + '.' + #13#10#13#10 +",
    "    'Setup replaces it with ' + NewDisplayName + ' ' + NewVersion + '.';",
    '  Order := CompareVersions(NewVersion, PreviousVersion);',
    "  if (PreviousEdition <> '') and (PreviousEdition <> NewEdition) then",
    "    ReplaceNotice := ReplaceNotice + ' This changes the installed edition.';",
    "  if Order > 0 then ReplaceNotice := ReplaceNotice + ' This is a newer version.'",
    "  else if Order < 0 then ReplaceNotice := ReplaceNotice + ' This is an older version than the installed one.'",
    "  else if PreviousEdition = NewEdition then ReplaceNotice := ReplaceNotice + ' This is the same version; Setup installs it again.';",
    '  if NewEditionRegisters and not PreviousRegistered then',
    `    ReplaceNotice := ReplaceNotice + #13#10#13#10 + ${pascal(`Setup adds AoE2RMSIDE as an Open with choice for ${extensions} files and adds ${folderLabel} to File Explorer.`)}`,
    '  else if PreviousRegistered and not NewEditionRegisters then',
    `    ReplaceNotice := ReplaceNotice + #13#10#13#10 + ${pascal(`This edition has no Windows file associations: Setup removes AoE2RMSIDE from Open with for ${extensions} files and removes ${folderLabel} from File Explorer.`)};`,
    "  ReplaceNotice := ReplaceNotice + #13#10#13#10 + 'Only one AoE2RMSIDE build can be installed at a time. Your scripts and folders, and the settings of every edition, are kept.';",
    "  Log('AoE2RMSIDE replace: ' + ReplaceNotice);",
    'end;',
    '',
    'function InitializeSetup: Boolean;',
    'begin',
    '  DetectPreviousInstallation;',
    '  Result := True;',
    'end;',
    '',
    'procedure InitializeWizard;',
    'begin',
    "  if PreviousDirectory <> '' then",
    "    ReplacePage := CreateOutputMsgPage(wpWelcome, 'Replace the installed AoE2RMSIDE', 'Only one AoE2RMSIDE build can be installed at a time.', ReplaceNotice);",
    'end;',
    '',
    'function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;',
    'begin',
    "  Result := '';",
    "  if PreviousDirectory <> '' then",
    "    Result := 'Replaces the installed build:' + NewLine + Space + PreviousDisplayName + ' ' + PreviousVersion + NewLine + NewLine;",
    '  Result := Result + MemoDirInfo;',
    "  if MemoTasksInfo <> '' then Result := Result + NewLine + NewLine + MemoTasksInfo;",
    'end;',
    '',
    'procedure WaitUntilRemoved(const Path: String);',
    'var',
    '  Attempt: Integer;',
    'begin',
    '  Attempt := 0;',
    '  while FileExists(Path) and (Attempt < 120) do',
    '  begin',
    '    Sleep(250);',
    '    Attempt := Attempt + 1;',
    '  end;',
    'end;',
    '',
    'procedure RemovePreviousInstallation;',
    'var',
    '  Busy: String;',
    '  ResultCode: Integer;',
    'begin',
    "  if PreviousDirectory = '' then Exit;",
    '  Busy := WaitUntilClosed(PreviousDirectory, 15);',
    "  if Busy <> '' then",
    '  begin',
    "    Log('AoE2RMSIDE replace: still running: ' + Busy);",
    "    RaiseException('AoE2RMSIDE is still running (' + Busy + '). Close it, then run Setup again.');",
    '  end;',
    "  if (PreviousUninstaller = '') or not FileExists(PreviousUninstaller) then",
    '  begin',
    "    Log('AoE2RMSIDE replace: the installed copy has no uninstaller; installing over it');",
    '    Exit;',
    '  end;',
    "  Log('AoE2RMSIDE replace: running ' + PreviousUninstaller);",
    "  if not Exec(PreviousUninstaller, '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then",
    '  begin',
    "    Log('AoE2RMSIDE replace: the uninstaller failed with ' + IntToStr(ResultCode));",
    "    RaiseException('Setup could not remove the installed ' + PreviousDisplayName + '. Close it, or uninstall it from Windows Settings, then run Setup again.');",
    '  end;',
    '  { The uninstaller finishes in a copy of itself, which deletes the original last. }',
    '  WaitUntilRemoved(PreviousUninstaller);',
    "  Log('AoE2RMSIDE replace: removed the installed copy');",
    'end;',
    '',
    '{ Runs once, before anything is copied: Setup calls it for the install folder',
    '  entry of [Dirs], after the Restart Manager closed a running copy and before',
    '  it decides where the uninstall log goes. (CurStepChanged(ssInstall) comes',
    '  before the Restart Manager closes anything.) }',
    'procedure ReplaceInstalledBuild;',
    'begin',
    '  if Replaced then Exit;',
    '  Replaced := True;',
    '  RemovePreviousInstallation;',
    '  RemoveAoE2RmsIdeRegistration;',
    "  ForceDirectories(ExpandConstant('{app}'));",
    'end;',
    '',
    'procedure CurStepChanged(CurStep: TSetupStep);',
    'begin',
    '  if CurStep = ssPostInstall then WriteInstallationMarker;',
    'end;',
    '',
    'function InitializeUninstall: Boolean;',
    'var',
    '  Busy: String;',
    'begin',
    "  Busy := WaitUntilClosed(ExpandConstant('{app}'), 0);",
    "  while (Busy <> '') and not UninstallSilent do",
    '  begin',
    "    if MsgBox('AoE2RMSIDE is running (' + Busy + '). Close it, then choose Retry.', mbError, MB_RETRYCANCEL) <> IDRETRY then",
    '    begin',
    '      Result := False;',
    '      Exit;',
    '    end;',
    "    Busy := WaitUntilClosed(ExpandConstant('{app}'), 2);",
    '  end;',
    "  if Busy <> '' then Busy := WaitUntilClosed(ExpandConstant('{app}'), 15);",
    "  if Busy <> '' then Log('AoE2RMSIDE uninstall: still running: ' + Busy);",
    "  Result := Busy = '';",
    'end;',
    '',
    'procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);',
    'begin',
    '  if CurUninstallStep = usUninstall then',
    `    DeleteFile(ExpandConstant(${pascal(markerPath)}))`,
    '  else if CurUninstallStep = usPostUninstall then',
    '    RemoveAoE2RmsIdeRegistration;',
    'end;',
  ];

  const lines = [
    `; ${displayName} ${version} installer, generated by tools/package-installer.mjs.`,
    '; Do not edit: regenerate it from the packaged application.',
    '',
    ...setup,
    '',
    ...sections,
    ...(registers ? innoRegistrySection().trimEnd().split('\r\n').concat(['']) : []),
    ...code,
    '',
  ];
  return lines.join('\r\n');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function readPackageMetadata(packageRoot) {
  const path = join(packageRoot, 'resources', 'rmside-build.json');
  if (!existsSync(join(packageRoot, executableName)) || !existsSync(path)) {
    throw new Error(
      `${packageRoot} is not a packaged AoE2RMSIDE edition with build metadata; run the edition's portable packaging first (pnpm package:zip, package:xs-preview, or package:rms-preview)`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function buildInstaller({
  editionName,
  packageRoot,
  outputDirectory,
  version,
  compiler = locateInnoCompiler(),
  checkPackage,
  log = (text) => process.stdout.write(text),
}) {
  const edition = packageEdition(editionName);
  const root = resolve(packageRoot);
  const packageMetadata = readPackageMetadata(root);
  const metadata = version ? { ...packageMetadata, version } : packageMetadata;
  if (checkPackage) checkPackage(root, edition);
  const output = resolve(outputDirectory);
  mkdirSync(output, { recursive: true });
  const stem = installerStem(edition, metadata.version);
  const work = mkdtempSync(join(tmpdir(), 'rmside-installer-'));
  try {
    const scriptPath = join(work, `${stem}.iss`);
    writeFileSync(
      scriptPath,
      innoSetupScript({
        edition,
        metadata,
        packageRoot: root,
        outputDirectory: output,
        outputBaseFilename: stem,
      }),
      'utf8',
    );
    log(`> ${compiler} ${scriptPath}\n`);
    const compiled = spawnSync(compiler, [scriptPath], {
      cwd: work,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
    const transcript = `${compiled.stdout ?? ''}${compiled.stderr ?? ''}`;
    if (compiled.status !== 0) {
      throw new Error(
        `Inno Setup failed with ${compiled.status ?? compiled.error?.message}\n${transcript.split(/\r?\n/u).slice(-40).join('\n')}`,
      );
    }
    const compilerVersion = innoCompilerVersion(transcript);
    if (compilerVersion !== pinnedInnoSetupVersion) {
      throw new Error(
        `the installer is built with Inno Setup ${pinnedInnoSetupVersion}; ${compiler} is ${compilerVersion ?? 'an unknown version'}`,
      );
    }
    const setupPath = join(output, `${stem}.exe`);
    const bytes = readFileSync(setupPath);
    const digest = sha256(bytes);
    writeFileSync(`${setupPath}.sha256`, `${digest}  ${basename(setupPath)}\n`, 'utf8');
    const buildPath = join(output, `${stem}.build.json`);
    writeFileSync(
      buildPath,
      `${JSON.stringify(
        {
          ...metadata,
          artifact: { name: basename(setupPath), bytes: bytes.length, sha256: digest },
          installer: {
            tool: 'Inno Setup',
            compilerVersion,
            appId: windowsRegistration.appId,
            uninstallDisplayName,
            defaultDirectory: '%LOCALAPPDATA%\\Programs\\AoE2RMSIDE',
            windowsRegistration: edition.windowsRegistration === true,
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    if (statSync(setupPath).size !== bytes.length)
      throw new Error('the setup changed while hashing');
    log(`${basename(setupPath)}\n  ${bytes.length} bytes\n  sha256 ${digest}\n  ${setupPath}\n`);
    return { setupPath, buildPath, sha256: digest, bytes: bytes.length, stem };
  } finally {
    rmSync(work, { force: true, recursive: true });
  }
}

function packageInstaller() {
  const editionName = argument('--edition') ?? 'full';
  const edition = packageEdition(editionName);
  buildInstaller({
    editionName: edition.edition,
    packageRoot:
      argument('--package') ?? join(desktopRoot, `out-${edition.edition}`, 'AoE2RMSIDE-win32-x64'),
    outputDirectory: argument('--output') ?? join(repositoryRoot, 'artifacts', 'packages'),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    packageInstaller();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
