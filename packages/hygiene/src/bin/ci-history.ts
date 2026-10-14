// CI 里按提交扫一段历史的入口：node <代码来源>/packages/hygiene/src/bin/ci-history.ts --base <版本号> --head <版本号>
// 调用方 .github/workflows/ci.yml 从主线（trusted/）那份代码跑，cwd 由工作流的
// working-directory 定到有完整提交历史的检出目录；判定在 ../ci-history.ts。
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { ciHistoryCheck } from '../ci-history.ts';
import type { GitSync } from '../prepush.ts';

const USAGE = '用法：ci-history.ts --base <版本号> --head <版本号>';

// 退出不用 process.exit（Windows 上偶发崩成 3221226505，见 packages/conventions/src/exit.ts）：设 exitCode、自然退出。
/** 读参数；不对时报一句、回 undefined。 */
function readArgs(): { base: string; head: string } | undefined {
  let values: { base?: string; head?: string };
  try {
    values = parseArgs({
      options: { base: { type: 'string' }, head: { type: 'string' } },
      strict: true,
    }).values;
  } catch (e) {
    console.error(`参数不对（${e instanceof Error ? e.message : String(e)}）。${USAGE}`);
    return undefined;
  }
  if (!values.base || !values.head) {
    console.error(`缺 --base 或 --head。${USAGE}`);
    return undefined;
  }
  return { base: values.base, head: values.head };
}

const git: GitSync = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? '') };
};

const range = readArgs();
if (range === undefined) {
  process.exitCode = 2;
} else {
  const { code, lines } = ciHistoryCheck({ git, ...range });
  for (const line of lines) (code === 0 ? console.log : console.error)(line);
  process.exitCode = code;
}
