import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'packages/**/*.test.ts',
      'apps/web/src/app/api/**/*.test.ts',
      'apps/web/src/lib/**/*.test.ts',
      'apps/web/src/components/**/*.test.tsx',
      'apps/worker/src/**/*.test.ts',
      'apps/viber-bridge/src/**/*.test.ts',
    ],
  },
});
