// Unit tests alias AI SDK beta packages to narrow local stubs.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@ai-sdk/harness': fileURLToPath(
        new URL('./test-stubs/harness.ts', import.meta.url),
      ),
      '@ai-sdk/provider-utils': fileURLToPath(
        new URL('./test-stubs/provider-utils.ts', import.meta.url),
      ),
    },
  },
});
