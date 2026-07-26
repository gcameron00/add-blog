/**
 * Test-only config. Deliberately does not reference wrangler.toml's `main` —
 * that isn't set yet (see docs/implementation-plan.md Phase 2: it's the
 * repository owner's call, once the real hostnames are known). The Worker
 * entry point and the static-assets/D1/R2 bindings are supplied directly
 * here instead, so `npm test` works before and independently of that.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPagesASSETSBinding, cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['src/**/*.test.js'],
    setupFiles: ['./src/test-setup.js'],
  },
  plugins: [
    cloudflareTest(async () => ({
      main: './src/index.js',
      miniflare: {
        compatibilityDate: '2026-07-01',
        d1Databases: ['DB'],
        r2Buckets: ['MEDIA'],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(dirname, 'migrations')),
        },
        serviceBindings: {
          ASSETS: await buildPagesASSETSBinding(dirname),
        },
      },
    })),
  ],
});
