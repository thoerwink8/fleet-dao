// 开单脚本入口：pnpm issue:new --kind 需求 --milestone P1 --title "…" --body-file 正文.md [--specs 短名]（见 ../issue-new.ts）
import { fileURLToPath } from 'node:url';
import { ghRunner, issueNew } from '../issue-new.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
try {
  const r = await issueNew(process.argv.slice(2), {
    gh: ghRunner(root),
    root,
    cwd: process.env.INIT_CWD || process.cwd(),
  });
  console.log(`开了 #${r.number}（${r.milestone}）：${r.url}`);
  if (r.specsFile)
    console.log(`需求文档骨架：${r.specsFile}（「对应计划」的引号里填上 plan.md 那一条再提交）`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
