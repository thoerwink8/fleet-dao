// 读飞书里的意图：pnpm intents [list] [--all] [--json] | show <号>（见 ../intents.ts）。
// 退出码：0 读成了；1 读不到；2 参数不对或没配登法国的 ssh。用 exitCode 不用 process.exit：输出接到管道时 exit 会截掉没写完的。
import { realIo, runIntents } from '../intents.ts';

const r = await runIntents(process.argv.slice(2), realIo());
if (r.stdout) console.log(r.stdout);
if (r.stderr) console.error(r.stderr);
process.exitCode = r.code;
