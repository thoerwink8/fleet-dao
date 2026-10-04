// 只起整套真环境、不跑用例，留着手动看（`pnpm --filter @fleet-dao/web e2e:serve`）：打印地址和登录用的账密，Ctrl+C 收掉。
// 环境信息写到 _tmp/e2e/stack.json，配合 `E2E_REUSE=1 pnpm e2e` 反复跑用例而不用每次重起环境（global-setup.ts）。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { STACK_FILE } from './global-setup.ts';
import { OUT_DIR, startStack } from './stack.ts';

const stack = await startStack();
const { webOrigin, apiOrigin, controlOrigin, facts } = stack.env;
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(STACK_FILE, JSON.stringify(stack.env));
console.log(`驾驶舱：${webOrigin}/login  账号 ${facts.username}  密码 ${facts.password}`);
console.log(`后端（经开关代理）：${apiOrigin}  开关：POST ${controlOrigin}/mode/<up|down|error>`);
console.log(`库：${facts.dbUrl.replace(/:[^:@/]*@/, ':***@')}`);
const bye = () => {
  rmSync(STACK_FILE, { force: true });
  stack.stop();
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
setInterval(() => {}, 1 << 30);
