// 全仓卫生检查的命令行入口，接在 pnpm check 里：node packages/hygiene/src/bin/check.ts
// 退出码 0 = 扫了、没查出东西；1 = 查出了；2 = 没扫全（没扫到文件、已知敏感值名单没读到……不算干净）。
import { fileURLToPath } from 'node:url';
import { runCheck } from '../check.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const { code, lines } = runCheck({ root, mustInclude: 'packages/hygiene/src/rules.ts' });
for (const line of lines) (code === 0 ? console.log : console.error)(line);
process.exitCode = code;
