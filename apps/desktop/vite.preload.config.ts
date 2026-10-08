import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { buildIdentity, buildIdentityDefines } from './vite.edition.config';
import { bundledPackagesCollector } from './vite.third-party.config';

export default defineConfig(({ mode }) => ({
  define: buildIdentityDefines(buildIdentity()),
  plugins: mode === 'latency-profile' ? [] : [bundledPackagesCollector('preload').plugin],
  build: {
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/preload/preload.ts'),
      formats: ['cjs'],
      fileName: () => 'preload.cjs',
    },
    outDir:
      mode === 'latency-profile'
        ? resolve(import.meta.dirname, '../../target/latency-profile-desktop')
        : resolve(import.meta.dirname, 'dist'),
    rollupOptions: {
      external: ['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
    sourcemap: mode === 'latency-profile',
    target: 'node24',
  },
}));
