// 起本机的法国引擎页（#328）：node server.mjs [--port <端口>]（也认 FLEET_PROGRESS_PORT，默认 1127），打开 /france。
// 只听 127.0.0.1，一台机器一个；页面开着时每 30 秒左右经 ssh 从法国只读地读一次。
// 已经在跑就说一声退出（退出码 0），可以放心重复跑。逻辑都在 france-lib.mjs。
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFranceSource, franceFetcher, parsePort, startFranceServer } from './france-lib.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const home = homedir();
// 当前目录挪到家目录：Windows 上删不掉「某个进程的当前目录」，留在技能目录里，agents-sync 更新这个技能时就换不掉它。
process.chdir(home);

const port = parsePort(process.argv.slice(2), process.env);
if (typeof port === 'string') {
  console.error(port);
  process.exitCode = 1;
} else {
  const france = createFranceSource({
    htmlFile: join(DIR, 'france.html'),
    fetchOnce: franceFetcher({ home, env: process.env, scriptFile: join(DIR, 'france-query.mjs') }),
  });
  const { code } = await startFranceServer({
    port,
    france,
    out: (text) => console.log(text),
    err: (text) => console.error(text),
  });
  process.exitCode = code;
}
