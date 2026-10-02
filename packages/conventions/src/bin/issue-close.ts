// 关单脚本入口：pnpm issue:close <单号>（见 ../issue-close.ts）。
// 退出码 0 = 关上了（或本来就关着）；1 = 拒关（没有结果文档、子单还开着、是 PR、参数不对）；2 = 没查成、没关成。
import { fileURLToPath } from 'node:url';
import { CloseRefused, issueClose } from '../issue-close.ts';
import { ghRunner } from '../issue-new.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
try {
  const r = await issueClose(process.argv.slice(2), { gh: ghRunner(root) });
  if (r.outcome === 'already') {
    console.log(`#${r.number} 本来就关着（${r.stateReason ?? '没写原因'}），没动：${r.issueUrl}`);
  } else {
    console.log(`关了 #${r.number}：${r.issueUrl}`);
    if (r.resultUrl) console.log(`结果：${r.resultUrl}`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = e instanceof CloseRefused ? 1 : 2;
}
