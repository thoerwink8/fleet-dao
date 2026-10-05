// Windows 上从 PowerShell / cmd 跑测试时，PATH 里没有 Git 带的 sh、bash 等类 Unix 工具（sh 找不到，bash 找到的是 WSL 的启动器），
// 起 `sh -c`、`bash 脚本`、`find` 的测试整片红（spawn sh ENOENT）；从 Git Bash 里跑 PATH 里就有，同一批测试全绿（2026-10-05 实测：
// engine/test/real 下 user-git、github-ports、hosts、sessions*，conventions/ci-plan，agents/test/pre-push）。
// vitest.config.ts 用这里在 Windows 上把 Git 的 usr\bin 排到 PATH 最前面（和 Git Bash 里的顺序一致，测试就是在那个环境里写的）。
// 改这里之前必须知道：只管 win32；Git 的 usr\bin 排在最前，是因为 Windows 自带的 find、sort 等同名程序会抢在它前面，
// 测试按 Unix 的 find、sort 写。找不到 Git 的 usr\bin 不是错（机器上没装也能跑不需要它的测试），但要打出一句话说明。
import { existsSync } from 'node:fs';
import { delimiter, win32 } from 'node:path';

export interface PosixPathEnv {
  platform: NodeJS.Platform;
  /** PATH 的原文（Windows 上变量名不分大小写，调用方取 process.env.PATH）。 */
  path: string | undefined;
  exists(path: string): boolean;
}

export function realPosixPathEnv(): PosixPathEnv {
  return { platform: process.platform, path: process.env.PATH, exists: existsSync };
}

export interface PosixPathResult {
  /** 要排到 PATH 最前面的目录；undefined 是不用动。 */
  prepend?: string;
  /** 要打出来的一句话。 */
  note?: string;
}

const norm = (p: string): string => p.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();

/** 判断 Windows 上要不要、往 PATH 最前面加哪个目录；别的平台一律不动。 */
export function posixToolsPrepend(env: PosixPathEnv = realPosixPathEnv()): PosixPathResult {
  if (env.platform !== 'win32') return {};
  const entries = (env.path ?? '').split(';').filter((e) => e.trim() !== '');
  const hasSh = (dir: string) => env.exists(win32.join(dir, 'sh.exe'));
  // 已经在 Git Bash 里（PATH 的头一个是 Git 的 usr\bin）：不动
  const first = entries[0];
  if (first !== undefined && norm(first).endsWith('\\usr\\bin') && hasSh(first)) return {};
  for (const entry of entries) {
    if (!env.exists(win32.join(entry, 'git.exe')) && !env.exists(win32.join(entry, 'git.cmd'))) continue;
    for (const rel of [
      ['..', 'usr', 'bin'],
      ['..', '..', 'usr', 'bin'],
    ] as const) {
      const dir = win32.normalize(win32.join(entry, ...rel));
      if (hasSh(dir)) return { prepend: dir };
    }
  }
  return {
    note: 'Windows 上没在 PATH 里找到 Git 带的 sh（Git 目录下的 usr\\bin）：起 sh -c、bash、find 的测试会红（spawn sh ENOENT）；从 Git Bash 里跑，或把它加进 PATH',
  };
}

/** 把结果落到进程环境上（vitest.config.ts 在主进程里调，开出来的测试进程继承）。返回要打的说明。 */
export function applyPosixToolsPath(env: PosixPathEnv = realPosixPathEnv()): string | undefined {
  const r = posixToolsPrepend(env);
  if (r.prepend) process.env.PATH = [r.prepend, process.env.PATH].filter(Boolean).join(delimiter);
  return r.note;
}
