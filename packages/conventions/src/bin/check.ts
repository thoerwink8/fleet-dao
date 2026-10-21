// pnpm check 的入口：biome + tsc -b + 改到的测试 + 卫生检查 + 方案索引核对，五样都跑完再判红；--all 才全量 vitest run（判法见 ../check.ts）。
//   pnpm check [--all]
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, type Step } from '../check.ts';
import { vitestAllStep } from '../check-vitest.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

/** 用当前 node 跑仓里装的脚本，子进程输出直通终端。 */
function node(name: string, script: string, args: string[]): Step {
  return {
    name,
    run() {
      const r = spawnSync(process.execPath, [join(root, script), ...args], { cwd: root, stdio: 'inherit' });
      return { status: r.status, signal: r.signal, error: r.error };
    },
  };
}

/**
 * 全量 vitest：default 和 json 两个 reporter 同时开（终端输出不变，json 写进临时文件）。首轮红了，按 json 里失败的文件单独重跑一次，
 * 重跑仍红才算红（withRetry）。vitest 起不来、崩了没写结果时读不出失败清单，原样红。
 */
const code = check({
  argv: process.argv.slice(2),
  steps: (all) => [
    { step: node('格式（biome）', 'node_modules/@biomejs/biome/bin/biome', ['check', '.']) },
    { step: node('类型（tsc -b）', 'node_modules/typescript/bin/tsc', ['-b']) },
    all
      ? { step: vitestAllStep(root) }
      : {
          // test:changed：2 = 没算出改到什么（origin/main 读不到、git 没成），3 = 判出要全跑、本机拒跑；都不是「没有要跑的」。
          step: node('测试（改到的，相对 origin/main）', 'packages/conventions/src/bin/test-changed.ts', []),
          notRunCodes: [2, 3],
        },
    { step: node('卫生检查', 'packages/hygiene/src/bin/check.ts', []) },
    // specs:index --check：1 = 头部不对或索引没重新生成，2 = 读不到 specs/（没查成）。
    {
      step: node('方案索引（pnpm specs:index --check）', 'packages/conventions/src/bin/specs-index.ts', [
        '--check',
      ]),
      notRunCodes: [2],
    },
  ],
  now: () => Date.now(),
  out: (l) => console.log(l),
  err: (l) => console.error(l),
});
process.exitCode = code;
