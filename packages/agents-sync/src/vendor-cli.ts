// agents-vendor：第三方 skill（agents/skills-vendor/）的核对和升级辅助。不联网、不自动更新：升级是人手动拷新版进来、
// 用 diff 看差异、读过之后 rehash 记下审查、改锁文件里的提交号，开 PR 等 CI（agents/skills-vendor/README.md）。
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Tree } from './tree.ts';
import { hashOf, LOCK_NAME, LockError, parseLock, readVendor, rehashSkill, VENDOR_DIR } from './vendor.ts';

export const USAGE = `agents-vendor —— 第三方 skill（agents/skills-vendor/）的核对和升级辅助

用法：
  agents-vendor verify [--repo <目录>]
      核锁文件：登记的都在、文件一个不多不少、哈希对得上、许可证在白名单里、SKILL.md 的 name 和目录名一样。退出码 0 对 / 1 对不上
  agents-vendor diff <skill> --from <上游目录> [--repo <目录>]
      升级时用：拿上游新版里这个 skill 的目录，和仓里收的逐文件比，列出多了、少了、改了哪几个（不改任何东西）。退出码 0 一样 / 1 有差别
  agents-vendor rehash <skill> --reviewed-by <谁> [--date YYYY-MM-DD] [--repo <目录>]
      人读完新版、拷进 agents/skills-vendor/<skill>/ 之后，重算这个 skill 的文件哈希、记下审查人和日期；
      来源仓、提交号、许可证、说明是人手写的，不动

没有自动更新：手动拷新版进来 → diff 看差异 → 逐个文件读 → rehash → 手改锁文件里的提交号、leftOut → 开 PR 等 CI。
`;

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  defaultRepo: string;
}

class Usage extends Error {}

function optionsOf(argv: readonly string[]): { pos: string[]; opt: Record<string, string> } {
  const pos: string[] = [];
  const opt: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Usage(`${a} 后面要跟一个值`);
      opt[a.slice(2)] = v;
      i++;
    } else pos.push(a);
  }
  return { pos, opt };
}

function plainTree(dir: string): Tree {
  const files: Tree = new Map();
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, e.name);
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) throw new Usage(`${childRel} 是链接，不比`);
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) files.set(childRel, readFileSync(childAbs));
    }
  };
  walk(dir, '');
  return files;
}

export function runVendorCli(argv: readonly string[], io: Io): number {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === '--help' || cmd === '-h') {
    io.out(USAGE);
    return cmd === undefined ? 64 : 0;
  }
  try {
    const { pos, opt } = optionsOf(rest);
    const repo = resolve(opt.repo ?? io.defaultRepo);
    if (cmd === 'verify') {
      const read = readVendor(repo);
      if (!read.ok) {
        io.err(`✗ 第三方 skill 核不过：${read.why}\n`);
        return 1;
      }
      if (read.lock === null) {
        io.out(`· 仓里没有 ${VENDOR_DIR.join('/')}/（老检出）：没有第三方 skill\n`);
        return 0;
      }
      for (const [name, e] of Object.entries(read.lock.skills)) {
        const s = read.lock.sources[e.source];
        io.out(
          `✓ ${name}：${e.license}，来自 ${e.source}@${s?.commit.slice(0, 7)}，${e.reviewedAt} 审过，${Object.keys(e.files).length} 个文件哈希都对\n`,
        );
      }
      for (const [name, r] of Object.entries(read.lock.rejected))
        io.out(`· ${name}：审过没收——${r.reason}\n`);
      io.out(`共 ${read.skills.size} 个第三方 skill，${LOCK_NAME} 全部核过\n`);
      return 0;
    }
    if (cmd === 'diff') {
      const [name] = pos;
      if (name === undefined || opt.from === undefined)
        throw new Usage('diff 要带 <skill> 和 --from <上游目录>');
      const read = readVendor(repo);
      if (!read.ok) throw new Usage(`仓里的第三方 skill 先要核得过：${read.why}`);
      const have = read.skills.get(name);
      const entry = read.lock?.skills[name];
      if (have === undefined || entry === undefined) throw new Usage(`仓里没有第三方 skill「${name}」`);
      const from = plainTree(resolve(opt.from));
      const lines: string[] = [];
      for (const rel of [...new Set([...from.keys(), ...have.keys()])].sort()) {
        const up = from.get(rel);
        const mine = have.get(rel);
        if (up !== undefined && mine === undefined)
          lines.push(
            `+ 上游多了 ${rel}${rel in entry.leftOut ? `（锁文件里记了没收：${entry.leftOut[rel]}）` : ''}`,
          );
        else if (up === undefined && mine !== undefined)
          lines.push(
            `- 上游没有 ${rel}${rel in entry.added ? `（收录时加的：${entry.added[rel]}）` : '（上游删了）'}`,
          );
        else if (up !== undefined && mine !== undefined && hashOf(up) !== hashOf(mine))
          lines.push(`~ 改了 ${rel}`);
      }
      io.out(
        lines.length
          ? `${lines.join('\n')}\n逐行差异用：git diff --no-index <上游目录> ${VENDOR_DIR.join('/')}/${name}\n`
          : '一样：没有差别\n',
      );
      return lines.length ? 1 : 0;
    }
    if (cmd === 'rehash') {
      const [name] = pos;
      if (name === undefined || opt['reviewed-by'] === undefined)
        throw new Usage('rehash 要带 <skill> 和 --reviewed-by <谁>');
      const date = opt.date ?? new Date().toISOString().slice(0, 10);
      io.out(`${rehashSkill(repo, name, date, opt['reviewed-by'])}\n`);
      // 重算完立刻照锁文件整体核一遍（顺带验锁文件其余各项还认得出）
      const after = readVendor(repo);
      if (!after.ok) {
        io.err(`✗ 重算之后整体核不过：${after.why}\n`);
        return 1;
      }
      parseLock(readFileSync(join(repo, ...VENDOR_DIR, LOCK_NAME), 'utf8'));
      return 0;
    }
    throw new Usage(`认不出的命令：${cmd}`);
  } catch (err) {
    if (err instanceof Usage || err instanceof LockError) {
      io.err(`${err.message}\n\n${err instanceof Usage ? USAGE : ''}`);
      return err instanceof Usage ? 64 : 1;
    }
    io.err(`没做成：${(err as Error).message}\n`);
    return 1;
  }
}
