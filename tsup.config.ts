// Build only this standalone package and keep runtime SDKs external.
import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    external: [
      '@ai-sdk/harness',
      '@ai-sdk/provider-utils',
      '@alibaba-group/opensandbox',
    ],
    format: ['esm'],
    dts: true,
    sourcemap: true,
  },
]);
