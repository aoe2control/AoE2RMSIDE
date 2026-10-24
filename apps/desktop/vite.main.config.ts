import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { build, defineConfig, type Plugin } from 'vite';
import { buildIdentity, buildIdentityDefines } from './vite.edition.config';
import { bundledPackagesCollector } from './vite.third-party.config';

const nodeBuiltins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

function pictureWorkerBuild(options: {
  outDir: string;
  sourcemap: boolean;
  define: Record<string, string>;
  plugins: Plugin[];
}): Plugin {
  return {
    name: 'rmside-picture-worker',
    apply: 'build',
    async buildStart() {
      await build({
        configFile: false,
        logLevel: 'warn',
        define: options.define,
        plugins: options.plugins,
        build: {
          emptyOutDir: false,
          lib: {
            entry: resolve(import.meta.dirname, 'src/main/pictures/picture-worker.ts'),
            formats: ['cjs'],
            fileName: () => 'picture-worker.cjs',
          },
          outDir: options.outDir,
          rollupOptions: { external: nodeBuiltins },
          sourcemap: options.sourcemap,
          target: 'node24',
        },
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const latencyProfile = mode === 'latency-profile';
  const outDir = latencyProfile
    ? resolve(import.meta.dirname, '../../target/latency-profile-desktop')
    : resolve(import.meta.dirname, 'dist');
  const define = buildIdentityDefines(buildIdentity());
  const bundledPackages = latencyProfile ? null : bundledPackagesCollector('main');
  const pictureWorker = pictureWorkerBuild({
    outDir,
    sourcemap: latencyProfile,
    define,
    plugins: bundledPackages ? [bundledPackages.workerPlugin()] : [],
  });
  return {
    define,
    resolve: {
      alias: latencyProfile
        ? [
            {
              find: './latency-probe',
              replacement: resolve(import.meta.dirname, 'src/latency-profile/main-probe.ts'),
            },
          ]
        : [],
    },
    plugins: bundledPackages ? [pictureWorker, bundledPackages.plugin] : [pictureWorker],
    build: {
      emptyOutDir: false,
      lib: {
        entry: resolve(import.meta.dirname, 'src/main/main.ts'),
        formats: ['cjs'],
        fileName: () => 'main.cjs',
      },
      outDir,
      rollupOptions: {
        external: ['electron', ...nodeBuiltins],
      },
      sourcemap: latencyProfile,
      target: 'node24',
    },
  };
});
