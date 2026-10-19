import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';
import { interactiveHookEnv } from './hook-env.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('交互钩子夹具不借启动测试的会话身份', { timeout: 0 }, () => {
  it('去掉宿主 CLI 身份和工人标记，保留运行环境且不修改传入对象', () => {
    const inherited = {
      PATH: 'fixture-tools',
      CLAUDE_CODE_SESSION_ID: 'host-claude-parent',
      CODEX_THREAD_ID: 'host-codex-child',
      CODEX_SESSION_ID: 'host-codex-parent',
      CODEX_HOME: 'host-codex-home',
      FLEET_HEADLESS: '1',
      FLEET_WORKER: '1',
    };
    const before = { ...inherited };
    expect(interactiveHookEnv(inherited)).toEqual({ PATH: 'fixture-tools' });
    expect(inherited).toEqual(before);
  });

  it.each([
    { name: '冲突 Codex 身份', headless: '', worker: '' },
    { name: '继承的无头工人标记', headless: '1', worker: '1' },
  ])('独立进程带 $name：模拟 Claude 仍落盘、开场；显式工人仍拒绝', ({ headless, worker }) => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-fixture-env-'));
    made.push(dir);
    const script = String.raw`
      import { readFileSync, readdirSync } from 'node:fs';
      import { join } from 'node:path';
      import { interactiveHookEnv } from ${JSON.stringify(new URL('./hook-env.ts', import.meta.url).href)};
      import { runChild } from ${JSON.stringify(new URL('./child.ts', import.meta.url).href)};
      import { sessionStart } from ${JSON.stringify(new URL('../hooks/session-start.mjs', import.meta.url).href)};
      const env = interactiveHookEnv();
      const home = process.env.HOME;
      const input = JSON.stringify({ prompt: 'fixture founder message', prompt_id: 'fixture-prompt', session_id: 'fixture-claude', cwd: home });
      const hook = ${JSON.stringify(fileURLToPath(new URL('../hooks/prompt-log.mjs', import.meta.url)))};
      const prompt = runChild(process.execPath, [hook], { env, input, cwd: home });
      const rows = () => readdirSync(home).filter(f => f.endsWith('.jsonl')).flatMap(f => readFileSync(join(home, f), 'utf8').trim().split('\n'));
      const git = () => ({ status: 1, stdout: '', stderr: 'fixture: not a repository' });
      const sync = () => ({ status: 0, stdout: '', stderr: '' });
      let reads = 0;
      const opening = sessionStart({ cwd: home, home, env, git, sync, sessionId: 'fixture-claude', poolHolds: () => { reads++; return { ok: true, skipped: true }; } });
      const countBeforeWorker = rows().length;
      const workerEnv = { ...env, FLEET_WORKER: '1' };
      const worker = runChild(process.execPath, [hook], { env: workerEnv, cwd: home, input: input.replace('fixture-prompt', 'worker-prompt') });
      let workerReads = 0;
      sessionStart({ cwd: home, home, env: workerEnv, git, sync, poolHolds: () => { workerReads++; return { ok: true, skipped: true }; } });
      console.log(JSON.stringify({ promptStatus: prompt.status, promptStdout: prompt.stdout, promptStderr: prompt.stderr, rows: rows().map(r => JSON.parse(r).prompt), reads, unknownOpening: opening.some(line => line.includes('ENV_CONFLICT')), countBeforeWorker, workerStatus: worker.status, workerReads, inheritedWorker: process.env.FLEET_WORKER }));
    `;
    const result = runChild(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir,
      env: {
        ...process.env,
        HOME: dir,
        USERPROFILE: dir,
        CODEX_HOME: join(dir, 'host-codex-home'),
        CLAUDE_CODE_SESSION_ID: 'host-claude-parent',
        CODEX_THREAD_ID: 'host-codex-child',
        CODEX_SESSION_ID: 'host-codex-parent',
        FLEET_HEADLESS: headless,
        FLEET_WORKER: worker,
        FLEET_PROMPT_LOG_DIR: dir,
        FLEET_UNATTENDED_DIR: join(dir, 'state'),
        FLEET_DAO_HOME: join(dir, 'fleet-home'),
        FLEET_WORKERS_DIR: join(dir, 'workers'),
        FLEET_MIRASIM_DIR: join(dir, 'mirasim'),
        FLEET_FRANCE_SSH: '',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      promptStatus: 0,
      promptStdout: '',
      promptStderr: '',
      rows: ['fixture founder message'],
      reads: 1,
      unknownOpening: false,
      countBeforeWorker: 1,
      workerStatus: 0,
      workerReads: 0,
      inheritedWorker: worker,
    });
  });
});
