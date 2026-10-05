// git pre-push 钩子里的第二段：卫生检查过后跑本机的预检——这次改动要在 CI 上跑的类型检查和格式检查，在这里先跑一遍
// （判法见 prepare-push.ts，和 CI 同一份）。创始人 2026-10-03：一个 PR 慢，多半是「CI 红了、改、重推」那几轮。
// 用法：node packages/conventions/src/bin/prepare-push.ts（在仓根跑；.githooks/pre-push 调它）。
// 退出码：0 过了；1 查出来没过；2 没查成（不推）。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGraph } from '../ci-plan.ts';
import { preparePush } from '../prepare-push.ts';
import { fsRepo } from '../repo.ts';
import { changedFiles, type GitRun, TestChangedError } from '../test-changed.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

const git: GitRun = (args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
};

const repo = fsRepo(root);
const win = process.platform === 'win32';
/**
 * 包自己的可执行文件（biome、tsc 都是依赖，装在 node_modules/.bin 里）。找不到就报「没查成」，不当成通过。
 * Windows 上 .bin 里同名那份是 sh 脚本、spawn 不起来（ENOENT），要认 .cmd；.cmd 又只能经 shell 起。
 */
const bin = (name: string): string | null => {
  const names = win ? [`${name}.cmd`] : [name];
  for (const n of names) {
    const p = join(root, 'node_modules', '.bin', n);
    if (existsSync(p)) return p;
  }
  return null;
};

const result = preparePush({
  changed: () => changedFiles(git),
  repo,
  graph: () => readGraph(repo),
  run(name, args) {
    const p = bin(name);
    // 启动器不在（工作树没装依赖）就别硬起：Windows 上拿不存在的路径经 cmd 起会得到一句「系统找不到指定的路径」
    // 加退出码 1，看着像检查没过（#789）。当场按「起不来」报。
    if (p === null) {
      return {
        status: null,
        stdout: '',
        stderr: '',
        error: new Error(`node_modules/.bin 里没有 ${name}，这棵工作树没装依赖`),
      };
    }
    // 参数是 prepare-push.ts 里写死的（check . / -b 加 ci-plan 给的项目目录），不含用户输入，shell 起 .cmd 安全
    const r = win
      ? spawnSync([`"${p}"`, ...args].join(' '), {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          shell: true,
        })
      : spawnSync(p, [...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  },
});

for (const line of result.lines) (result.code === 0 ? console.log : console.error)(line);
if (result.code === 1) {
  console.error('没推：改完再推（这几样 CI 上一定会跑，本机先跑掉了）。');
} else if (result.code === 2) {
  console.error(
    '没查成，按拒推处理：先 pnpm install、确认 origin/main 在，再推一次。别用 --no-verify 硬推。',
  );
}
process.exitCode = result.code;
