import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { MigrationBudgetData } from './migration-budget-data.ts';

export type { MigrationBudgetData } from './migration-budget-data.ts';
export type MigrationBudgetVerification = { verified: true } | { verified: false; reason: string };

/** 固定发布版脚本/cwd/依赖；不继承 NODE_OPTIONS，不进入会话工作树。 */
export function verifyMigrationBudget(
  data: MigrationBudgetData,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<MigrationBudgetVerification> {
  const input = Buffer.from(JSON.stringify(data));
  if (input.length > 4 * 1024 * 1024) return Promise.resolve({ verified: false, reason: '迁移核验输入超限' });
  if (options.signal?.aborted) return Promise.resolve({ verified: false, reason: '迁移核验已取消' });
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=256', fileURLToPath(new URL('./bin/migration-budget.ts', import.meta.url))],
      {
        cwd: fileURLToPath(new URL('.', import.meta.url)),
        stdio: 'pipe',
        env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      },
    );
    let settled = false,
      output = '',
      bytes = 0;
    const finish = (result: MigrationBudgetVerification) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill('SIGKILL');
      resolve(result);
    };
    const abort = () => finish({ verified: false, reason: '迁移核验已取消' });
    // 子进程起 node 加生成 SQL 单跑就要三四秒，机器忙时常过 5 秒；超时只会退回 raw 多计行数，给足 20 秒。
    const timer = setTimeout(
      () => finish({ verified: false, reason: '迁移核验超时' }),
      options.timeoutMs ?? 20_000,
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8192) finish({ verified: false, reason: '迁移核验输出超限' });
      else output += chunk.toString('utf8');
    });
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => finish({ verified: false, reason: `迁移核验未启动：${error.message}` }));
    child.on('close', (code) => {
      if (code !== 0) return finish({ verified: false, reason: `迁移核验退出：${code}` });
      try {
        const result = JSON.parse(output);
        if (result.verified === true && Object.keys(result).length === 1) finish({ verified: true });
        else if (result.verified === false && typeof result.reason === 'string')
          finish({ verified: false, reason: result.reason });
        else finish({ verified: false, reason: '迁移核验回执形状错误' });
      } catch {
        finish({ verified: false, reason: '迁移核验回执无法读取' });
      }
    });
    child.stdin.end(input);
  });
}
