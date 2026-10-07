// Windows 上把钩子登记成「一个没有 shell 元字符的 exe 路径」。
// Grok 见到空格、引号、管道、重定向、$ 就把整条命令交给 cmd，黑窗口跟着出来（~/.grok 的钩子说明：
// bare path with no metachars 才直接 CreateProcess）。exe 是 Windows 子系统，自己不带控制台。
// 家目录里有这些字符时退回原来的 node "脚本"（命令仍能跑，只是还会闪一下），免得拼出 cmd 认不出的裸路径。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHELL_META = /[\s"$&|<>^%!()\n;]/;
const CSC = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
].find((p) => existsSync(p));

let compiled: { sha: string; bytes: Buffer } | null = null;

/** quiet-session-start.exe 跑 session-start.mjs。对不上 .mjs 名字就返回 null */
export function quietExeName(script: string): string | null {
  if (!/^[\w.-]+\.mjs$/.test(script)) return null;
  return `quiet-${script.slice(0, -4)}.exe`;
}

/**
 * 能直接 CreateProcess 的启动器路径（一律 / 分隔、不加引号）。
 * 有 shell 元字符、或不是盘符开头的绝对路径时返回 null，调用方退回 node "脚本"。
 */
export function bareQuietCommand(home: string, script: string): string | null {
  const name = quietExeName(script);
  if (name === null) return null;
  const exe = join(home, '.fleet-dao', 'bin', name).replaceAll('\\', '/');
  if (!/^[A-Za-z]:\//.test(exe) || SHELL_META.test(exe)) return null;
  return exe;
}

/** PE Subsystem：2 是 Windows GUI，不分配控制台 */
export function guiSubsystem(buf: Buffer): boolean {
  if (buf.length < 0x40) return false;
  const pe = buf.readUInt32LE(0x3c);
  if (pe < 0 || pe + 24 + 70 > buf.length) return false;
  return buf.readUInt16LE(pe + 24 + 68) === 2;
}

/** 换启动器用到的几样文件操作：真的用 node:fs，测试里换成假的造出「正被占用」 */
export type ReplaceOps = {
  write: (path: string, bytes: Buffer) => void;
  rename: (from: string, to: string) => void;
  remove: (path: string) => void;
  list: (dir: string) => string[];
};

const realOps: ReplaceOps = {
  write: (p, b) => writeFileSync(p, b),
  rename: (a, b) => renameSync(a, b),
  remove: (p) => rmSync(p, { force: true }),
  list: (d) => readdirSync(d),
};

function errCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined;
}

/**
 * 把启动器写到 dest。钩子一直在跑，Windows 不让覆盖正在运行的 exe（EBUSY / EPERM），但允许改名：
 * 写不进就先把旧的改名成 `<名字>.old-<时间>`，再写新的（还在跑的那个进程照用改名后的文件，不受影响）。
 * 每次先顺手清掉上一次留下的 .old-*（还被占着就留着，下次再清）。别的错原样抛，调用方记没做成。
 */
export function replaceExe(
  dest: string,
  bytes: Buffer,
  ops: ReplaceOps = realOps,
  now = Date.now(),
): 'written' | 'swapped' {
  const dir = dirname(dest);
  const base = basename(dest);
  for (const f of ops.list(dir)) {
    if (!f.startsWith(`${base}.old-`)) continue;
    try {
      ops.remove(join(dir, f));
    } catch {
      // 还在被用：留到下次
    }
  }
  try {
    ops.write(dest, bytes);
    return 'written';
  } catch (err) {
    const c = errCode(err);
    if (c !== 'EBUSY' && c !== 'EPERM') throw err;
  }
  ops.rename(dest, join(dir, `${base}.old-${now}`));
  ops.write(dest, bytes);
  return 'swapped';
}

/** 编一次，进程内按源码哈希复用。源码或 csc 有问题就抛，调用方记没做成 */
export function quietExeBytes(): Buffer {
  const cs = fileURLToPath(new URL('../quiet/QuietHook.cs', import.meta.url));
  const src = readFileSync(cs);
  const sha = createHash('sha256').update(src).digest('hex');
  if (compiled?.sha === sha) return compiled.bytes;
  if (CSC === undefined) throw new Error('没有 csc.exe，编不出不弹窗的启动器');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-quiet-'));
  try {
    const out = join(dir, 'quiet.exe');
    const r = spawnSync(CSC, ['/nologo', '/optimize+', '/target:winexe', `/out:${out}`, cs], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status !== 0) {
      throw new Error(`csc 没编成（${r.status ?? '没启动'}）：${r.stdout ?? ''}${r.stderr ?? ''}`);
    }
    const bytes = readFileSync(out);
    compiled = { sha, bytes };
    return bytes;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
