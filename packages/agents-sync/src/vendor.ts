// 第三方 skill（agents/skills-vendor/）：从公开仓原样拷进来的 skill，旁边一份锁文件（vendor.lock.json）记来源仓、
// 提交号、许可证、每个文件的哈希、谁在哪天审过。分发前照锁文件核一遍：对不上就整体报没查成、不往各家目录里写——
// 第三方的一个字就是喂给每台机器上每个 AI 的指令，不能让「仓里的文件」和「审过的文件」悄悄不一样。
// 改这里之前必须知道：这一层不联网、不更新；升级只能手动（拷新版进来、看差异、重算哈希、走先审后合），见 agents/skills-vendor/README.md。
import { createHash } from 'node:crypto';
import { type Dirent, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crlfToLf, type Tree } from './tree.ts';

export const VENDOR_DIR = ['agents', 'skills-vendor'] as const;
export const LOCK_NAME = 'vendor.lock.json';
/** 目录里除了各个 skill，只许有这两样 */
const ALLOWED_TOP_FILES = new Set([LOCK_NAME, 'README.md']);
/** 收第三方 skill 只认这两种许可证（原文随 skill 一起拷进来）；加一种要改这里、走先审后合 */
export const ALLOWED_LICENSES: readonly string[] = ['MIT', 'Apache-2.0'];
/** skill 目录里顶层要有一份许可证原文（分发时随 skill 一起装到各家，署名才不丢） */
const LICENSE_FILES = ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'COPYING'];

export interface VendorSource {
  repo: string;
  commit: string;
  commitDate: string;
  license: string;
}

export interface VendorSkill {
  /** sources 里的键 */
  source: string;
  /** 上游仓里的目录 */
  path: string;
  license: string;
  reviewedAt: string;
  reviewedBy: string;
  /** 相对路径 → 内容的 sha256（CRLF 行尾不算，和 sameTree 同一种比法） */
  files: Record<string, string>;
  /** 收进来时加的文件（上游这个目录里没有的，如从仓根拷来的 LICENSE）→ 为什么加 */
  added: Record<string, string>;
  /** 上游这个目录里有、没收进来的文件 → 为什么 */
  leftOut: Record<string, string>;
  /** 和本仓规矩冲突、用的时候要留意的地方 */
  notes: string[];
}

export interface VendorRejected {
  source: string;
  reason: string;
}

export interface VendorLock {
  sources: Record<string, VendorSource>;
  skills: Record<string, VendorSkill>;
  rejected: Record<string, VendorRejected>;
}

export type VendorRead =
  | { ok: true; skills: Map<string, Tree>; lock: VendorLock | null }
  | { ok: false; why: string };

