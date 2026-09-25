// 目录树的读、比、写、删。删东西只经 removeEntry：链接只删链接本身，绝不顺着链接删到它指的地方
// （旧仓的 skill 是 junction 链过去的，顺着删就把旧仓的文件删了）。
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Platform } from './targets.ts';

/** 相对路径（/ 分隔）→ 内容 */
export type Tree = Map<string, Buffer>;

export interface ReadTree {
  files: Tree;
  /** 目录本身和里面每一项的属主（Windows 上都是 0，不拿来判） */
  owners: number[];
}

/** 读整棵树；里面的链接按它指向的东西读。读不了就抛，由调用方记「没查成」 */
export function readTree(dir: string): ReadTree {
  const files: Tree = new Map();
  const owners: number[] = [lstatSync(dir).uid];
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, e.name);
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      owners.push(lstatSync(childAbs).uid);
      const st = statSync(childAbs);
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) files.set(childRel, readFileSync(childAbs));
    }
  };
  walk(dir, '');
  return { files, owners };
}

const CR = 0x0d;

function withoutCr(buf: Buffer): Buffer {
  return buf.includes(CR) ? Buffer.from(buf.filter((b) => b !== CR)) : buf;
}

/** 一样的文件、一样的内容（\r 不算） */
export function sameTree(a: Tree, b: Tree): boolean {
  if (a.size !== b.size) return false;
  for (const [rel, content] of a) {
    const other = b.get(rel);
    if (other === undefined || !withoutCr(content).equals(withoutCr(other))) return false;
  }
  return true;
}

/** 不一样的地方，给人看：多了、少了、改了哪几个文件 */
export function treeDiff(want: Tree, have: Tree): string {
  const parts: string[] = [];
  const missing = [...want.keys()].filter((k) => !have.has(k));
  const extra = [...have.keys()].filter((k) => !want.has(k));
  const changed = [...want.keys()].filter((k) => {
    const h = have.get(k);
    const w = want.get(k);
    return h !== undefined && w !== undefined && !withoutCr(h).equals(withoutCr(w));
  });
  if (missing.length) parts.push(`少了 ${missing.join('、')}`);
  if (extra.length) parts.push(`多了 ${extra.join('、')}`);
  if (changed.length) parts.push(`改了 ${changed.join('、')}`);
  return parts.join('；');
}

export function writeTree(dir: string, tree: Tree): void {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of tree) {
    const file = join(dir, ...rel.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** 删一项：链接只删链接本身；目录整棵删；文件直接删 */
export function removeEntry(p: string): void {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) {
    try {
      unlinkSync(p);
    } catch (err) {
      // Windows 上个别目录链接 unlink 不掉，rmdir 删的也只是链接本身
      if (
        (err as NodeJS.ErrnoException).code !== 'EPERM' &&
        (err as NodeJS.ErrnoException).code !== 'EISDIR'
      ) {
        throw err;
      }
      rmdirSync(p);
    }
    return;
  }
  if (st.isDirectory()) {
    rmSync(p, { recursive: true });
    return;
  }
  unlinkSync(p);
}

/** 链接指向哪（绝对路径；相对的按链接所在目录算） */
export function linkTarget(p: string): string {
  return resolve(dirname(p), readlinkSync(p));
}

function canonical(p: string): string[] {
  const out = [resolve(p)];
  try {
    out.push(realpathSync.native(p));
  } catch {
    // 不在了（悬空的链接、已经挪走的旧仓）就只按字面比
  }
  return out;
}

/** child 在不在 parent 里（含 parent 本身）；Windows 不分大小写。两边都顺带按真实路径比一遍 */
export function isInside(child: string, parent: string, platform: Platform): boolean {
  const norm = (p: string): string => (platform === 'win32' ? p.toLowerCase() : p);
  for (const c of canonical(child)) {
    for (const p of canonical(parent)) {
      const rel = relative(norm(p), norm(c));
      if (rel === '' || (rel.split(/[\\/]/)[0] !== '..' && !isAbsolute(rel))) return true;
    }
  }
  return false;
}
