import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startWsServer, tempDir } from '@fleet-dao/adapters/testing';
import { describe, expect, it } from 'vitest';
import { automaticMigration } from '../src/auto.ts';
import { DRIFT_NOTICE } from '../src/migrate.ts';
import { runChild } from './child.ts';

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
      let observed = JSON.parse(readFileSync(file, 'utf8'));
      const observedUntil = Date.now() + 5_000;
      while (!observed.checkedAt && Date.now() < observedUntil) {
        await sleep(20);
        observed = JSON.parse(readFileSync(file, 'utf8'));
      }
      expect(observed.idleState).toBe('busy');
      expect(observed.detail).toContain('磁盘记录 1 个');
      expect(Number.isFinite(Date.parse(observed.checkedAt))).toBe(true);
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

  it('装过的命令被清成裸 claude：只打一行人话、退出 76，不改设置、不排后台；主动撤回过则静默', async () => {
    const home = tempDir();
    const repo = tempDir();
    const ms = join(home, '.mirasim');
    mkdirSync(join(ms, 'sessions', 'claude', 'one'), { recursive: true });
    writeFileSync(
      join(ms, 'sessions', 'claude', 'one', 'record.json'),
      JSON.stringify({ runState: 'running', sessionId: 'one' }),
    );
    // Mirasim 界面清掉命令后 setting.json 里没有 agentLaunch。
    writeFileSync(join(ms, 'setting.json'), JSON.stringify({ claudeModel: 'keep' }));
    const root = join(home, '.fleet-dao', 'mirasim-reclaude');
    mkdirSync(root, { recursive: true });
    const record = {
      schema: 1,
      previous: { command: '/legacy/reclaude-mirasim.exe' },
      command: join(root, 'releases', 'x', 'mirasim-reclaude'),
      sourceHash: 'a'.repeat(64),
      binaryHash: 'b'.repeat(64),
      updatedAt: new Date().toISOString(),
      state: 'migrated',
    };
    writeFileSync(join(root, 'migration.json'), JSON.stringify(record));
    const o = { home, repo, platform: 'darwin', arch: process.arch };
    const drift = await automaticMigration(o);
    expect(drift.state).toBe('drift');
    expect(drift.detail).toBe(DRIFT_NOTICE);
    expect(existsSync(join(root, 'worker.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(ms, 'setting.json'), 'utf8'))).toEqual({ claudeModel: 'keep' });

    if (process.platform !== 'linux') {
      // 同步拿退出码 76 认出这行，按「✗ 漂移」交给开会话钩子。
      const bin = resolve(import.meta.dirname, '..', 'bin', 'migrate');
      const cli = runChild(process.execPath, [bin, '--auto', '--home', home, '--repo', repo]);
      expect(cli.status).toBe(76);
      expect(cli.stdout.trim()).toBe(DRIFT_NOTICE);
    }

    writeFileSync(join(root, 'migration.json'), JSON.stringify({ ...record, state: 'restored' }));
    expect((await automaticMigration(o)).state).toBe('skipped');
  });
});
