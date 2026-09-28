// 帅位报进度：写到法国库，驾驶舱首页订阅。不写本机 progress.json。
// 写成功后如果本机页没开，拉起来——页面上只写「进度搬到驾驶舱了」，不当账本。
// FLEET_PROGRESS_AUTOSTART=0 不拉（测试里用）。
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoardCli } from './board-cli.mjs';
import { ensureServer, parsePort } from './progress-lib.mjs';

function run(bin, args, input, timeout) {
  const r = spawnSync(bin, args, { input, encoding: 'utf8', timeout, windowsHide: true });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error?.code ?? r.error?.message,
  };
}

const argv = process.argv.slice(2);
const code = await runBoardCli(argv, {
  home: homedir(),
  env: process.env,
  now: () => new Date(),
  readText: (file) => readFileSync(file, 'utf8'),
  ssh: (args, input) => run('ssh', args, input, 90_000),
  gh: (args) => run('gh', args, undefined, 60_000),
  out: (text) => console.log(text),
  err: (text) => console.error(text),
});
process.exitCode = code;

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
  if (r.state === 'started') console.log(`说明页没开着，已经拉起来了：http://127.0.0.1:${port}`);
  if (r.state === 'failed') {
    console.error(`进度已经报到驾驶舱，但说明页没拉起来：${r.why}`);
    process.exitCode = 2;
  }
}
