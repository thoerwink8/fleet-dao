// 验证「脱离会话」的起法真的躲得过会话被掐：在一个新建的 kill-on-close Job Object 里起一个子进程（模拟 Mirasim 的会话），
// 由它用被测的起法起一个长跑进程（每 0.5 秒往标记文件追加一个点），然后掐掉整个会话，看标记文件还在不在长。
// 起因：2026-10-06 两个过夜工人（Start-Process 起的）在创始人发新消息、会话被掐的那一刻一起死了。
//
// 用法（只在 Windows 上；会起一个几秒的 node 长跑进程，验完自己杀、删临时目录）：
//   node detach-job-check.mjs [--method new|old|both] [--kill job|tree|both]
//     new  现在的起法（spawn-detached.mjs 的 spawnDetached：launch-detached.ps1 里 Win32_Process.Create）
//     old  对照：修之前的起法（Start-Process，下面 LEGACY_PS1 是它的最小等价写法）
//   job  掐法一：关掉整个 Job Object（kill-on-close）；tree  掐法二：taskkill /T /F 整棵树
// 退出码：new 的每一项都活着、old 在 job 这一项死了才是 0（old 在 job 这项不死说明验证没有区分力，一样算失败）。
// old + tree 只报告不判：Start-Process 的启动器 powershell 起完就退出，父子链在它那断了，taskkill /T 顺不到工人，
// 所以旧做法躲得过 tree、躲不过 job——Mirasim 掐会话走的是 job 那条（10-06 两个工人都死在这）。
// 内部用：--child <new|old> <临时目录>（被 detach-job-check.ps1 在 Job 里起，不是给人用的）。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnDetached } from './spawn-detached.mjs';
import { windowsCmdLine } from './windows-quote.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const HARNESS = join(HERE, 'detach-job-check.ps1');
const SELF = fileURLToPath(import.meta.url);

/** 修之前的起法（Start-Process，起来的进程仍在调用者的 Job 和进程树里）的最小等价写法，只拿来做对照。 */
const LEGACY_PS1 = `param([string]$Spec,[string]$Result)
$cfg = Get-Content -Raw -Path $Spec | ConvertFrom-Json
$p = Start-Process -FilePath $cfg.command -ArgumentList $cfg.argumentLine -WorkingDirectory $cfg.cwd -WindowStyle Hidden -RedirectStandardOutput $cfg.outFile -RedirectStandardError $cfg.errFile -PassThru
[System.IO.File]::WriteAllText($Result, (@{ pid = $p.Id; error = $null } | ConvertTo-Json -Compress))
`;

/** 长跑进程：每 0.5 秒往标记文件追加一个点。 */
const TICKER = "setInterval(()=>require('fs').appendFileSync(process.argv[1],'.'),500)";

function child(method, dir) {
  const marker = join(dir, 'marker.txt');
  const args = ['-e', TICKER, marker];
  if (method === 'new') {
    spawnDetached(
      {
        command: process.execPath,
        args,
        cwd: dir,
        env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? 'C:\\Windows' },
        stdinFile: null,
        outFile: join(dir, 'out.log'),
        errFile: join(dir, 'err.log'),
      },
      {},
    );
  } else {
    const ps1 = join(dir, 'legacy.ps1');
    writeFileSync(ps1, LEGACY_PS1);
    const spec = join(dir, 'launch-spec.json');
    writeFileSync(
      spec,
      JSON.stringify({
        command: 'cmd.exe',
        argumentLine: ['/d', '/s', '/c', windowsCmdLine(process.execPath, args)].join(' '),
        cwd: dir,
        outFile: join(dir, 'out.log'),
        errFile: join(dir, 'err.log'),
      }),
    );
    const r = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        ps1,
        '-Spec',
        spec,
        '-Result',
        join(dir, 'launch-result.json'),
      ],
      { stdio: 'ignore', windowsHide: true, timeout: 30_000 },
    );
    if (r.status !== 0) process.exit(3);
  }
  // 模拟「会话」：起完之后留在这，直到被掐
  setInterval(() => {}, 1000);
}

function runOne(method, kill) {
  const dir = mkdtempSync(join(tmpdir(), 'detach-check-'));
  try {
    const r = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        HARNESS,
        '-ChildExe',
        process.execPath,
        '-ChildArgs',
        `"${SELF}" --child ${method} "${dir}"`,
        '-ResultFile',
        join(dir, 'launch-result.json'),
        '-Marker',
        join(dir, 'marker.txt'),
        '-Kill',
        kill,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 120_000 },
    );
    const line = (r.stdout ?? '').trim().split(/\r?\n/).at(-1) ?? '';
    try {
      return { method, ...JSON.parse(line) };
    } catch {
      return {
        method,
        kill,
        error: `harness failed: status=${r.status} ${(r.stderr ?? '').trim().slice(0, 300)}`,
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--child') return child(argv[1], argv[2]);
  const opt = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const methods = opt('method', 'both') === 'both' ? ['old', 'new'] : [opt('method', 'both')];
  const kills = opt('kill', 'both') === 'both' ? ['job', 'tree'] : [opt('kill', 'both')];
  let bad = 0;
  for (const method of methods) {
    for (const kill of kills) {
      const r = runOne(method, kill);
      console.log(JSON.stringify(r));
      const survived = r.workerSurvived === true;
      if (r.error) bad++;
      else if (method === 'new' ? !survived : kill === 'job' && survived) bad++;
    }
  }
  console.log(bad === 0 ? 'OK: new survives, old dies' : `FAIL: ${bad} unexpected result(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

main();