/** 一段内容的哈希：只有 CRLF 行尾不算（Windows 检出和 Linux 检出算出来一样）；单独的 \r 算内容，塞一个进去哈希就变 */
export function hashOf(content: Buffer): string {
  return createHash('sha256').update(crlfToLf(content)).digest('hex');
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isPlainName = (n: string): boolean => n !== '' && !n.startsWith('.') && !/[\\/\0]/.test(n);

/** 锁文件里的路径：相对、/ 分隔、不带 .. 和绝对路径 */
const isSafeRel = (p: string): boolean =>
  p !== '' &&
  !p.startsWith('/') &&
  !/[\\\0]/.test(p) &&
  p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');

class LockError extends Error {}

function str(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new LockError(`${where} 要写成非空的字符串`);
  return v;
}

function strMap(v: unknown, where: string): Record<string, string> {
  if (!isObj(v)) throw new LockError(`${where} 要写成 {名字: 说明}`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (!isSafeRel(k)) throw new LockError(`${where} 里的路径「${k}」不合规（要相对路径、不带 ..）`);
    out[k] = str(val, `${where}["${k}"]`);
  }
  return out;
}

const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** 把锁文件的文本读成结构；每一项都验，认不出的一律抛（不拿默认值顶） */
export function parseLock(text: string): VendorLock {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new LockError(`${LOCK_NAME} 不是 JSON`);
  }
  if (!isObj(data)) throw new LockError(`${LOCK_NAME} 最外层要是对象`);
  if (data.formatVersion !== 1) throw new LockError(`${LOCK_NAME} 的 formatVersion 只认 1`);

  const sources: Record<string, VendorSource> = {};
  if (!isObj(data.sources) || Object.keys(data.sources).length === 0)
    throw new LockError('sources 要写成 {来源名: {…}}，至少一个');
  for (const [name, raw] of Object.entries(data.sources)) {
    const w = `sources["${name}"]`;
    if (!isObj(raw)) throw new LockError(`${w} 要写成对象`);
    const repo = str(raw.repo, `${w}.repo`);
    if (!repo.startsWith('https://github.com/'))
      throw new LockError(`${w}.repo 只认 https://github.com/ 开头的地址`);
    const commit = str(raw.commit, `${w}.commit`);
    if (!/^[0-9a-f]{40}$/.test(commit))
      throw new LockError(`${w}.commit 要写成完整的 40 位提交号（不写分支名、标签）`);
    const commitDate = str(raw.commitDate, `${w}.commitDate`);
    if (!isDate(commitDate)) throw new LockError(`${w}.commitDate 要写成 YYYY-MM-DD`);
    const license = str(raw.license, `${w}.license`);
    if (!ALLOWED_LICENSES.includes(license))
      throw new LockError(`${w}.license「${license}」不在允许的许可证里（${ALLOWED_LICENSES.join('、')}）`);
    sources[name] = { repo, commit, commitDate, license };
  }

  const skills: Record<string, VendorSkill> = {};
  if (!isObj(data.skills)) throw new LockError('skills 要写成 {skill 名: {…}}');
  for (const [name, raw] of Object.entries(data.skills)) {
    const w = `skills["${name}"]`;
    if (!isPlainName(name)) throw new LockError(`${w}：skill 名要是单个目录名`);
    if (!isObj(raw)) throw new LockError(`${w} 要写成对象`);
    const source = str(raw.source, `${w}.source`);
    if (!(source in sources)) throw new LockError(`${w}.source「${source}」不在 sources 里`);
    const license = str(raw.license, `${w}.license`);
    if (!ALLOWED_LICENSES.includes(license))
      throw new LockError(`${w}.license「${license}」不在允许的许可证里（${ALLOWED_LICENSES.join('、')}）`);
    const reviewedAt = str(raw.reviewedAt, `${w}.reviewedAt`);
    if (!isDate(reviewedAt)) throw new LockError(`${w}.reviewedAt 要写成 YYYY-MM-DD`);
    if (!isObj(raw.files) || Object.keys(raw.files).length === 0)
      throw new LockError(`${w}.files 要写成 {相对路径: sha256}，至少 SKILL.md`);
    const files: Record<string, string> = {};
    for (const [rel, h] of Object.entries(raw.files)) {
      if (!isSafeRel(rel)) throw new LockError(`${w}.files 里的路径「${rel}」不合规（要相对路径、不带 ..）`);
      if (typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h))
        throw new LockError(`${w}.files["${rel}"] 要写成 64 位小写十六进制的 sha256`);
      files[rel] = h;
    }
    if (!('SKILL.md' in files)) throw new LockError(`${w}.files 里没有 SKILL.md`);
    if (!LICENSE_FILES.some((f) => f in files))
      throw new LockError(`${w}.files 里没有许可证原文（${LICENSE_FILES.join(' / ')} 之一）：分发时署名会丢`);
    const notes = raw.notes ?? [];
    if (!Array.isArray(notes) || notes.some((n) => typeof n !== 'string' || n.trim() === ''))
      throw new LockError(`${w}.notes 要写成字符串列表`);
    skills[name] = {
      source,
      path: str(raw.path, `${w}.path`),
      license,
      reviewedAt,
      reviewedBy: str(raw.reviewedBy, `${w}.reviewedBy`),
      files,
      added: strMap(raw.added ?? {}, `${w}.added`),
      leftOut: strMap(raw.leftOut ?? {}, `${w}.leftOut`),
      notes: notes as string[],
    };
    for (const rel of Object.keys(skills[name]?.added ?? {})) {
      if (!(rel in files)) throw new LockError(`${w}.added 里的「${rel}」不在 files 里`);
    }
  }

  const rejected: Record<string, VendorRejected> = {};
  if (data.rejected !== undefined && !isObj(data.rejected))
    throw new LockError('rejected 要写成 {skill 名: {…}}');
  for (const [name, raw] of Object.entries(data.rejected ?? {})) {
    const w = `rejected["${name}"]`;
    if (!isPlainName(name)) throw new LockError(`${w}：skill 名要是单个目录名`);
    if (!isObj(raw)) throw new LockError(`${w} 要写成对象`);
    const source = str(raw.source, `${w}.source`);
    if (!(source in sources)) throw new LockError(`${w}.source「${source}」不在 sources 里`);
    if (name in skills) throw new LockError(`「${name}」同时在 skills 和 rejected 里`);
    rejected[name] = { source, reason: str(raw.reason, `${w}.reason`) };
  }
  return { sources, skills, rejected };
}

/** 读一个 skill 目录：只认普通文件和目录，链接一概不认（读出去的东西要和锁里的哈希逐个对得上） */
function readVendorTree(dir: string): Tree {
  const files: Tree = new Map();
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, e.name);
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) throw new LockError(`${childRel} 是链接：第三方目录里不许有链接`);
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) files.set(childRel, readFileSync(childAbs));
      else throw new LockError(`${childRel} 不是普通文件`);
    }
  };
  walk(dir, '');
  return files;
}

