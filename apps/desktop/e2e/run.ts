// 桌面外壳的端到端核对（Windows）：真起装好的外壳，用 WebDriver（tauri-driver + msedgedriver）驱动它的窗口。
//   0. 托盘和开机自启：`fleet-desktop.exe --selftest <文件>`（托盘建得起来、自启能开能关、关回原样）
//   1. 起外壳，等窗口导航到内核的页面（健康检查通了才会导航）
//   2. 五块导航（会话、任务、待我、宿主、设置）都在、点得通
//   3. 页面调不了外壳：试几个 Tauri 命令，都被拒（没有暴露给页面的命令）
//   4. 1440 和 390 宽的截图
//   5. 单实例：再起一份，它自己退出，原来那份和内核都还在
//   6. 强杀外壳，2 秒内内核进程号不在
// 用法：node apps/desktop/e2e/run.ts --app <fleet-desktop.exe> --tauri-driver <exe> --edge-driver <msedgedriver.exe> [--shots <目录>]
// 数据目录用临时目录（FLEET2_DATA_DIR），不碰用户真实的 %LOCALAPPDATA%\Fleet2。任何一步不成就退出码 1。
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const need = (name: string): string => {
  const v = arg(name);
  if (!v) throw new Error(`缺 --${name}`);
  return resolve(v);
};
const appExe = need('app');
const tauriDriver = need('tauri-driver');
const edgeDriver = need('edge-driver');
const shots = resolve(arg('shots') ?? join(tmpdir(), 'fleet2-e2e-shots'));
mkdirSync(shots, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'fleet2-e2e-data-'));
process.env.FLEET2_DATA_DIR = dataDir; // 外壳起内核时原样继承

const NAV = [
  { path: '/', label: '会话' },
  { path: '/work', label: '任务' },
  { path: '/inbox', label: '待我' },
  { path: '/hosts', label: '宿主' },
  { path: '/settings', label: '设置' },
];

