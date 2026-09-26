// 改帅位本机进度页的数据：node p.mjs <项目> <命令> [参数…]；不带参数看用法。逻辑都在 progress-lib.mjs。
// 写完顺手看页面服务在不在，不在就拉起来（进程退出后没人拉，页面打不开也没人知道）；拉不起来退出码 2、写明原因。
// FLEET_PROGRESS_AUTOSTART=0 不拉（测试里用，免得在临时家目录上起一个常驻的页面）。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureServer, parsePort, runProgressCli } from './progress-lib.mjs';

const argv = process.argv.slice(2);
process.exitCode = runProgressCli(argv, {
  home: homedir(),
  now: () => new Date(),
  readText: (file) => readFileSync(file, 'utf8'),
  out: (text) => console.log(text),
  err: (text) => console.error(text),
});

const port = parsePort([], process.env);
const autostart = process.env.FLEET_PROGRESS_AUTOSTART !== '0';
if (autostart && process.exitCode === 0 && argv.length >= 2 && typeof port === 'number') {
  const server = join(dirname(fileURLToPath(import.meta.url)), 'server.mjs');
  const r = await ensureServer({
    port,
    launch: () => {
      const child = spawn(process.execPath, [server, '--port', String(port)], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    },
  });
  if (r.state === 'started') console.log(`进度页没开着，已经拉起来了：http://127.0.0.1:${port}`);
  if (r.state === 'failed') {
    console.error(`进度写好了，但进度页没开着、也没拉起来：${r.why}`);
    process.exitCode = 2;
  }
}
