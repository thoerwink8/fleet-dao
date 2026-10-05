// 开会话钩子兜底用（agents/hooks/session-start.mjs）：列出当前 gh 账号开的、检查全绿、没挂自动合并、没碰改标准路径的 PR。
// 在要查的仓里跑（gh 认 cwd 的远端）；两份路径清单读这份脚本所在检出的。
// 输出一行 JSON {"idle":[{"number":1,"title":"…"}]}，退出码 0；gh 没跑成、认不出：stderr 写原因，退出码 2（不冒充「没有」）。
// 只 import 不带第三方依赖的模块：钩子在没装 node_modules 的同步专用检出里跑它。
import { fileURLToPath } from 'node:url';
import { idlePrs, liveGh, loadPathLists } from '../pr-arm.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

try {
  const idle = idlePrs(liveGh(process.cwd(), 6_000), loadPathLists(root));
  console.log(JSON.stringify({ idle }));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 2;
}
