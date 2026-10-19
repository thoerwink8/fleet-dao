// 合并时收口入口（见 ../close-on-merge.ts）：node packages/conventions/src/bin/close-on-merge.ts --pr <号>
// 只给 .github/workflows/close-on-merge.yml 用，也能手跑补收一张已合并的 PR。
// 退出码 0 = 收完了（该关的关了、不该碰的列了原因）；1 = 参数不对；2 = 没查成、没关成（读不到 GitHub、关单报错、回读对不上）。
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { closeOnMerge } from '../close-on-merge.ts';
import { closeOnMergeGh } from '../close-on-merge-gh.ts';
import { exitWith, runMain } from '../exit.ts';
import { ghRunner } from '../issue-new.ts';

// 退出不用 process.exit（Windows 上偶发崩成 3221226505，../exit.ts）：提前退出用 exitWith，runMain 接住设退出码。
runMain(async () => {
  const USAGE = '用法：close-on-merge.ts --pr <PR 号>';
  const root = fileURLToPath(new URL('../../../../', import.meta.url));

  let pr: number;
  try {
    const { values } = parseArgs({ options: { pr: { type: 'string' } }, strict: true });
    pr = Number(values.pr);
    if (!Number.isSafeInteger(pr) || pr <= 0)
      throw new Error(`--pr 要给 PR 号（读到：${values.pr ?? '没给'}）`);
  } catch (e) {
    console.error(`参数不对（${e instanceof Error ? e.message : String(e)}）。${USAGE}`);
    exitWith(1);
  }

  try {
    const r = await closeOnMerge(pr, { gh: closeOnMergeGh(ghRunner(root)) });
    if (r.note) console.log(r.note);
    for (const o of r.outcomes) {
      console.log(
        o.outcome === 'closed' ? `关了 #${o.number}：${o.evidence}` : `没碰 #${o.number}：${o.why}`,
      );
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  }
  return undefined;
});
