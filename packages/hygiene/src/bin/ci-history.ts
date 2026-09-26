// CI 里按提交扫一段历史的入口：node <代码来源>/packages/hygiene/src/bin/ci-history.ts --base <版本号> --head <版本号>
// 两处调用（.github/workflows/ci.yml、hygiene-push.yml）都从主线（trusted/）那份代码跑，cwd 由工作流的
// working-directory 定到有完整提交历史的检出目录；判定在 ../ci-history.ts。
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { ciHistoryCheck } from '../ci-history.ts';
import type { GitSync } from '../prepush.ts';
import { loadSensitiveValues } from '../values.ts';

const USAGE = '用法：ci-history.ts --base <版本号> --head <版本号>';

let base = '';
let head = '';
try {
  const { values } = parseArgs({
    options: { base: { type: 'string' }, head: { type: 'string' } },
    strict: true,
  });
  base = values.base ?? '';
  head = values.head ?? '';
} catch (e) {
  console.error(`参数不对（${e instanceof Error ? e.message : String(e)}）。${USAGE}`);
  process.exit(2);
}
if (!base || !head) {
  console.error(`缺 --base 或 --head。${USAGE}`);
  process.exit(2);
}

const git: GitSync = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? '') };
};

const { code, lines } = ciHistoryCheck({ git, base, head, values: loadSensitiveValues() });
for (const line of lines) (code === 0 ? console.log : console.error)(line);
process.exitCode = code;
