// 开单脚本入口：pnpm issue:new --kind 需求 --milestone v1 --title "…" --body-file 正文.md [--specs 短名] [--mother] [--parent 母单号]（见 ../issue-new.ts）
import { fileURLToPath } from 'node:url';
import { ghRunner, issueNew, specsHint } from '../issue-new.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
try {
  const r = await issueNew(process.argv.slice(2), {
    gh: ghRunner(root),
    root,
    cwd: process.env.INIT_CWD || process.cwd(),
  });
  console.log(
    `开了 #${r.number}（${r.milestone}${r.parent === undefined ? '' : `，挂在母单 #${r.parent} 下面`}）：${r.url}`,
  );
  if (r.specsFile) console.log(`需求文档：${r.specsFile}（${specsHint(r.milestone)}）`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
