import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { automaticMigration, workerFile } from './auto.ts';
import { checkExitCode, launchOverrides, overrideLines } from './launches.ts';
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
  'pnpm mirasim:migrate [--check | --rollback] [--no-wait]\n旧接入空闲后更新；有在途回合时等待，不重启整个 Mirasim。\n--auto 发现启动命令被改回裸 claude 时只报告、不改设置，退出 76。';
// --auto 发现启动命令被改掉：只报告，用独立退出码让同步把这行当成「漂移」交给开会话钩子。
const DRIFT_EXIT = 76;
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
const say = (detail: string) => console.log(detail.startsWith('Mirasim') ? detail : `Mirasim：${detail}`);
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
    if (result.state !== 'skipped') say(result.detail);
    process.exitCode = result.state === 'drift' ? DRIFT_EXIT : 0;
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
        onWaiting: (observation) => {
          if (worker)
            atomicJson(workerFile(home), {
              schema: 1,
              pid: process.pid,
              state: 'waiting',
              idleState: observation.state,
              detail: observation.detail,
              checkedAt: observation.checkedAt,
              updatedAt: observation.checkedAt,
            });
        },
      });
      say(result.detail);
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
      if (args.includes('--check')) {
        // 单会话启动命令覆盖盖过全局命令：覆盖成裸 claude 的会话绕过 reclaude，全局装好了也算没接好。
        let bare = 0;
        try {
          const shown = overrideLines(launchOverrides(home));
          shown.lines.forEach((line, i) => {
            console.log(shown.red[i] && process.stdout.isTTY ? `\u001b[31m${line}\u001b[0m` : line);
          });
          bare = shown.bare;
        } catch (error) {
          console.error(`会话单独启动命令没查成：${error instanceof Error ? error.message : '未知错误'}`);
          process.exitCode = 1;
          break;
        }
        process.exitCode = checkExitCode(result.state, bare);
      }
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
