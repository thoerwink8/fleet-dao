// pnpm check 的入口：biome + tsc -b + 改到的测试 + 卫生检查 + 方案索引核对，五样都跑完再判红；--all 才全量 vitest run（判法见 ../check.ts）。
//   pnpm check [--all]
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, type Step } from '../check.ts';
import { vitestAllStep } from '../check-vitest.ts';
import { runCheckedChild } from '../step-process.ts';
import { HEAP_MARGIN_MIB, nodeHeapCapMib, realTestRunEnv, withHeapCap } from '../test-run.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

/** 用当前 node 跑仓里装的脚本，子进程输出直通终端。POSIX 上外面还有一层看守，直接子进程先退时把子孙一起收掉。 */
function node(name: string, script: string, args: string[]): Step {
  return {
    name,
    run() {
      return runCheckedChild(process.execPath, [join(root, script), ...args], { cwd: root });
    },
  };
}

/**
 * 类型检查单独封堆：这一步是一个 node，历史峰值大约 1.9G，不走测试进程数。
 * 上限在这一步真的跑的时候算（biome 已经退了，匿名占用才是叠到硬上限上的那份），不是组步骤列表的时候。
 */
function tscStep(): Step {
  return {
    name: '类型（tsc -b）',
    run() {
      const cap = nodeHeapCapMib(realTestRunEnv());
      if (cap !== undefined && cap < 3072) {
        console.error(
          `类型检查把 node 堆封到 ${cap} MiB（本 scope 硬上限减去匿名已用，再留 ${HEAP_MARGIN_MIB} MiB）`,
        );
      }
      return runCheckedChild(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b'], {
        cwd: root,
        env: withHeapCap(process.env, cap),
      });
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
    { step: tscStep() },
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
