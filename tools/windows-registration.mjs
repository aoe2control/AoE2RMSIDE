export const windowsRegistration = Object.freeze({
  appId: '{1B5317D7-8B20-4E0D-B2DD-A36B4738D720}',
  applicationName: 'AoE2RMSIDE',
  applicationDescription: 'Random map script editor for Age of Empires II: Definitive Edition',
  executableName: 'AoE2RMSIDE.exe',
  progId: 'AoE2RMSIDE.RmsScript',
  progIdDescription: 'Random Map Script',
  associatedExtensions: Object.freeze(['.rms', '.rms2']),
  folderVerb: 'AoE2RMSIDE.OpenFolder',
  folderVerbLabel: 'Open folder in AoE2RMSIDE',
  capabilitiesKey: 'Software\\AoE2RMSIDE\\Capabilities',
  defaultInstallDirectory: '{userpf}\\AoE2RMSIDE',
  installationMarker: Object.freeze({
    relativePath: 'resources\\rmside-installation.ini',
    section: 'Installation',
    schemaVersion: 1,
    kind: 'per-user',
  }),
});

const fileCommand = '"{exe}" -- "%1"';
const folderCommand = '"{exe}" -- "%V"';
const executableIcon = '"{exe}",0';

function entry(subkey, value, uninstall) {
  return Object.freeze({
    root: 'HKCU',
    subkey,
    value: value ? Object.freeze(value) : null,
    uninstall,
  });
}

function stringValue(name, data) {
  return { name, type: 'string', data };
}

function markerValue(name) {
  return { name, type: 'string', data: '' };
}

function ownKeys(layout) {
  return [
    `Software\\Classes\\${layout.progId}`,
    `Software\\Classes\\Applications\\${layout.executableName}`,
    layout.capabilitiesKey.slice(0, layout.capabilitiesKey.lastIndexOf('\\')),
    `Software\\Classes\\Directory\\shell\\${layout.folderVerb}`,
    `Software\\Classes\\Directory\\Background\\shell\\${layout.folderVerb}`,
  ];
}

const keyName = (key) => key.toLocaleLowerCase('en-US');
const within = (key, root) =>
  keyName(key) === keyName(root) || keyName(key).startsWith(`${keyName(root)}\\`);
const permanentKeys = new Set(['software', 'software\\classes']);

function sharedKeys(entries, layout) {
  const own = ownKeys(layout);
  const keys = [];
  const seen = new Set();
  for (const item of entries) {
    const parts = item.subkey.split('\\');
    for (let length = 1; length <= parts.length; length += 1) {
      const key = parts.slice(0, length).join('\\');
      if (permanentKeys.has(keyName(key)) || seen.has(keyName(key))) continue;
      if (own.some((root) => within(key, root))) continue;
      seen.add(keyName(key));
      keys.push(key);
    }
  }
  return keys;
}

export function registrationEntries(layout = windowsRegistration) {
  const [progIdKey, applicationKey, ownKey, ...folderKeys] = ownKeys(layout);
  const entries = [
    entry(progIdKey, stringValue('', layout.progIdDescription), 'delete-key'),
    entry(`${progIdKey}\\DefaultIcon`, stringValue('', executableIcon), 'delete-key'),
    entry(`${progIdKey}\\shell\\open\\command`, stringValue('', fileCommand), 'delete-key'),
    ...layout.associatedExtensions.map((extension) =>
      entry(
        `Software\\Classes\\${extension}\\OpenWithProgids`,
        markerValue(layout.progId),
        'delete-value',
      ),
    ),
    entry(applicationKey, stringValue('FriendlyAppName', layout.applicationName), 'delete-key'),
    ...layout.associatedExtensions.map((extension) =>
      entry(`${applicationKey}\\SupportedTypes`, markerValue(extension), 'delete-key'),
    ),
    entry(`${applicationKey}\\DefaultIcon`, stringValue('', executableIcon), 'delete-key'),
    entry(`${applicationKey}\\shell\\open\\command`, stringValue('', fileCommand), 'delete-key'),
    entry(ownKey, null, 'delete-key-if-empty'),
    entry(
      layout.capabilitiesKey,
      stringValue('ApplicationName', layout.applicationName),
      'delete-key',
    ),
    entry(
      layout.capabilitiesKey,
      stringValue('ApplicationDescription', layout.applicationDescription),
      'delete-key',
    ),
    entry(layout.capabilitiesKey, stringValue('ApplicationIcon', executableIcon), 'delete-key'),
    ...layout.associatedExtensions.map((extension) =>
      entry(
        `${layout.capabilitiesKey}\\FileAssociations`,
        stringValue(extension, layout.progId),
        'delete-key',
      ),
    ),
    entry(
      'Software\\RegisteredApplications',
      stringValue(layout.applicationName, layout.capabilitiesKey),
      'delete-value',
    ),
    ...folderKeys.flatMap((key) => [
      entry(key, stringValue('', layout.folderVerbLabel), 'delete-key'),
      entry(key, stringValue('Icon', executableIcon), 'delete-key'),
      entry(`${key}\\command`, stringValue('', folderCommand), 'delete-key'),
    ]),
  ];
  return Object.freeze([
    ...sharedKeys(entries, layout).map((key) => entry(key, null, 'delete-key-if-empty')),
    ...entries,
  ]);
}

