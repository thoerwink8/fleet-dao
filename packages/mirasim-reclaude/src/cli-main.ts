import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { automaticMigration, workerFile } from './auto.ts';
import { atomicJson, migrate } from './migrate.ts';

const args = process.argv.slice(2);
const value = (key: string): string | undefined => {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1] : undefined;
};
const home = value('--home') ?? homedir();
const repo = value('--repo') ?? fileURLToPath(new URL('../../..', import.meta.url));
const worker = args.includes('--worker');
const usage =
  'pnpm mirasim:migrate [--check | --rollback] [--no-wait]\n旧接入空闲后更新；有在途回合时等待，不重启整个 Mirasim。';
const known = new Set([
  '--home',
  '--repo',
  '--worker',
  '--managed-only',
  '--wait-idle',
  '--no-wait',
  '--check',
  '--rollback',
  '--help',
  '--auto',
]);
try {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!known.has(arg)) throw new Error('迁移参数不认识');
    if (arg === '--home' || arg === '--repo') {
      if (!args[++i]) throw new Error('迁移参数缺值');
    }
  }
  if (args.includes('--help')) console.log(usage);
  else if (args.includes('--auto')) {
    const result = await automaticMigration({ home, repo, platform: process.platform, arch: process.arch });
    if (result.state !== 'skipped') console.log(`Mirasim：${result.detail}`);
    process.exitCode = 0;
  } else {
    if (worker)
      atomicJson(workerFile(home), {
        schema: 1,
        pid: process.pid,
        state: 'waiting',
        updatedAt: new Date().toISOString(),
      });
    const until = Date.now() + 6 * 60 * 60_000;
    for (;;) {
      const result = await migrate({
        home,
        repo,
        platform: process.platform,
        arch: process.arch,
        auto: worker || args.includes('--managed-only') || process.platform === 'linux',
        check: args.includes('--check'),
        rollback: args.includes('--rollback'),
        wait: !args.includes('--no-wait') && !args.includes('--check'),
        maxWaitMs: Math.max(0, until - Date.now()),
      });
      console.log(`Mirasim：${result.detail}`);
      if (
        result.state === 'waiting' &&
        Date.now() < until &&
        !args.includes('--no-wait') &&
        !args.includes('--check')
      ) {
        await sleep(1_000);
        continue;
      }
      if (worker)
        atomicJson(workerFile(home), {
          schema: 1,
          pid: process.pid,
          state: result.state === 'waiting' ? 'expired' : 'done',
          result: result.state,
          updatedAt: new Date().toISOString(),
        });
      process.exitCode = result.state === 'waiting' ? 75 : 0;
      break;
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : '迁移失败';
  if (worker)
    atomicJson(workerFile(home), {
      schema: 1,
      pid: process.pid,
      state: 'failed',
      detail: message,
      updatedAt: new Date().toISOString(),
    });
  console.error(`Mirasim 迁移失败：${message}`);
  process.exitCode = 1;
}