/** SKILL.md 头上 frontmatter 里的 name（开放标准要求它和目录名一样） */
export function frontmatterName(text: string): string | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (block?.[1] === undefined) return null;
  const line = /^name:\s*(.+?)\s*$/m.exec(block[1]);
  return line?.[1] === undefined ? null : line[1].replace(/^["']|["']$/g, '');
}

/**
 * 读 agents/skills-vendor/ 并照锁文件逐个核：目录不在就是没有第三方 skill（老检出）；目录在、锁文件缺或读不懂、
 * 有没登记的 skill、文件多了少了、哈希对不上、SKILL.md 的 name 和目录名不一样、里面有链接——一律说清哪里不对，不往下走。
 */
export function readVendor(repo: string): VendorRead {
  const dir = join(repo, ...VENDOR_DIR);
  let top: Dirent[];
  try {
    top = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, skills: new Map(), lock: null };
    return {
      ok: false,
      why: `读不了 ${VENDOR_DIR.join('/')}/（${(err as NodeJS.ErrnoException).code ?? String(err)}）`,
    };
  }
  try {
    let lockText: string;
    try {
      lockText = readFileSync(join(dir, LOCK_NAME), 'utf8');
    } catch (err) {
      throw new LockError(
        `读不了 ${LOCK_NAME}（${(err as NodeJS.ErrnoException).code ?? String(err)}）：有第三方目录却没有锁文件，不知道哪些审过`,
      );
    }
    const lock = parseLock(lockText);

    for (const e of top) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (!(e.name in lock.skills))
          throw new LockError(`目录 ${e.name}/ 没在 ${LOCK_NAME} 里登记：没审过的不发`);
      } else if (!ALLOWED_TOP_FILES.has(e.name)) {
        throw new LockError(
          `多出来的文件 ${e.name}（顶层只许有 ${[...ALLOWED_TOP_FILES].join('、')} 和各个 skill 目录）`,
        );
      }
    }
    const skills = new Map<string, Tree>();
    for (const [name, entry] of Object.entries(lock.skills).sort(([a], [b]) => a.localeCompare(b))) {
      const skillDir = join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(skillDir);
      } catch {
        throw new LockError(`${name}：锁文件登记了、目录不在`);
      }
      if (st.isSymbolicLink() || !st.isDirectory()) throw new LockError(`${name}：不是普通目录`);
      const tree = readVendorTree(skillDir);
      const want = new Set(Object.keys(entry.files));
      const missing = [...want].filter((f) => !tree.has(f));
      const extra = [...tree.keys()].filter((f) => !want.has(f));
      if (missing.length) throw new LockError(`${name}：少了 ${missing.join('、')}（锁文件里有）`);
      if (extra.length) throw new LockError(`${name}：多了 ${extra.join('、')}（锁文件里没有，没审过）`);
      const changed = [...tree.entries()]
        .filter(([rel, buf]) => hashOf(buf) !== entry.files[rel])
        .map(([rel]) => rel);
      if (changed.length)
        throw new LockError(`${name}：${changed.join('、')} 的内容和锁文件里的哈希对不上（改过没重新审？）`);
      const skillMd = tree.get('SKILL.md');
      const fmName = skillMd === undefined ? null : frontmatterName(skillMd.toString('utf8'));
      if (fmName !== name)
        throw new LockError(`${name}：SKILL.md 头上的 name 是「${fmName ?? '没写'}」，要和目录名一样`);
      skills.set(name, tree);
    }
    return { ok: true, skills, lock };
  } catch (err) {
    if (err instanceof LockError) return { ok: false, why: err.message };
    throw err;
  }
}

/** 重算一个 skill 的 files（升级时人审完、把新版拷进目录之后用）：只改 files，来源、审查人、日期、说明这些人写的不动 */
export function rehashSkill(repo: string, name: string, reviewedAt: string, reviewedBy: string): string {
  const dir = join(repo, ...VENDOR_DIR);
  const lockPath = join(dir, LOCK_NAME);
  const text = readFileSync(lockPath, 'utf8');
  const raw = JSON.parse(text) as { skills?: Record<string, Record<string, unknown>> };
  const entry = raw.skills?.[name];
  if (entry === undefined)
    throw new LockError(`${LOCK_NAME} 里没有 ${name}：新加一个 skill 先手写它的来源、许可证那几项`);
  if (!isDate(reviewedAt)) throw new LockError('审查日期要写成 YYYY-MM-DD');
  if (reviewedBy.trim() === '') throw new LockError('审查人不能空');
  const files: Record<string, string> = {};
  for (const [rel, buf] of [...readVendorTree(join(dir, name)).entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    files[rel] = hashOf(buf);
  }
  entry.files = files;
  entry.reviewedAt = reviewedAt;
  entry.reviewedBy = reviewedBy;
  writeFileSync(lockPath, `${JSON.stringify(raw, null, 2)}\n`);
  return `${name}：${Object.keys(files).length} 个文件的哈希已重算；审查 ${reviewedAt} ${reviewedBy}`;
}

export { LockError };
