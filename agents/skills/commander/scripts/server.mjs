// 起帅位本机进度页：node server.mjs [--port <端口>]（也认 FLEET_PROGRESS_PORT，默认 1127）。只听 127.0.0.1，一台机器一个，
// 所有项目都在里面；/france 是法国引擎页（#328，页面开着时每 30 秒左右经 ssh 从法国只读地读一次）。
// 已经在跑就说一声退出（退出码 0），开场可以放心重复跑。逻辑都在 progress-lib.mjs、france-lib.mjs。
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFranceSource, franceFetcher } from './france-lib.mjs';
import { parsePort, startServer } from './progress-lib.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const HTML = join(DIR, 'index.html');
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
  const { code } = await startServer({
    port,
    home,
    htmlFile: HTML,
    france,
    out: (text) => console.log(text),
    err: (text) => console.error(text),
  });
  process.exitCode = code;
}
