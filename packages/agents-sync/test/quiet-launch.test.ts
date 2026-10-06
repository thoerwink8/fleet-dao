// Windows：钩子命令是不带控制台的 exe，父进程没有控制台时也不会弹出黑窗口。
// 探测器先故意拉一个看得见标题的 cmd，确认自己真能看见窗口；看不见就不许把「静默」当成通过。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Backups } from '../src/backup.ts';
import { applyHooks } from '../src/hooks.ts';
import { cleanup, ctxFor, makeRepo, PLATFORM, sources, tempDir } from './helpers.ts';

afterEach(cleanup);

const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

/** PE 可选头里的 Subsystem：2 = Windows GUI（不分配控制台），3 = 控制台 */
function peSubsystem(buf: Buffer): number {
  const pe = buf.readUInt32LE(0x3c);
  return buf.readUInt16LE(pe + 24 + 68);
}

const PROBE = `
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class Probe {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  struct STARTUPINFO {
    public int cb; public IntPtr a, b, c; public int d, e, f, g, h; public short i, j; public IntPtr k, l, m, n; public int o, p;
  }
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int pid, tid; }

  const uint CREATE_NEW_CONSOLE = 0x00000010;

  static int Count(string title, bool visibleOnly) {
    int n = 0;
    EnumWindows((h, l) => {
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (sb.ToString() == title && (!visibleOnly || IsWindowVisible(h))) n++;
      return true;
    }, IntPtr.Zero);
    return n;
  }

  static PROCESS_INFORMATION Start(string app, string cmd, uint flags) {
    var si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    if (!CreateProcess(app, cmd, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, null, ref si, out pi))
      throw new Exception("CreateProcess failed " + Marshal.GetLastWin32Error());
    return pi;
  }

  static void Kill(PROCESS_INFORMATION pi) {
    TerminateProcess(pi.hProcess, 1);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
  }

  static int Main(string[] args) {
    string result = args[0];
    string quietExe = args[1];
    string id = args[2];
    string visTitle = "FQVIS" + id;
    string quietTitle = "FQQ" + id;
    Environment.SetEnvironmentVariable("FLEET_QUIET_TITLE", quietTitle);
    int visible = 0;
    var cmd = Start(
      "C:\\\\Windows\\\\System32\\\\cmd.exe",
      "C:\\\\Windows\\\\System32\\\\cmd.exe /d /s /c \\"title " + visTitle + "& ping -n 5 127.0.0.1 >nul\\"",
      CREATE_NEW_CONSOLE);
    var until = Environment.TickCount + 2000;
    while (Environment.TickCount < until) {
      if (Count(visTitle, true) > 0) { visible = 1; break; }
      Thread.Sleep(5);
    }
    Kill(cmd);
    int quiet = 0;
    var child = Start(quietExe, "\\"" + quietExe + "\\"", 0);
    until = Environment.TickCount + 1200;
    while (Environment.TickCount < until) {
      if (Count(quietTitle, false) > 0) { quiet = 1; break; }
      Thread.Sleep(5);
    }
    Kill(child);
    File.WriteAllText(result, "visible=" + visible + "\\nquiet=" + quiet + "\\n");
    return 0;
  }
}
`;

describe('静默启动器不分配控制台', () => {
  it.skipIf(PLATFORM !== 'win32')(
    '父进程没有控制台时，故意拉起的 cmd 看得见，启动器拉起的 node 看不见',
    { timeout: 30_000 },
    () => {
      expect(existsSync(CSC)).toBe(true);
      const home = tempDir('home');
      const lines = applyHooks(
        ctxFor(home, ['claude']),
        sources(makeRepo({})),
        new Backups(home, PLATFORM, new Date('2026-09-26T06:00:00Z')),
      );
      const failed = lines.filter((l) => l.kind === 'failed' || l.kind === 'unknown');
      expect(failed, JSON.stringify(lines)).toEqual([]);
      const exe = join(home, '.fleet-dao', 'bin', 'quiet-pretool.exe');
      expect(existsSync(exe)).toBe(true);
      expect(peSubsystem(readFileSync(exe))).toBe(2);

      writeFileSync(
        join(home, '.fleet-dao', 'hooks', 'pretool.mjs'),
        'process.title = process.env.FLEET_QUIET_TITLE || "missing";\nconst end = Date.now() + 2000;\nwhile (Date.now() < end) {}\n',
      );

      const dir = mkdtempSync(join(tmpdir(), 'quiet-probe-'));
      try {
        const cs = join(dir, 'Probe.cs');
        const probe = join(dir, 'probe.exe');
        const result = join(dir, 'result.txt');
        writeFileSync(cs, PROBE);
        const compiled = spawnSync(CSC, ['/nologo', '/target:winexe', `/out:${probe}`, cs], {
          encoding: 'utf8',
          windowsHide: true,
        });
        expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
        const id = String(process.pid);
        const ran = spawnSync(probe, [result, exe, id], { encoding: 'utf8', windowsHide: true });
        expect(ran.status, ran.stdout + ran.stderr).toBe(0);
        const text = readFileSync(result, 'utf8');
        expect(text).toContain('visible=1');
        expect(text).toContain('quiet=0');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(PLATFORM !== 'win32')('stdin、stdout、stderr 和退出码都交还给调用方', () => {
    const home = tempDir('home');
    applyHooks(
      ctxFor(home, ['claude']),
      sources(makeRepo({})),
      new Backups(home, PLATFORM, new Date('2026-09-26T06:00:00Z')),
    );
    const exe = join(home, '.fleet-dao', 'bin', 'quiet-stop.exe');
    writeFileSync(
      join(home, '.fleet-dao', 'hooks', 'stop.mjs'),
      "let s = ''; process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => { process.stdout.write('OUT' + s); process.stderr.write('ERR' + s); process.exit(7); });\n",
    );
    const ran = spawnSync(exe, { input: 'abc', encoding: 'utf8', windowsHide: true });
    expect(ran.status, ran.stderr).toBe(7);
    expect(ran.stdout).toBe('OUTabc');
    expect(ran.stderr).toBe('ERRabc');
  });
});