const results: { step: string; ok: boolean; detail?: unknown }[] = [];
function record(step: string, ok: boolean, detail?: unknown): void {
  results.push({ step, ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? '通过' : '不过'}  ${step}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ps(script: string): string {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  }).trim();
}
/** 命令行里带 needle 的进程号（用 CIM 读命令行，Get-Process 读不到）。 */
function pidsWith(needle: string, name: string): number[] {
  const out = ps(
    `Get-CimInstance Win32_Process -Filter "Name='${name}'" | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { $_.ProcessId }`,
  );
  return out === '' ? [] : out.split(/\s+/).map(Number);
}
/** 进程还在不在：signal 0 只探测不发信号，进程号不存在抛 ESRCH（比起 powershell 快两个数量级，量 2 秒线要这个精度）。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
const quiet = (script: string): void => {
  try {
    ps(script);
  } catch {
    // 没有要收的进程时 Stop-Process 会报错，当没事
  }
};

// ---- 0. 托盘和开机自启 ----
{
  const out = join(dataDir, 'selftest.json');
  const r = spawn(appExe, ['--selftest', out], { stdio: 'ignore' });
  const code = await new Promise<number | null>((done) => {
    const t = setTimeout(() => {
      r.kill();
      done(null);
    }, 60_000);
    r.on('exit', (c) => {
      clearTimeout(t);
      done(c);
    });
  });
  const body = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>) : null;
  record(
    '托盘建得起来、开机自启能开能关且关回原样',
    code === 0 && body?.ok === true && body?.autostartRestored === true,
    {
      exit: code,
      ...body,
    },
  );
}

// ---- WebDriver 会话 ----
const driver: ChildProcess = spawn(tauriDriver, ['--native-driver', edgeDriver], { stdio: 'inherit' });
let base = 'http://127.0.0.1:4444';
async function wd<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const j = (await r.json()) as { value?: unknown };
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j.value)}`);
  return j.value as T;
}
let sid = '';
const s = (p: string) => `/session/${sid}${p}`;
const exec = <T>(script: string, args: unknown[] = []) => wd<T>('POST', s('/execute/sync'), { script, args });

let exitCode = 0;
let driver2: ChildProcess | undefined;
let shellPid = 0;
let kernelPids: number[] = [];
try {
  for (
    let i = 0;
    i < 50 &&
    !(await fetch(`${base}/status`).then(
      (r) => r.ok,
      () => false,
    ));
    i++
  )
    await sleep(200);
  const started = Date.now();
  const created = await wd<{ sessionId: string }>('POST', '/session', {
    capabilities: { alwaysMatch: { 'tauri:options': { application: appExe }, browserName: 'wry' } },
  });
  sid = created.sessionId;

  // ---- 1. 等窗口导航到内核页面 ----
  let url = '';
  for (let i = 0; i < 240; i++) {
    url = await wd<string>('GET', s('/url')).catch(() => '');
    if (url.startsWith('http://127.0.0.1:') && !url.includes('/local-login')) break;
    await sleep(250);
  }
  const navigated = url.startsWith('http://127.0.0.1:');
  record('窗口开到了内核的页面', navigated, { url, ms: Date.now() - started });
  if (!navigated) throw new Error('窗口没有导航到内核页面');
  shellPid = pidsWith('fleet-desktop', 'fleet-desktop.exe')[0] ?? 0;
  kernelPids = pidsWith('kernel.mjs', 'node.exe');
  record('一个外壳进程、一个内核进程', shellPid > 0 && kernelPids.length === 1, { shellPid, kernelPids });

  // ---- 2. 五块导航 ----
  await wd('POST', s('/window/rect'), { width: 1440, height: 900, x: 0, y: 0 });
  await sleep(500);
  const hrefs = await exec<string[]>(
    "return [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href'))",
  );
  const missing = NAV.filter((n) => !hrefs.includes(n.path)).map((n) => n.label);
  record('五块导航都在', missing.length === 0, { missing, hrefs: [...new Set(hrefs)] });
  for (const n of NAV) {
    const clicked = await exec<boolean>(
      `const a=[...document.querySelectorAll('a[href]')].find(a=>a.getAttribute('href')===arguments[0] && a.offsetParent!==null); if(!a) return false; a.click(); return true`,
      [n.path],
    );
    await sleep(400);
    const at = await exec<string>('return location.pathname');
    const bodyLen = await exec<number>('return document.body.innerText.length');
    record(`点「${n.label}」到 ${n.path}`, clicked && at === n.path && bodyLen > 0, { at, bodyLen });
    await wd('GET', s('/screenshot')).then((b64) =>
      writeFileSync(join(shots, `1440-${n.label}.png`), Buffer.from(b64 as string, 'base64')),
    );
  }

  // ---- 3. 页面调不了外壳 ----
  const probes = [
    'plugin:autostart|is_enabled',
    'plugin:autostart|enable',
    'plugin:app|version',
    'plugin:window|close',
  ];
  const verdicts = await wd<string[]>('POST', s('/execute/async'), {
    script: `const done=arguments[arguments.length-1]; const t=window.__TAURI_INTERNALS__; if(!t||!t.invoke) return done(arguments[0].map(()=>'没有桥')); Promise.all(arguments[0].map(c=>t.invoke(c).then(()=>'放行了',()=> '被拒'))).then(done)`,
    args: [probes],
  });
  record(
    '页面调不了任何外壳命令',
    verdicts.every((v) => v !== '放行了'),
    Object.fromEntries(probes.map((p, i) => [p, verdicts[i]])),
  );

  // ---- 4. 窄屏截图 ----
  await wd('POST', s('/window/rect'), { width: 390, height: 844, x: 0, y: 0 });
  await sleep(600);
  await exec('history.pushState({}, "", "/"); window.dispatchEvent(new PopStateEvent("popstate"))');
  await sleep(300);
  for (const [name, path] of [
    ['会话', '/'],
    ['设置', '/settings'],
  ] as const) {
    await exec(
      'history.pushState({}, "", arguments[0]); window.dispatchEvent(new PopStateEvent("popstate"))',
      [path],
    );
    await sleep(400);
    const b64 = await wd<string>('GET', s('/screenshot'));
    writeFileSync(join(shots, `390-${name}.png`), Buffer.from(b64, 'base64'));
  }
  const narrow = await exec<{ w: number; overflow: boolean }>(
    'return { w: window.innerWidth, overflow: document.documentElement.scrollWidth > window.innerWidth }',
  );
  record('窄屏（390）没有横向溢出', narrow.w <= 400 && !narrow.overflow, narrow);

  // ---- 5. 单实例 ----
  const second = spawn(appExe, [], { stdio: 'ignore' });
  const secondExit = await new Promise<number | null>((done) => {
    const t = setTimeout(() => {
      second.kill();
      done(null);
    }, 15_000);
    second.on('exit', (c) => {
      clearTimeout(t);
      done(c);
    });
  });
  const shellsAfter = pidsWith('fleet-desktop', 'fleet-desktop.exe');
  const kernelsAfter = pidsWith('kernel.mjs', 'node.exe');
  record(
    '再起一份会自己退出，原来的外壳和内核都还在',
    secondExit !== null &&
      shellsAfter.includes(shellPid) &&
      kernelsAfter.length === 1 &&
      kernelsAfter[0] === kernelPids[0],
    { secondExit, shellsAfter, kernelsAfter },
  );

  // ---- 6. 强杀外壳，2 秒内内核不在 ----
  execFileSync('taskkill', ['/F', '/PID', String(shellPid)], { stdio: 'ignore' });
  const killedAt = Date.now();
  let goneMs = -1;
  for (let i = 0; i < 1000; i++) {
    if (kernelPids.every((p) => !alive(p))) {
      goneMs = Date.now() - killedAt;
      break;
    }
    if (Date.now() - killedAt > 8000) break;
    await sleep(10);
  }
  record('强杀外壳后 2 秒内内核进程不在', goneMs >= 0 && goneMs <= 2000, { kernelPids, goneMs });

  // ---- 7. 连远端内核：外壳不起自己的内核，窗口开到给定的地址 ----
  // 「远端」这里是另起的一个内核（不是外壳的附带进程），口 17400；外壳只该探它、开它。
  const installDir = join(appExe, '..');
  const remotePort = 17_400;
  const remote = spawn(join(installDir, 'kernel', 'node.exe'), [join(installDir, 'kernel', 'kernel.mjs')], {
    stdio: 'ignore',
    env: {
      ...process.env,
      FLEET2_PROFILE: 'local',
      FLEET2_WEB_DIST: join(installDir, 'web'),
      FLEET2_UI_PORT: String(remotePort),
      FLEET2_DATA_DIR: join(dataDir, 'remote'),
    },
  });
  try {
    const remoteUrl = `http://127.0.0.1:${remotePort}`;
    for (
      let i = 0;
      i < 200 &&
      !(await fetch(`${remoteUrl}/health`).then(
        (r) => r.ok,
        () => false,
      ));
      i++
    )
      await sleep(250);
    // 地址经环境变量 FLEET2_REMOTE_URL 交给外壳（tauri-driver 不转交命令行参数）：另起一个 tauri-driver，环境里带它
    driver.kill();
    driver2 = spawn(tauriDriver, ['--native-driver', edgeDriver, '--port', '4445', '--native-port', '4446'], {
      stdio: 'inherit',
      env: { ...process.env, FLEET2_REMOTE_URL: remoteUrl },
    });
    base = 'http://127.0.0.1:4445';
    for (
      let i = 0;
      i < 50 &&
      !(await fetch(`${base}/status`).then(
        (r) => r.ok,
        () => false,
      ));
      i++
    )
      await sleep(200);
    const again = await wd<{ sessionId: string }>('POST', '/session', {
      capabilities: { alwaysMatch: { 'tauri:options': { application: appExe }, browserName: 'wry' } },
    });
    sid = again.sessionId;
    let at = '';
    for (let i = 0; i < 120; i++) {
      at = await wd<string>('GET', s('/url')).catch(() => '');
      if (at.startsWith(remoteUrl)) break;
      await sleep(250);
    }
    const kernels = pidsWith('kernel.mjs', 'node.exe');
    const ownKernel = kernels.filter((p) => p !== remote.pid);
    record('连远端：窗口开到给定地址，外壳没有另起内核', at.startsWith(remoteUrl) && ownKernel.length === 0, {
      at,
      kernels,
      remotePid: remote.pid,
    });
  } finally {
    remote.kill();
    quiet('Get-Process fleet-desktop -ErrorAction SilentlyContinue | Stop-Process -Force');
  }
} catch (e) {
  record('跑到一半出错', false, e instanceof Error ? e.message : String(e));
} finally {
  driver.kill();
  driver2?.kill();
  // 没收好的残留：只收这次用的安装目录里起的
  for (const p of pidsWith('kernel.mjs', 'node.exe')) quiet(`Stop-Process -Id ${p} -Force`);
  quiet(
    'Get-Process fleet-desktop,msedgedriver,tauri-driver -ErrorAction SilentlyContinue | Stop-Process -Force',
  );
  rmSync(dataDir, { recursive: true, force: true });
  exitCode = results.every((r) => r.ok) ? 0 : 1;
  writeFileSync(join(shots, 'e2e-result.json'), JSON.stringify(results, null, 2));
  console.log(exitCode === 0 ? '全部通过' : '有不过的');
}
process.exit(exitCode);
