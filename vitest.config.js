/**
 * Test-only config. Deliberately does not reference wrangler.toml's `main` —
 * that isn't set yet (see docs/implementation-plan.md Phase 2: it's the
 * repository owner's call, once the real hostnames are known). The Worker
 * entry point and the static-assets binding are supplied directly here
 * instead, so `npm test` works before and independently of that.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPagesASSETSBinding, cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['src/**/*.test.js'],
  },
  plugins: [
    cloudflareTest(async () => ({
      main: './src/index.js',
      miniflare: {
        compatibilityDate: '2026-07-01',
        serviceBindings: {
          ASSETS: await buildPagesASSETSBinding(dirname),
        },
      },
    })),
  ],
});
