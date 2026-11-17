import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { uk } from '../i18n/uk';

describe('task labels', () => {
  it('provides a human-readable label for every worker task type', () => {
    const workerDirectory = join(process.cwd(), 'apps/worker/src');
    const files = readdirSync(workerDirectory).filter((file) =>
      file.endsWith('.ts'),
    );
    const registered = new Set<string>();

    for (const file of files) {
      const source = readFileSync(join(workerDirectory, file), 'utf8');
      for (const match of source.matchAll(/runTask\(\s*['"]([^'"]+)['"]/g))
        registered.add(match[1]!);
    }

    expect(registered.size).toBeGreaterThan(0);
    for (const type of registered) {
      const label = (uk.tasks.names as Record<string, string>)[type];
      expect(label, `Missing human label for task type ${type}`).toBeTruthy();
      expect(label).not.toBe(type);
    }
  });
});
