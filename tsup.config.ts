import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node18',
  external: ['@modelcontextprotocol/sdk', 'pixelmatch', 'playwright', 'pngjs', 'ws', 'zod'],
  sourcemap: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
});