const innoUninstallFlags = Object.freeze({
  'delete-key': 'uninsdeletekey',
  'delete-value': 'uninsdeletevalue',
  'delete-key-if-empty': 'uninsdeletekeyifempty',
});

function innoQuoted(text) {
  if (/[{}]/u.test(text.replaceAll('{exe}', ''))) {
    throw new Error(`registry text contains an Inno Setup constant: ${text}`);
  }
  const executable = `{app}\\${windowsRegistration.executableName}`;
  return `"${text.replaceAll('{exe}', executable).replaceAll('"', '""')}"`;
}

export function innoRegistrySection(entries = registrationEntries()) {
  const lines = ['[Registry]'];
  for (const item of entries) {
    if (item.root !== 'HKCU') throw new Error(`registry root ${item.root} is not per-user`);
    const flag = innoUninstallFlags[item.uninstall];
    if (!flag) throw new Error(`unknown uninstall rule ${item.uninstall}`);
    const parts = [`Root: HKCU`, `Subkey: ${innoQuoted(item.subkey)}`];
    if (item.value === null) {
      parts.push('ValueType: none');
    } else if (item.value.type === 'string') {
      parts.push(
        'ValueType: string',
        `ValueName: ${innoQuoted(item.value.name)}`,
        `ValueData: ${innoQuoted(item.value.data)}`,
      );
    } else {
      throw new Error(`unknown registry value type ${item.value.type}`);
    }
    parts.push(`Flags: ${flag}`);
    lines.push(parts.join('; '));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function pascalQuoted(text) {
  if (/[\r\n]/u.test(text)) throw new Error(`registry text contains a line break: ${text}`);
  return `'${text.replaceAll("'", "''")}'`;
}

export function innoRegistrationCleanupProcedure(entries = registrationEntries()) {
  const deleteKeys = [];
  for (const item of entries) {
    if (item.root !== 'HKCU') throw new Error(`registry root ${item.root} is not per-user`);
    if (!innoUninstallFlags[item.uninstall]) {
      throw new Error(`unknown uninstall rule ${item.uninstall}`);
    }
    if (item.uninstall !== 'delete-key') continue;
    if (deleteKeys.some((key) => within(item.subkey, key))) continue;
    deleteKeys.push(item.subkey);
  }
  const values = entries.filter((item) => item.uninstall === 'delete-value');
  const emptyKeys = entries
    .filter((item) => item.uninstall === 'delete-key-if-empty')
    .map((item) => item.subkey)
    .reverse();
  const lines = [
    'procedure RemoveAoE2RmsIdeRegistration;',
    'begin',
    ...deleteKeys.map((key) => `  RegDeleteKeyIncludingSubkeys(HKCU, ${pascalQuoted(key)});`),
    ...values.map(
      (item) =>
        `  RegDeleteValue(HKCU, ${pascalQuoted(item.subkey)}, ${pascalQuoted(item.value.name)});`,
    ),
    ...emptyKeys.map((key) => `  RegDeleteKeyIfEmpty(HKCU, ${pascalQuoted(key)});`),
    'end;',
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export function installationMarkerText(directory, layout = windowsRegistration) {
  const marker = layout.installationMarker;
  return [
    `[${marker.section}]`,
    `SchemaVersion=${marker.schemaVersion}`,
    `Kind=${marker.kind}`,
    `Directory=${directory}`,
    '',
  ].join('\r\n');
}
