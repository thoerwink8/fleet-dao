import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../adapters/test/helpers.ts';
import { startWsServer } from '../../adapters/test/ws-server.ts';
import { automaticMigration } from '../src/auto.ts';

describe('同步中的自动迁移', () => {
  it('没有旧封装或 Linux 无头环境：不配置 Mirasim，也不建立后台任务', async () => {
    const home = tempDir();
    const o = { home, repo: tempDir(), platform: process.platform, arch: process.arch };
    expect((await automaticMigration(o)).state).toBe('skipped');
    expect((await automaticMigration({ ...o, platform: 'linux' })).state).toBe('skipped');
  });

  it('在途会话只排一个实际后台进程，调用立即返回且不改启动配置', { timeout: 20_000 }, async () => {
    if (process.platform === 'linux') return; // Linux 自动迁移有独立的跳过用例；桌面此例由 Windows/Mac 执行。
    const base = resolve('_tmp');
    mkdirSync(base, { recursive: true });
    const taskRoot = mkdtempSync(join(base, 'migration-auto-'));
    if (!taskRoot.startsWith(join(base, 'migration-auto-'))) throw new Error('测试清理路径超出临时目录');
    const home = join(taskRoot, 'home');
    const repo = join(taskRoot, 'repo');
    const launcher = join(repo, 'packages', 'mirasim-reclaude', 'launcher');
    mkdirSync(launcher, { recursive: true });
    writeFileSync(join(launcher, 'go.mod'), 'module fixture\ngo 1.22\n');
    writeFileSync(join(launcher, 'main.go'), 'package main\nfunc main(){}\n');
    const ms = join(home, '.mirasim');
    const record = join(ms, 'sessions', 'claude', 'one', 'record.json');
    mkdirSync(join(ms, 'run'), { recursive: true });
    mkdirSync(join(ms, 'sessions', 'claude', 'one'), { recursive: true });
    writeFileSync(record, JSON.stringify({ runState: 'running', sessionId: 'one' }));
    const initial = { agentLaunch: { claude: { command: '/legacy/reclaude-mirasim.exe' } } };
    writeFileSync(join(ms, 'setting.json'), JSON.stringify(initial));
    const server = await startWsServer((peer) =>
      peer.onMessage((f) => {
        if (f.type === 'getConfig') peer.send({ type: 'config', config: initial });
      }),
    );
    writeFileSync(join(ms, 'run', `local-${server.port}.token`), 'fixture-ticket');
    const o = { home, repo, platform: process.platform, arch: process.arch, pollMs: 5, maxWaitMs: 10 };
    let pid = 0;
    try {
      expect((await automaticMigration(o)).state).toBe('waiting');
      const file = join(home, '.fleet-dao', 'mirasim-reclaude', 'worker.json');
      const first = JSON.parse(readFileSync(file, 'utf8'));
      pid = first.pid;
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect((await automaticMigration(o)).state).toBe('waiting');
      expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(pid);
      expect(JSON.parse(readFileSync(join(ms, 'setting.json'), 'utf8'))).toEqual(initial);
    } finally {
      if (pid > 0) {
        try {
          process.kill(pid);
        } catch {}
        const end = Date.now() + 3_000;
        while (Date.now() < end) {
          try {
            process.kill(pid, 0);
          } catch {
            break;
          }
          await sleep(20);
        }
        await sleep(100);
      }
      await server.close();
      rmSync(taskRoot, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
    }
  });
});
