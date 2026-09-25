// CI 的 pr-fields 检查入口（.github/workflows/pr.yml）：node packages/conventions/src/bin/pr-fields.ts
// 从事件（GITHUB_EVENT_PATH）认出是哪个 PR，用 GITHUB_TOKEN 现读它的标签、里程碑、正文，对着检出来的 docs/plan.md、specs/ 查。
// 退出码 0 = 都齐了；1 = 缺了（每样一句话）；2 = 没查成（事件、PR 现在的样子、plan.md 读不到），同样是红。
import { fileURLToPath } from 'node:url';
import { annotation, livePr, runPrFields } from '../pr-fields.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const { code, lines } = await runPrFields({
  eventPath: process.env.GITHUB_EVENT_PATH,
  root,
  fetchPr: livePr(process.env),
});
const inActions = process.env.GITHUB_ACTIONS === 'true';
for (const line of lines) {
  if (code === 0) console.log(line);
  else console.error(inActions ? annotation(line) : line);
}
process.exitCode = code;
