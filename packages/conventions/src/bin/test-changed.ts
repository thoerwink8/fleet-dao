// pnpm test:changed 的入口：算这次改了什么、选要跑的测试、交给 vitest 跑（判法在 ../test-changed.ts）。
//   node packages/conventions/src/bin/test-changed.ts
// 不收参数：跑哪些由改动决定，加过滤会把「改动影响到的」跑漏（要单跑几个文件用 pnpm exec vitest run <路径>）。
// 开几个测试进程由 vitest.config.ts 按内存上限算（../test-run.ts）。
// 退出码：vitest 的（0 过、1 没过）；2 = 没算成要跑什么（origin/main 读不到、git 没成、没装依赖）或给了参数——
// 不许当成「没有要跑的测试」。vitest 被信号杀掉（比如超了会话的内存上限被内核杀掉）退出 1，写明是哪个信号。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGraph } from '../ci-plan.ts';
import { fsRepo } from '../repo.ts';
import {
  BASE,
  changedFiles,
  type GitRun,
  selectTests,
  TestChangedError,
  vitestArgs,
} from '../test-changed.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

function fail(why: string): never {
  console.error(`test:changed 没跑成：${why}`);
  process.exit(2);
}

if (process.argv.length > 2) {
  fail(
    `不收参数（给了：${process.argv.slice(2).join(' ')}）。跑哪些由改动决定；要单跑几个文件用 pnpm exec vitest run <路径>`,
  );
}

const git: GitRun = (args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
};

let changed: string[];
try {
  changed = changedFiles(git);
} catch (e) {
  if (e instanceof TestChangedError) fail(e.message);
  throw e;
}

const selection = selectTests(changed, readGraph(fsRepo(root)));
console.log(`和 ${BASE} 比改了 ${changed.length} 个文件（含没提交的）`);
for (const reason of selection.reasons) console.log(`- ${reason}`);
console.log(selection.kind === 'all' ? '跑：全部测试' : `跑：${selection.paths.join(' ')}`);
if (selection.ciOnly.length > 0) console.log(`CI 另外还跑（这里不跑）：${selection.ciOnly.join('、')}`);

const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
if (!existsSync(vitest)) fail(`找不到 ${vitest}：先 pnpm install`);
const r = spawnSync(process.execPath, [vitest, ...vitestArgs(selection)], { cwd: root, stdio: 'inherit' });
if (r.error) fail(`vitest 起不来（${r.error.message}）`);
if (r.status === null) {
  console.error(`vitest 被信号 ${r.signal ?? '（不知道哪个）'} 杀掉了：测试没跑完，不算通过`);
  process.exit(1);
}
process.exit(r.status);
