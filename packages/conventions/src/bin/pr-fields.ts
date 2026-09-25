// CI 的 pr-fields 检查入口（.github/workflows/pr.yml）：node packages/conventions/src/bin/pr-fields.ts
// 读 GitHub 发来的这次 pull_request 事件（GITHUB_EVENT_PATH），对着检出来的 docs/plan.md、specs/ 查；不用装依赖。
// 退出码 0 = 都齐了；1 = 缺了（每样一句话）；2 = 没查成（事件读不到、不是 PR 事件、plan.md 读不到），同样是红。
import { fileURLToPath } from 'node:url';
import { annotation, runPrFields } from '../pr-fields.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const { code, lines } = runPrFields({ eventPath: process.env.GITHUB_EVENT_PATH, root });
const inActions = process.env.GITHUB_ACTIONS === 'true';
for (const line of lines) {
  if (code === 0) console.log(line);
  else console.error(inActions ? annotation(line) : line);
}
process.exitCode = code;
