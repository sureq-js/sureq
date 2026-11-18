import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/dev-docs.js';
import { skillFiles } from '../helpers/skill-files.js';

const SKIP_MESSAGE = 'skills CLI not available';
const env = { ...process.env, DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', npm_config_yes: 'true' };

/** Runs `npx --yes skills <args>` in a folder; `null` when npx itself cannot run. */
const skills = (cwd: string, args: string[]) => {
  const run = spawnSync('npx', ['--yes', 'skills', ...args], { cwd, env, encoding: 'utf8', timeout: 150_000 });
  return run.error ? null : run;
};

const project = realpathSync(mkdtempSync(join(tmpdir(), 'sureq-skill-install-')));
afterAll(() => rmSync(project, { recursive: true, force: true }));

/** Whether the CLI can be fetched and started here (it needs the npm registry or a warm npx cache). */
const probe = skills(project, ['--version']);
const available = probe !== null && probe.status === 0;

/** The `path` of the installed skill from the CLI's `--json` output, which follows its progress text. */
const reportedPath = (stdout: string): string | undefined => {
  const start = stdout.indexOf('\n[');
  if (start < 0) return undefined;
  const rows = JSON.parse(stdout.slice(start)) as { name: string; status: string; path: string }[];
  return rows.find((r) => r.name === 'sureq' && r.status === 'installed')?.path;
};

describe('skill: install', () => {
  it('skill: npx skills add installs sureq from the local repository', (ctx) => {
    if (!available) {
      // Written to the raw stderr descriptor so the reporter cannot fold it away.
      writeSync(2, `\nskill: install test skipped: ${SKIP_MESSAGE}\n`);
      ctx.skip(SKIP_MESSAGE);
      return;
    }
    const run = skills(project, ['add', repoRoot, '--skill', 'sureq', '-a', 'claude-code', '-y', '--json']);
    expect(run, 'npx did not start').not.toBeNull();
    expect(run?.status, `${run?.stdout ?? ''}\n${run?.stderr ?? ''}`).toBe(0);

    const installed = reportedPath(run?.stdout ?? '') ?? join(project, '.claude/skills/sureq');
    expect(relative(project, installed).startsWith('..'), `installed outside the project: ${installed}`).toBe(false);
    for (const file of skillFiles) expect(existsSync(join(installed, file)), file).toBe(true);
    expect(existsSync(join(project, '.claude/skills/sureq/SKILL.md'))).toBe(true);
  }, 300_000);
});
