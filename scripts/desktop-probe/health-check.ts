// 桌面第 0 片实测 ①（#3868）：用打包出的 node.exe + kernel.mjs 起本机内核，30 秒内 /api/local/status 返回 200 则退出码 0。
// 用法：node scripts/desktop-probe/health-check.ts <bundle 目录（里面有 node.exe、kernel.mjs）> [超时秒，默认 30]
// 数据目录和页面目录都放在临时目录里，不碰用户真实的 %LOCALAPPDATA%\Fleet2；端口取 17347。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (!process.argv[2]) {
  console.error('用法：node scripts/desktop-probe/health-check.ts <bundle 目录> [超时秒]');
  process.exit(2);
}
const dir = resolve(process.argv[2]);
const limitMs = Number(process.argv[3] ?? 30) * 1000;
const work = mkdtempSync(join(tmpdir(), 'fleet2-probe-'));
const dist = join(work, 'web');
mkdirSync(dist);
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>probe</title>');
const port = 17347;

const started = Date.now();
const child = spawn(join(dir, 'node.exe'), [join(dir, 'kernel.mjs')], {
  env: {
    ...process.env,
    FLEET2_PROFILE: 'local',
    FLEET2_DATA_DIR: join(work, 'data'),
    FLEET2_WEB_DIST: dist,
    FLEET2_UI_PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let log = '';
child.stdout.on('data', (b) => {
  log += b;
});
child.stderr.on('data', (b) => {
  log += b;
});
let exited: number | null = null;
child.on('exit', (c) => {
  exited = c ?? -1;
});

async function probe(): Promise<number> {
  const tokenFile = join(work, 'data', 'local-token');
  if (!existsSync(tokenFile)) return 0;
  const token = readFileSync(tokenFile, 'utf8').trim();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/local/status`, {
      headers: { 'x-fleet-local-token': token },
    });
    return r.status;
  } catch {
    return 0;
  }
}

let status = 0;
while (Date.now() - started < limitMs && exited === null) {
  status = await probe();
  if (status === 200) break;
  await new Promise((r) => setTimeout(r, 250));
}
const ms = Date.now() - started;
const diedEarly = exited;
if (child.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
rmSync(work, { recursive: true, force: true });

const ok = status === 200;
console.log(JSON.stringify({ ok, status, ms, exitedEarly: diedEarly, limitMs }));
if (!ok) console.error(log.slice(-2000));
process.exit(ok ? 0 : 1);
