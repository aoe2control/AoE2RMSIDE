import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { buildIdentity, buildIdentityDefines } from './vite.edition.config';
import { bundledPackagesCollector } from './vite.third-party.config';

export default defineConfig(({ mode }) => {
  const latencyProfile = mode === 'latency-profile';
  return {
    define: buildIdentityDefines(buildIdentity()),
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
    plugins: latencyProfile ? [] : [bundledPackagesCollector('main').plugin],
    build: {
      emptyOutDir: false,
      lib: {
        entry: resolve(import.meta.dirname, 'src/main/main.ts'),
        formats: ['cjs'],
        fileName: () => 'main.cjs',
      },
      outDir: latencyProfile
        ? resolve(import.meta.dirname, '../../target/latency-profile-desktop')
        : resolve(import.meta.dirname, 'dist'),
      rollupOptions: {
        external: ['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      },
      sourcemap: latencyProfile,
      target: 'node24',
    },
  };
});
