import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { buildIdentity, buildIdentityDefines, rendererEditionAliases } from './vite.edition.config';
import { rendererHeadPlugin } from './vite.renderer-head.config';
import { bundledPackagesCollector } from './vite.third-party.config';

export default defineConfig(({ mode }) => {
  const latencyProfile = mode === 'latency-profile';
  const identity = buildIdentity();
  const bundledPackages = latencyProfile ? undefined : bundledPackagesCollector('renderer');
  return {
    define: buildIdentityDefines(identity),
    resolve: {
      alias: [
        ...rendererEditionAliases(identity.edition),
        ...(latencyProfile
          ? [
              {
                find: './latency-probe',
                replacement: resolve(import.meta.dirname, 'src/latency-profile/renderer-probe.ts'),
              },
            ]
          : []),
        { find: '@', replacement: resolve(import.meta.dirname, 'src/renderer') },
      ],
      dedupe: ['react', 'react-dom'],
    },
    base: './',
    plugins: [
      react(),
      tailwindcss(),
      rendererHeadPlugin('/src/renderer/app.tsx'),
      ...(bundledPackages ? [bundledPackages.plugin] : []),
    ],
    worker: { plugins: () => (bundledPackages ? [bundledPackages.workerPlugin()] : []) },
    root: resolve(import.meta.dirname, 'src/renderer'),
    build: {
      emptyOutDir: true,
      outDir: latencyProfile
        ? resolve(import.meta.dirname, '../../target/latency-profile-desktop/renderer')
        : resolve(import.meta.dirname, 'dist/renderer'),
      sourcemap: latencyProfile,
      target: 'chrome142',
    },
  };
});
