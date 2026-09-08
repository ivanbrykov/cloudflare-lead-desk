import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: 'node',
    hookTimeout: 60_000,
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
