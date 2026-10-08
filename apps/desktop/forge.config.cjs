const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const iconDirectory = resolve(__dirname, '../../assets/original/branding');
const applicationIcon = resolve(iconDirectory, 'aoe2rmside-icon.ico');
const interLicenseDirectory = resolve(__dirname, '../../assets/third-party/inter');
const shadcnLicenseDirectory = resolve(__dirname, '../../assets/third-party/shadcn-ui');
const thirdPartyNotices = resolve(
  __dirname,
  '../../target/package-notices/THIRD-PARTY-NOTICES.txt',
);
const configuredOutDirectory = process.env.RMSIDE_FORGE_OUT_DIR?.trim();
const editionDisplayName = process.env.RMSIDE_PRODUCT_DISPLAY_NAME?.trim();
const electronFusesModule = pathToFileURL(
  resolve(__dirname, '../../tools/electron-fuses.mjs'),
).href;

function packagedAppPath(path) {
  if (path === '' || path === '/package.json' || path === '/dist') return true;
  if (!path.startsWith('/dist/')) return false;
  if (path === '/dist/bundled-packages' || path.startsWith('/dist/bundled-packages/')) return false;
  return !/\.map$/iu.test(path);
}

module.exports = {
  ...(configuredOutDirectory ? { outDir: resolve(configuredOutDirectory) } : {}),
  hooks: {
    postPackage: async (_forgeConfig, { outputPaths }) => {
      const { applyFuses } = await import(electronFusesModule);
      for (const outputPath of outputPaths) applyFuses(join(outputPath, 'AoE2RMSIDE.exe'));
    },
  },
  packagerConfig: {
    asar: true,
    executableName: 'AoE2RMSIDE',
    extraResource: [
      'native',
      applicationIcon,
      interLicenseDirectory,
      shadcnLicenseDirectory,
      thirdPartyNotices,
    ],
    icon: applicationIcon,
    overwrite: true,
    ignore: (path) => !packagedAppPath(path),
    name: 'AoE2RMSIDE',
    prune: false,
    ...(editionDisplayName
      ? { win32metadata: { FileDescription: editionDisplayName, ProductName: editionDisplayName } }
      : {}),
  },
};
