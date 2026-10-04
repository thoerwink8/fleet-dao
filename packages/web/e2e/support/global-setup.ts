// Playwright 的全局准备：起整套真环境，把地址和编号经环境变量交给工作进程；全部跑完（或中途退出）时收掉。
// 调用例时想省掉每次起环境的一分多钟：另开一个终端跑 `pnpm e2e:serve`（它把环境信息写到 _tmp/e2e/stack.json），
// 再用 E2E_REUSE=1 跑 playwright——这时不起也不收环境；改库的用例只能跑一次，要重跑得重启 e2e:serve（它每次都重建库）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT_DIR, type StackEnv, startStack } from './stack.ts';

export const STACK_FILE = join(OUT_DIR, 'stack.json');

export default async function globalSetup(): Promise<(() => void) | undefined> {
  if (process.env.E2E_REUSE === '1') {
    let env: StackEnv;
    try {
      env = JSON.parse(readFileSync(STACK_FILE, 'utf8')) as StackEnv;
    } catch (err) {
      throw new Error(
        `E2E_REUSE=1 但读不到 ${STACK_FILE}（先在另一个终端跑 pnpm e2e:serve）：${String(err)}`,
      );
    }
    process.env.E2E_STACK = JSON.stringify(env);
    process.env.E2E_BASE_URL = env.webOrigin;
    return undefined;
  }
  const stack = await startStack();
  process.env.E2E_STACK = JSON.stringify(stack.env);
  // 浏览器的 baseURL 以起好的前端地址为准（端口可能被环境变量改过）。
  process.env.E2E_BASE_URL = stack.env.webOrigin;
  return () => stack.stop();
}
