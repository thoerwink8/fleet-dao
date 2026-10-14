// Playwright 的全局准备：前端打包一次（各 worker 的门面共用这份产物）。整套环境（库、后端、门面）由每个 worker 自己起
// （support/fixtures.ts 的 stack 夹具），这里不起。
// 调用例时想省掉每次起环境：另开一个终端跑 `pnpm e2e:serve`（它把环境信息写到 _tmp/e2e/stack.json），
// 再用 E2E_REUSE=1 跑 playwright——这时不打包、不起环境，所有 worker 共用那一套（playwright.config.ts 把 worker 压成 1）；
// 改库的用例只能跑一次，要重跑得重启 e2e:serve（它每次都重建库）。
import { join } from 'node:path';
import { buildWeb, OUT_DIR } from './stack.ts';

export const STACK_FILE = join(OUT_DIR, 'stack.json');

export default function globalSetup(): void {
  if (process.env.E2E_REUSE === '1') return;
  buildWeb();
}
