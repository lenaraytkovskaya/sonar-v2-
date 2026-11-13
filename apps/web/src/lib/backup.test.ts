import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Sonar backup', () => {
  let directory: string;
  let backups: string;
  let environment: NodeJS.ProcessEnv;
  const old = 'sonar-2020-01-01_00-00-00.dump';
  const recent = 'sonar-2020-01-02_00-00-00.dump';
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sonar-backup-test-'));
    backups = join(directory, 'backups');
    mkdirSync(backups);
    const binary = join(directory, 'pg_dump');
    writeFileSync(
      binary,
      `#!/bin/sh
printf '%s\\n' "$@" > "$DUMP_ARGS_FILE"
for argument do
  case "$argument" in --file=*) destination=\${argument#--file=} ;; esac
done
printf '%s' "\${DUMP_CONTENT-dump}" > "$destination"
exit "\${DUMP_EXIT_CODE:-0}"
`,
    );
    chmodSync(binary, 0o700);
    environment = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      BACKUP_DIR: backups,
      DUMP_ARGS_FILE: join(directory, 'args'),
      DUMP_EXIT_CODE: '0',
      DUMP_CONTENT: 'stub custom dump',
    };
    for (const [name, days] of [
      [old, 15],
      [recent, 13],
      ['registry.dump', 30],
    ] as const) {
      const file = join(backups, name);
      writeFileSync(file, 'existing backup');
      const timestamp = new Date(Date.now() - days * 86400000);
      utimesSync(file, timestamp, timestamp);
    }
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  const run = () =>
    execFileSync('/bin/sh', [resolve('scripts/backup.sh')], {
      env: environment,
      stdio: 'pipe',
    });

  it('publishes a private dated sonar-only dump and rotates only old Sonar dumps', () => {
    run();
    const files = readdirSync(backups);
    const created = files.find(
      (name) => name !== recent && name !== 'registry.dump',
    )!;
    expect(created).toMatch(
      /^sonar-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.dump$/,
    );
    expect(files.sort()).toEqual([recent, 'registry.dump', created].sort());
    expect(readFileSync(join(backups, created), 'utf8')).toBe(
      'stub custom dump',
    );
    expect(statSync(join(backups, created)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(directory, 'args'), 'utf8').split('\n')).toEqual([
      '--dbname=sonar',
      '--format=custom',
      expect.stringContaining(`--file=${backups}/.sonar-backup.`),
      '',
    ]);
  });
  it.each([{ DUMP_EXIT_CODE: '9' }, { DUMP_CONTENT: '' }])(
    'preserves previous backups and removes partial output on failure: %o',
    (env) => {
      environment = { ...environment, ...env };
      expect(run).toThrow();
      expect(readdirSync(backups).sort()).toEqual(
        [old, recent, 'registry.dump'].sort(),
      );
    },
  );
});
