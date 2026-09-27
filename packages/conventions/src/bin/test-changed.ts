// pnpm test:changed 的入口：算这次改了什么、选要跑的测试、交给 vitest 跑（判法和整段流程在 ../test-changed.ts 的 testChanged）。
//   node packages/conventions/src/bin/test-changed.ts [--all]
// 只收 --all：跑哪些由改动决定，加过滤会把「改动影响到的」跑漏（要单跑几个文件用 pnpm exec vitest run <路径>）。
// 判出要全跑（改到根配置、锁文件、shared 这类）时本机不跑，打出改到的包各自单跑的命令，退出码 3；带 --all 才在本机全跑；
// CI 里、引擎起的会话里（环境里有 FLEET_RUN_ID）照旧全跑。
// 开几个测试进程由 vitest.config.ts 按内存上限算（../test-run.ts）。
// 退出码：vitest 的（0 过、1 没过）；2 = 没算成要跑什么（origin/main 读不到、git 没成、没装依赖）或给了别的参数——
// 不许当成「没有要跑的测试」；3 = 要全跑、本机没带 --all，没跑（不是测试没过）。vitest 被信号杀掉（比如超了会话的内存上限
// 被内核杀掉）退出 1，写明是哪个信号。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGraph } from '../ci-plan.ts';
import { fsRepo } from '../repo.ts';
import { type GitRun, testChanged } from '../test-changed.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

const git: GitRun = (args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
};

const repo = fsRepo(root);
const code = testChanged({
  argv: process.argv.slice(2),
  env: process.env,
  git,
  repo,
  graph: () => readGraph(repo),
  vitest(args) {
    const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
    if (!existsSync(vitest)) return { status: null, error: new Error(`找不到 ${vitest}：先 pnpm install`) };
    const r = spawnSync(process.execPath, [vitest, ...args], { cwd: root, stdio: 'inherit' });
    return { status: r.status, signal: r.signal, error: r.error };
  },
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
process.exit(code);
