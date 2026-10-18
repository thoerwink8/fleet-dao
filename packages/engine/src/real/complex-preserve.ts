// 复杂工作树（未提交、未跟踪、stash、合并中）的受管快照。
// 只认这次在受限目录里写成、并在独立空仓恢复核过的回执。树外已有的包、人工备份、verified 标记都不能放行删除。
// 源树上不做 reset、clean、stash drop。读失败、对象缺失、恢复失败都留原树。

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  unlink,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PortError } from '../ports.ts';
import { describeFailure, type UserCommandResult } from './exec.ts';
import {
  DISPOSABLE,
  ENVIRONMENT_FILES,
  GIT,
  recoveryIdentity,
  treeLeftovers,
  type UserTree,
  verifyRecoveryBundle,
} from './user-git.ts';

export type IdleAnswer = 'idle' | 'busy' | 'unknown';

export interface PreserveGate {
  taskId?: string;
  branch?: string;
  workRoot: string;
  confirmIdle: () => Promise<IdleAnswer>;
}

export interface TreePlace {
  lex: string;
  real: string;
  dev: string;
  ino: string;
  uid: string;
}

interface SnapFile {
  path: string;
  kind: 'file' | 'symlink' | 'dir';
  mode: number;
  sha256: string;
}

interface SnapIgnore {
  path: string;
  rule: string;
}

interface SnapMerge {
  name: string;
  sha256: string;
}

interface SnapStash {
  sha: string;
  parents: string[];
  subject: string;
}

interface SnapObject {
  sha: string;
  type: string;
}

interface ComplexState {
  version: 3;
  head: string;
  headRef: string | null;
  identity: string;
  indexSha: string;
  indexInfo: string;
  /** 每条索引的阶段和标志（assume-unchanged、intent-to-add、skip-worktree）。stage 行相等不算索引相等。 */
  indexFlags: string;
  resolveUndo: string;
  /** 原始索引字节的哈希。恢复时整份写回，不经过 update-index --index-info。 */
  indexBlob: string;
  files: SnapFile[];
  ignored: SnapIgnore[];
  merge: SnapMerge[];
  stash: SnapStash[];
  objects: SnapObject[];
  objectCount: number;
  objectsSha: string;
}

interface ComplexReceipt {
  version: 3;
  kind: 'complex';
  taskId?: string;
  branch?: string;
  originalPath: string;
  realPath: string;
  dev: string;
  ino: string;
  uid: string;
  head: string;
  fingerprint: string;
  ignored: SnapIgnore[];
  preservedPaths: string[];
  ignoreRules: string[];
  artifacts: { state: string; pack: string; bundle: string; blobs: string[] };
}

export interface ProcLook {
  list(): Promise<readonly string[]>;
  cwd(pid: number): Promise<string>;
  uid(pid: number): Promise<string | null>;
}

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SCRIPT = fileURLToPath(new URL('./complex-snapshot.mjs', import.meta.url));

function keep(code: 'ARCHIVE_FAILED' | 'WORKTREE_PRESERVED', message: string, dir?: string): PortError {
  const text = message.includes('保留原树') ? message : `${message}，保留原树`;
  return new PortError(code, text, { retryable: false, ...(dir ? { details: { dir } } : {}) });
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function basename(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash < 0 ? filePath : filePath.slice(slash + 1);
}

function glob(pattern: string, name: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  return re.test(name);
}

/** 忽略项只许这几类。规则对不上路径就拒绝，避免把没归档的成果算成可丢。 */
export function ignoreRuleAllowed(rule: string, filePath: string, preserved: readonly string[]): boolean {
  if (rule === 'git-metadata') return filePath === '.git';
  const disposable = DISPOSABLE.find((item) => item.pattern === rule);
  if (disposable) {
    if (rule.endsWith('/')) {
      const name = rule.slice(0, -1);
      return filePath === name || filePath.endsWith(`/${name}`);
    }
    return glob(rule, basename(filePath));
  }
  if (ENVIRONMENT_FILES.some((item) => rule === `env:${item.path}` && filePath === item.path)) return true;
  return rule === `shot:${filePath}` && preserved.includes(filePath);
}

function ignoreRules(preserved: readonly string[]): string[] {
  return [
    'git-metadata',
    ...DISPOSABLE.map((item) => item.pattern),
    ...ENVIRONMENT_FILES.map((item) => `env:${item.path}`),
    ...preserved.map((filePath) => `shot:${filePath}`),
  ];
}

/** 和 complex-snapshot.mjs 的 indexCanonical 必须逐字相同。 */
function indexCanonical(indexInfo: string, indexFlags: string, resolveUndo: string): string {
  return `stage\n${indexInfo}flags\n${indexFlags}\nresolve-undo\n${resolveUndo}\n`;
}

function comparable(state: ComplexState): string {
  return JSON.stringify({
    version: state.version,
    head: state.head,
    headRef: state.headRef,
    identity: state.identity,
    indexSha: state.indexSha,
    indexInfo: state.indexInfo,
    indexFlags: state.indexFlags,
    resolveUndo: state.resolveUndo,
    indexBlob: state.indexBlob,
    files: state.files,
    merge: state.merge,
    stash: state.stash,
    objects: state.objects,
    objectCount: state.objectCount,
    objectsSha: state.objectsSha,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asState(value: unknown, preserved: readonly string[], dir: string): ComplexState {
  const row = asRecord(value);
  if (row?.version !== 3) throw keep('ARCHIVE_FAILED', '快照状态不是完整版本，旧回执不能放行删除', dir);
  const head = row.head;
  const identity = row.identity;
  const indexSha = row.indexSha;
  const indexInfo = row.indexInfo;
  const indexFlags = row.indexFlags;
  const resolveUndo = row.resolveUndo;
  const indexBlob = row.indexBlob;
  const objectsSha = row.objectsSha;
  if (typeof head !== 'string' || !SHA.test(head)) throw keep('ARCHIVE_FAILED', '快照 HEAD 认不出', dir);
  if (row.headRef !== null && (typeof row.headRef !== 'string' || !row.headRef.startsWith('refs/'))) {
    throw keep('ARCHIVE_FAILED', '快照 HEAD 引用认不出', dir);
  }
  if (typeof identity !== 'string' || !identity.startsWith(`${head}\n`)) {
    throw keep('ARCHIVE_FAILED', '快照身份认不出', dir);
  }
  if (
    typeof indexSha !== 'string' ||
    !SHA256.test(indexSha) ||
    typeof indexInfo !== 'string' ||
    typeof indexFlags !== 'string' ||
    typeof resolveUndo !== 'string' ||
    typeof indexBlob !== 'string' ||
    !SHA256.test(indexBlob)
  ) {
    throw keep('ARCHIVE_FAILED', '快照索引认不出', dir);
  }
  if (sha256(Buffer.from(indexCanonical(indexInfo, indexFlags, resolveUndo))) !== indexSha) {
    throw keep('ARCHIVE_FAILED', '快照索引指纹对不上', dir);
  }
  if (typeof objectsSha !== 'string' || !SHA256.test(objectsSha) || !Array.isArray(row.files)) {
    throw keep('ARCHIVE_FAILED', '快照对象清单认不出', dir);
  }
  const files: SnapFile[] = [];
  for (const item of row.files) {
    const file = asRecord(item);
    if (
      !file ||
      typeof file.path !== 'string' ||
      (file.kind !== 'file' && file.kind !== 'symlink' && file.kind !== 'dir') ||
      typeof file.mode !== 'number' ||
      typeof file.sha256 !== 'string' ||
      !SHA256.test(file.sha256)
    ) {
      throw keep('ARCHIVE_FAILED', '快照文件清单认不出', dir);
    }
    files.push({ path: file.path, kind: file.kind, mode: file.mode, sha256: file.sha256 });
  }
  if (!Array.isArray(row.ignored) || !Array.isArray(row.merge) || !Array.isArray(row.stash)) {
    throw keep('ARCHIVE_FAILED', '快照状态缺字段', dir);
  }
  const ignored: SnapIgnore[] = [];
  for (const item of row.ignored) {
    const entry = asRecord(item);
    if (!entry || typeof entry.path !== 'string' || typeof entry.rule !== 'string') {
      throw keep('ARCHIVE_FAILED', '快照忽略项认不出', dir);
    }
    if (!ignoreRuleAllowed(entry.rule, entry.path, preserved)) {
      throw keep(
        'WORKTREE_PRESERVED',
        `忽略项不在允许范围内（${entry.path}：${entry.rule}），不能把未归档成果静默排除`,
        dir,
      );
    }
    ignored.push({ path: entry.path, rule: entry.rule });
  }
  const merge: SnapMerge[] = [];
  for (const item of row.merge) {
    const entry = asRecord(item);
    if (
      !entry ||
      typeof entry.name !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      !SHA256.test(entry.sha256)
    ) {
      throw keep('ARCHIVE_FAILED', '快照合并状态认不出', dir);
    }
    merge.push({ name: entry.name, sha256: entry.sha256 });
  }
  const stash: SnapStash[] = [];
  for (const item of row.stash) {
    const entry = asRecord(item);
    const parents = entry?.parents;
    if (
      !entry ||
      typeof entry.sha !== 'string' ||
      !SHA.test(entry.sha) ||
      typeof entry.subject !== 'string' ||
      !Array.isArray(parents) ||
      parents.some((parent) => typeof parent !== 'string' || !SHA.test(parent))
    ) {
      throw keep('ARCHIVE_FAILED', '快照 stash 认不出', dir);
    }
    stash.push({ sha: entry.sha, parents: parents as string[], subject: entry.subject });
  }
  if (!Array.isArray(row.objects)) throw keep('ARCHIVE_FAILED', '快照对象清单认不出', dir);
  const objects: SnapObject[] = [];
  for (const item of row.objects) {
    const entry = asRecord(item);
    if (!entry || typeof entry.sha !== 'string' || !SHA.test(entry.sha) || typeof entry.type !== 'string') {
      throw keep('ARCHIVE_FAILED', '快照对象认不出', dir);
    }
    if (entry.type === 'missing') throw keep('ARCHIVE_FAILED', `对象缺失：${entry.sha}`, dir);
    objects.push({ sha: entry.sha, type: entry.type });
  }
  if (row.objectCount !== objects.length) throw keep('ARCHIVE_FAILED', '快照对象数量对不上', dir);
  const listed = sha256(Buffer.from(objects.map((item) => `${item.sha} ${item.type}`).join('\n')));
  if (listed !== objectsSha) throw keep('ARCHIVE_FAILED', '快照对象哈希对不上', dir);
  return {
    version: 3,
    head,
    headRef: row.headRef as string | null,
    identity,
    indexSha,
    indexInfo,
    indexFlags,
    resolveUndo,
    indexBlob,
    files,
    ignored,
    merge,
    stash,
    objects,
    objectCount: objects.length,
    objectsSha,
  };
}

function cwdInside(cwd: string, real: string): boolean {
  const bare = cwd.endsWith(' (deleted)') ? cwd.slice(0, -' (deleted)'.length) : cwd;
  return bare === real || bare.startsWith(`${real}${sep}`);
}

const linuxProcLook: ProcLook = {
  async list() {
    return readdir('/proc');
  },
  async cwd(pid) {
    return readlink(`/proc/${pid}/cwd`);
  },
  async uid(pid) {
    const line = (await readFile(`/proc/${pid}/status`, 'utf8'))
      .split('\n')
      .find((item) => item.startsWith('Uid:'));
    return line?.split(/\s+/)[1] ?? null;
  },
};

/**
 * 有进程的 cwd 在这棵树里就是在用。/proc 列不了、同主或树主的 cwd 读不到，都算确认不了，留树。
 * 父子关系证明不了 cwd 在树外：读不到就保留原树。
 * 别的用户读不到 cwd 不当成在用，否则多用户机器上一棵树永远清不掉。
 * 进程已经退出（ENOENT、ESRCH）跳过。看见有人在用，优先于确认不了。
 */
export async function treeProcessUsage(
  real: string,
  ownerUid: string,
  selfPid = process.pid,
  parentPid = process.ppid,
  look: ProcLook = linuxProcLook,
): Promise<IdleAnswer> {
  if (process.platform !== 'linux' && look === linuxProcLook) return 'unknown';
  let names: readonly string[];
  try {
    names = await look.list();
  } catch {
    return 'unknown';
  }
  const selfUid = process.getuid?.()?.toString() ?? ownerUid;
  let unseen = false;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === selfPid || pid === parentPid) continue;
    try {
      if (cwdInside(await look.cwd(pid), real)) return 'busy';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ESRCH') continue;
      let uid: string | null;
      try {
        uid = await look.uid(pid);
      } catch (uidError) {
        const uidCode = (uidError as NodeJS.ErrnoException).code;
        if (uidCode === 'ENOENT' || uidCode === 'ESRCH') continue;
        unseen = true;
        continue;
      }
      if (uid === null) {
        unseen = true;
        continue;
      }
      if (uid !== ownerUid && uid !== selfUid) continue;
      unseen = true;
    }
  }
  return unseen ? 'unknown' : 'idle';
}

export function cleanupLockPath(archiveDir: string, dev: string, ino: string, real: string): string {
  return join(archiveDir, '.locks', createHash('sha256').update(`${dev}:${ino}:${real}`).digest('hex'));
}

async function pidAlive(pid: number): Promise<'alive' | 'dead' | 'unknown'> {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

const ARCHIVE_NAME = /^[A-Za-z0-9._-]+$/;

class ArchiveNameExists extends Error {
  constructor() {
    super('归档名字已经有了');
    this.name = 'ArchiveNameExists';
  }
}

/** 从根逐级打开。只挡最后一级挡不住上级被换成符号链接之后写出到树外。 */
function archiveParts(path: string): string[] {
  const lex = resolve(path);
  if (!lex.startsWith(sep)) throw keep('ARCHIVE_FAILED', '归档路径不是绝对路径');
  const parts = lex.split(sep).filter((part) => part.length > 0);
  if (parts.length === 0) throw keep('ARCHIVE_FAILED', '归档路径是根，拒绝写出');
  for (const part of parts) {
    if (part === '.' || part === '..' || !ARCHIVE_NAME.test(part)) {
      throw keep('ARCHIVE_FAILED', '归档路径有不能打开的名字，拒绝写出');
    }
  }
  return parts;
}

async function openFromRoot(parts: readonly string[], leafFlags: number): Promise<FileHandle> {
  const noFollow = constants.O_NOFOLLOW;
  const directory = constants.O_DIRECTORY;
  if (typeof noFollow !== 'number' || typeof directory !== 'number') {
    throw keep('ARCHIVE_FAILED', '这个系统不能拒绝跟随符号链接');
  }
  const dirFlags = constants.O_RDONLY | directory | noFollow;
  let current = await open(sep, dirFlags);
  try {
    for (let i = 0; i < parts.length; i += 1) {
      const name = parts[i] ?? '';
      const last = i === parts.length - 1;
      const flags = (last ? leafFlags : dirFlags) | noFollow;
      let next: FileHandle;
      try {
        next = await open(`/proc/self/fd/${current.fd}/${name}`, flags);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || code === 'ENOTDIR')
          throw keep('ARCHIVE_FAILED', '归档路径上有符号链接，拒绝写出');
        if (code === 'ENOENT') throw keep('ARCHIVE_FAILED', '归档缺文件');
        throw keep('ARCHIVE_FAILED', '归档路径打不开');
      }
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

export async function makeArchiveDir(path: string): Promise<void> {
  const parts = archiveParts(path);
  const name = parts[parts.length - 1] ?? '';
  const parent = await openFromRoot(parts.slice(0, -1), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await mkdir(`/proc/self/fd/${parent.fd}/${name}`, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw keep('ARCHIVE_FAILED', '归档目录建不起来');
  } finally {
    await parent.close();
  }
  const handle = await openFromRoot(parts, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

export async function writeExclusiveArchive(path: string, bytes: Buffer): Promise<void> {
  const parts = archiveParts(path);
  const name = parts[parts.length - 1] ?? '';
  const parent = await openFromRoot(parts.slice(0, -1), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const flag = constants.O_NOFOLLOW;
    if (typeof flag !== 'number') throw keep('ARCHIVE_FAILED', '这个系统不能拒绝跟随符号链接');
    let handle: FileHandle;
    try {
      handle = await open(
        `/proc/self/fd/${parent.fd}/${name}`,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | flag,
        0o600,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new ArchiveNameExists();
      if (code === 'ELOOP') throw keep('ARCHIVE_FAILED', '归档被换成符号链接');
      throw keep('ARCHIVE_FAILED', '归档写不进去');
    }
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
  } finally {
    await parent.close();
  }
}

export async function readArchiveFile(path: string): Promise<Buffer> {
  const handle = await openFromRoot(archiveParts(path), constants.O_RDONLY);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function listArchiveDir(path: string): Promise<string[]> {
  const handle = await openFromRoot(archiveParts(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    return await readdir(`/proc/self/fd/${handle.fd}`);
  } finally {
    await handle.close();
  }
}

async function unlinkArchive(path: string): Promise<void> {
  const parts = archiveParts(path);
  const name = parts[parts.length - 1] ?? '';
  const parent = await openFromRoot(parts.slice(0, -1), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await unlink(`/proc/self/fd/${parent.fd}/${name}`);
  } finally {
    await parent.close();
  }
}

export async function archiveMode(path: string): Promise<number> {
  const handle = await openFromRoot(archiveParts(path), constants.O_RDONLY);
  try {
    return (await handle.stat()).mode & 0o777;
  } finally {
    await handle.close();
  }
}

/** 同一棵树的清理互斥。活着的进程占着就拒；进程确认不了也拒；确认已退出才接手一次。 */
export async function holdCleanupLock(archiveDir: string, place: TreePlace): Promise<() => Promise<void>> {
  const locks = join(archiveDir, '.locks');
  try {
    await makeArchiveDir(locks);
  } catch (error) {
    if (error instanceof PortError) throw error;
    throw keep('WORKTREE_PRESERVED', '清理锁目录建不起来');
  }
  const file = cleanupLockPath(archiveDir, place.dev, place.ino, place.real);
  const body = Buffer.from(`${process.pid}\n${place.real}\n`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeExclusiveArchive(file, body);
      return async () => {
        await unlinkArchive(file).catch(() => undefined);
      };
    } catch (error) {
      if (error instanceof PortError) throw error;
      if (!(error instanceof ArchiveNameExists)) throw keep('WORKTREE_PRESERVED', '清理锁建不起来');
      let text = '';
      try {
        text = (await readArchiveFile(file)).toString('utf8');
      } catch {
        throw keep('WORKTREE_PRESERVED', '清理锁读不了，确认不了有没有人在清，保留原树');
      }
      const pid = Number(text.split('\n')[0]);
      const alive = await pidAlive(pid);
      if (alive === 'alive') throw keep('WORKTREE_PRESERVED', '已经有一次清理在进行，保留原树');
      if (alive === 'unknown') throw keep('WORKTREE_PRESERVED', '清理锁的进程确认不了，保留原树');
      try {
        await unlinkArchive(file);
      } catch (error) {
        if (error instanceof PortError) throw error;
      }
    }
  }
  throw keep('WORKTREE_PRESERVED', '清理锁让不出来，保留原树');
}

export async function assertPeopleIdle(confirm: () => Promise<IdleAnswer>, what: string): Promise<void> {
  let answer: IdleAnswer;
  try {
    const value = await confirm();
    answer = value === 'idle' || value === 'busy' || value === 'unknown' ? value : 'unknown';
  } catch {
    answer = 'unknown';
  }
  if (answer === 'busy') throw keep('WORKTREE_PRESERVED', `${what}仍有任务或会话在用，保留原树`);
  if (answer !== 'idle') throw keep('WORKTREE_PRESERVED', `${what}确认不了没人用，保留原树`);
}

const LOCATE_SCRIPT = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const dir = process.argv[1];',
  "if (!dir) { process.stderr.write('没有路径\\n'); process.exitCode = 2; throw new Error('no path'); }",
  'let st;',
  'try { st = fs.lstatSync(dir, { bigint: true }); }',
  "catch (error) { process.stderr.write(String((error && error.message) || '看不了') + '\\n'); process.exitCode = 2; throw error; }",
  "if (st.isSymbolicLink()) { process.stderr.write('工作树路径是符号链接\\n'); process.exitCode = 3; throw new Error('symlink'); }",
  'const lex = path.resolve(dir);',
  'let real;',
  'try { real = fs.realpathSync.native(dir); }',
  "catch (error) { process.stderr.write(String((error && error.message) || '物理路径看不了') + '\\n'); process.exitCode = 2; throw error; }",
  'process.stdout.write(JSON.stringify({ lex, real, dev: st.dev.toString(), ino: st.ino.toString(), uid: st.uid.toString() }));',
].join('\n');

let seq = 0;
function scopeId(prefix: string): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40)}-c${seq}`.slice(0, 63);
}

async function runUser(
  t: UserTree,
  argv: string[],
  options: { cwd?: string; stdin?: Buffer; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<UserCommandResult> {
  return t.exec({
    user: t.user,
    cwd: options.cwd ?? t.dir,
    argv,
    ...(options.stdin ? { stdin: options.stdin } : {}),
    timeoutMs: options.timeoutMs ?? 240_000,
    ...(t.signal ? { signal: t.signal } : {}),
    scopeId: scopeId(t.scopePrefix),
    ...(options.env ? { env: options.env } : {}),
  });
}

export async function locateTree(t: UserTree): Promise<TreePlace> {
  if (!resolve(t.dir).startsWith(sep)) throw keep('WORKTREE_PRESERVED', '工作树路径不是绝对路径', t.dir);
  const result = await runUser(
    t,
    [process.execPath, '--input-type=commonjs', '-e', LOCATE_SCRIPT, '--', t.dir],
    {
      cwd: resolve(t.dir, '..'),
      timeoutMs: 30_000,
    },
  );
  if (result.code !== 0) {
    throw keep('WORKTREE_PRESERVED', describeFailure('看工作树路径', result), t.dir);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.toString('utf8'));
  } catch {
    throw keep('WORKTREE_PRESERVED', '工作树路径输出认不出', t.dir);
  }
  const row = asRecord(parsed);
  if (
    !row ||
    typeof row.lex !== 'string' ||
    typeof row.real !== 'string' ||
    typeof row.dev !== 'string' ||
    typeof row.ino !== 'string' ||
    typeof row.uid !== 'string'
  ) {
    throw keep('WORKTREE_PRESERVED', '工作树路径输出认不出', t.dir);
  }
  return { lex: row.lex, real: row.real, dev: row.dev, ino: row.ino, uid: row.uid };
}

export function assertTreeInside(workRoot: string, place: TreePlace): void {
  if (place.lex !== place.real) throw keep('WORKTREE_PRESERVED', '工作树路径经过符号链接，保留原树');
  const root = resolve(workRoot);
  if (!root.startsWith(sep) || !place.real.startsWith(sep)) {
    throw keep('WORKTREE_PRESERVED', '工作根或工作树不是绝对路径，保留原树');
  }
  if (!(place.real === root || place.real.startsWith(`${root}${sep}`)) || place.real === root) {
    throw keep('WORKTREE_PRESERVED', '工作树不在工作根里，不能删工作根以外的内容，保留原树');
  }
  const parts = place.real.slice(root.length + 1).split(sep);
  if (parts.length < 2 || parts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw keep('WORKTREE_PRESERVED', '工作树不在工作根下的两级目录里，保留原树');
  }
}

/** 归档目录必须是引擎自己的真实目录。符号链接、上级被调包、不是目录，都不写出。 */
export async function assertArchiveContainer(archiveDir: string): Promise<void> {
  const lex = resolve(archiveDir);
  if (!lex.startsWith(sep)) throw keep('ARCHIVE_FAILED', '归档目录不是绝对路径');
  const parent = resolve(lex, '..');
  let parentStat: Awaited<ReturnType<typeof lstat>>;
  try {
    parentStat = await lstat(parent);
  } catch {
    throw keep('ARCHIVE_FAILED', '归档目录的上级看不了，拒绝写出');
  }
  if (parentStat.isSymbolicLink()) throw keep('ARCHIVE_FAILED', '归档目录的上级是符号链接，拒绝写出');
  const parentReal = await realpath(parent).catch(() => '');
  if (parentReal !== parent) throw keep('ARCHIVE_FAILED', '归档目录的上级经过符号链接，拒绝写出');
  let leaf: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    leaf = await lstat(lex);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw keep('ARCHIVE_FAILED', '归档目录看不了');
  }
  if (!leaf) {
    await mkdir(lex, { mode: 0o700 });
    leaf = await lstat(lex);
  }
  if (leaf.isSymbolicLink()) throw keep('ARCHIVE_FAILED', '归档目录是符号链接，拒绝写出');
  if (!leaf.isDirectory()) throw keep('ARCHIVE_FAILED', '归档目录不是目录，拒绝写出');
  const real = await realpath(lex).catch(() => '');
  if (real !== lex) throw keep('ARCHIVE_FAILED', '归档目录路径经过符号链接，拒绝写出');
  await makeArchiveDir(lex);
  if (process.platform !== 'win32' && (await archiveMode(lex)) !== 0o700) {
    throw keep('ARCHIVE_FAILED', '归档目录权限不受限');
  }
}

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const dir = await openFromRoot(archiveParts(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

async function exclusiveFile(path: string, bytes: Buffer): Promise<void> {
  await writeExclusiveArchive(path, bytes);
}

async function readNoFollow(path: string): Promise<Buffer> {
  return readArchiveFile(path);
}

function snapEnv(mode: string, t: UserTree, preserved: readonly string[]): Record<string, string> {
  const dirs: string[] = [];
  const files: string[] = [];
  for (const item of DISPOSABLE) {
    if (item.pattern.endsWith('/')) dirs.push(item.pattern.slice(0, -1));
    else files.push(item.pattern);
  }
  return {
    FLEET_SNAP_MODE: mode,
    FLEET_GIT: t.git ?? GIT,
    FLEET_SKIP_DIRS: dirs.join('\n'),
    FLEET_SKIP_FILES: files.join('\n'),
    FLEET_ENV_PATHS: ENVIRONMENT_FILES.map((item) => item.path).join('\n'),
    FLEET_PRESERVED: preserved.join('\n'),
  };
}

async function runSnap(
  t: UserTree,
  mode: 'capture' | 'inspect' | 'verify',
  preserved: readonly string[],
  stdin?: Buffer,
): Promise<Buffer> {
  let script: string;
  try {
    script = await readFile(SCRIPT, 'utf8');
  } catch {
    throw keep('ARCHIVE_FAILED', '快照脚本读不了', t.dir);
  }
  const result = await runUser(t, [process.execPath, '--input-type=module', '-e', script], {
    ...(stdin ? { stdin } : {}),
    env: snapEnv(mode, t, preserved),
  });
  if (result.code !== 0 || result.timedOut || result.aborted || result.spawnError) {
    throw keep(
      'ARCHIVE_FAILED',
      describeFailure(mode === 'verify' ? '独立恢复核验' : '给复杂工作树打快照', result),
      t.dir,
    );
  }
  if (result.stdout.length === 0) throw keep('ARCHIVE_FAILED', '快照输出是空的', t.dir);
  return result.stdout;
}

function parseFrame(
  buf: Buffer,
  preserved: readonly string[],
  dir: string,
): {
  state: ComplexState;
  stateJson: Buffer;
  pack: Buffer;
  bundle: Buffer;
  blobs: Map<string, Buffer>;
} {
  let at = 0;
  const blobs = new Map<string, Buffer>();
  let stateJson: Buffer | undefined;
  let pack: Buffer | undefined;
  let bundle: Buffer | undefined;
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) throw keep('ARCHIVE_FAILED', '快照帧不完整', dir);
    const header = buf.subarray(at, nl).toString('utf8');
    at = nl + 1;
    if (header === 'END') break;
    const matched = /^(JSON|PACK|BUNDLE|BLOB [0-9a-f]{64}) (\d+)$/.exec(header);
    if (!matched?.[1] || !matched[2]) throw keep('ARCHIVE_FAILED', '快照帧认不出', dir);
    const len = Number(matched[2]);
    if (!Number.isInteger(len) || at + len > buf.length) throw keep('ARCHIVE_FAILED', '快照帧长度不对', dir);
    const body = buf.subarray(at, at + len);
    at += len;
    if (matched[1] === 'JSON') stateJson = Buffer.from(body);
    else if (matched[1] === 'PACK') pack = Buffer.from(body);
    else if (matched[1] === 'BUNDLE') bundle = Buffer.from(body);
    else blobs.set(matched[1].slice(5), Buffer.from(body));
  }
  if (at !== buf.length || !stateJson || !pack || !bundle) throw keep('ARCHIVE_FAILED', '快照帧缺内容', dir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stateJson.toString('utf8'));
  } catch {
    throw keep('ARCHIVE_FAILED', '快照状态不是 JSON', dir);
  }
  return { state: asState(parsed, preserved, dir), stateJson, pack, bundle, blobs };
}

function buildFrame(stateJson: Buffer, pack: Buffer, bundle: Buffer, blobs: Map<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const add = (name: string, buf: Buffer) => {
    parts.push(Buffer.from(`${name} ${buf.length}\n`));
    parts.push(buf);
  };
  add('JSON', stateJson);
  add('PACK', pack);
  add('BUNDLE', bundle);
  for (const [sum, buf] of [...blobs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) add(`BLOB ${sum}`, buf);
  parts.push(Buffer.from('END\n'));
  return Buffer.concat(parts);
}

async function inspectLive(t: UserTree, preserved: readonly string[]): Promise<ComplexState> {
  const stdout = await runSnap(t, 'inspect', preserved);
  try {
    return asState(JSON.parse(stdout.toString('utf8')), preserved, t.dir);
  } catch (error) {
    if (error instanceof PortError) throw error;
    throw keep('ARCHIVE_FAILED', '回读工作树状态认不出', t.dir);
  }
}

async function modesRestricted(paths: readonly (readonly [string, number])[]): Promise<void> {
  if (process.platform === 'win32') return;
  for (const [path, mode] of paths) {
    if ((await archiveMode(path)) !== mode) throw keep('ARCHIVE_FAILED', '成果存档权限不受限');
  }
}

async function assertSameWork(live: ComplexState, restored: ComplexState, dir: string): Promise<void> {
  if (comparable(live) !== comparable(restored)) {
    throw keep('ARCHIVE_FAILED', '独立恢复的成果和原树对不上', dir);
  }
}

/** 复杂树的完整快照。调用前已经确定是脏仓。成功只表示回执写成，不表示可以删。 */
export async function preserveComplexWorktree(
  t: UserTree,
  archiveDir: string,
  context: PreserveGate,
  preserved: readonly string[],
): Promise<string> {
  await assertArchiveContainer(archiveDir);
  const place = await locateTree(t);
  assertTreeInside(context.workRoot, place);
  const usage = await treeProcessUsage(place.real, place.uid);
  if (usage === 'busy') throw keep('WORKTREE_PRESERVED', '有进程正用着这棵树，保留原树', t.dir);
  if (usage !== 'idle') throw keep('WORKTREE_PRESERVED', '确认不了有没有进程用着这棵树，保留原树', t.dir);
  await assertPeopleIdle(context.confirmIdle, '打快照前');
  const frame = await runSnap(t, 'capture', preserved);
  const parsed = parseFrame(frame, preserved, t.dir);
  for (const [sum, buf] of parsed.blobs) {
    if (sha256(buf) !== sum) throw keep('ARCHIVE_FAILED', `快照内容哈希对不上：${sum}`, t.dir);
  }
  const needed = new Set<string>();
  for (const file of parsed.state.files) needed.add(file.sha256);
  for (const item of parsed.state.merge) needed.add(item.sha256);
  needed.add(parsed.state.indexBlob);
  for (const sum of needed) {
    if (!parsed.blobs.has(sum)) throw keep('ARCHIVE_FAILED', '快照缺文件内容', t.dir);
  }
  const dir = join(archiveDir, `worktree-${randomUUID()}`);
  await makeArchiveDir(dir);
  const blobDir = join(dir, 'blobs');
  await makeArchiveDir(blobDir);
  const bundlePath = join(dir, 'recovery.bundle');
  const packPath = join(dir, 'objects.pack');
  const statePath = join(dir, 'state.json');
  await exclusiveFile(bundlePath, parsed.bundle);
  await exclusiveFile(packPath, parsed.pack);
  await exclusiveFile(statePath, parsed.stateJson);
  for (const [sum, buf] of parsed.blobs) await exclusiveFile(join(blobDir, sum), buf);
  const readBack = async (path: string, bytes: Buffer) => {
    const saved = await readNoFollow(path);
    if (!saved.equals(bytes)) throw keep('ARCHIVE_FAILED', '落盘成果回读不一致', t.dir);
  };
  await readBack(bundlePath, parsed.bundle);
  await readBack(packPath, parsed.pack);
  await readBack(statePath, parsed.stateJson);
  for (const [sum, buf] of parsed.blobs) await readBack(join(blobDir, sum), buf);
  await modesRestricted([
    [dir, 0o700],
    [blobDir, 0o700],
    [bundlePath, 0o600],
    [packPath, 0o600],
    [statePath, 0o600],
  ]);
  const restored = asState(
    JSON.parse((await runSnap(t, 'verify', preserved, frame)).toString('utf8')),
    preserved,
    t.dir,
  );
  const live = await inspectLive(t, preserved);
  await assertSameWork(live, restored, t.dir);
  if (JSON.stringify(live.ignored) !== JSON.stringify(parsed.state.ignored)) {
    throw keep('WORKTREE_PRESERVED', '存档期间工作树成果发生变化，保留原树重新核验', t.dir);
  }
  const again = await treeProcessUsage(place.real, place.uid);
  if (again !== 'idle') throw keep('WORKTREE_PRESERVED', '存档期间确认不了没人用，保留原树', t.dir);
  await assertPeopleIdle(context.confirmIdle, '回执落盘前');
  const receipt: ComplexReceipt = {
    version: 3,
    kind: 'complex',
    ...(context.taskId ? { taskId: context.taskId } : {}),
    ...(context.branch ? { branch: context.branch } : {}),
    originalPath: t.dir,
    realPath: place.real,
    dev: place.dev,
    ino: place.ino,
    uid: place.uid,
    head: live.head,
    fingerprint: sha256(Buffer.from(comparable(live))),
    ignored: live.ignored,
    preservedPaths: [...preserved],
    ignoreRules: ignoreRules(preserved),
    artifacts: {
      state: sha256(parsed.stateJson),
      pack: sha256(parsed.pack),
      bundle: sha256(parsed.bundle),
      blobs: [...parsed.blobs.keys()].sort(),
    },
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const receiptPath = join(dir, 'receipt.json');
  await exclusiveFile(receiptPath, receiptBytes);
  if (!(await readNoFollow(receiptPath)).equals(receiptBytes)) {
    throw keep('ARCHIVE_FAILED', '成果回执回读不一致', t.dir);
  }
  await modesRestricted([[receiptPath, 0o600]]);
  const after = await inspectLive(t, preserved);
  if (
    comparable(after) !== comparable(live) ||
    JSON.stringify(after.ignored) !== JSON.stringify(live.ignored)
  ) {
    throw keep('WORKTREE_PRESERVED', '回执写成后工作树成果发生变化，旧回执作废，保留原树', t.dir);
  }
  const moved = await locateTree(t);
  if (
    moved.dev !== place.dev ||
    moved.ino !== place.ino ||
    moved.real !== place.real ||
    moved.uid !== place.uid
  ) {
    throw keep('WORKTREE_PRESERVED', '回执写成后工作树身份变了，旧回执作废，保留原树', t.dir);
  }
  await syncDirectory(blobDir);
  await syncDirectory(dir);
  await syncDirectory(archiveDir);
  return dir;
}

function asReceipt(value: unknown, dir: string): ComplexReceipt {
  const row = asRecord(value);
  const artifacts = asRecord(row?.artifacts);
  if (
    row?.version !== 3 ||
    row.kind !== 'complex' ||
    typeof row.originalPath !== 'string' ||
    typeof row.realPath !== 'string' ||
    typeof row.dev !== 'string' ||
    typeof row.ino !== 'string' ||
    typeof row.uid !== 'string' ||
    typeof row.head !== 'string' ||
    typeof row.fingerprint !== 'string' ||
    !artifacts ||
    typeof artifacts.state !== 'string' ||
    typeof artifacts.pack !== 'string' ||
    typeof artifacts.bundle !== 'string' ||
    !Array.isArray(artifacts.blobs)
  ) {
    throw keep('ARCHIVE_FAILED', '成果回执认不出', dir);
  }
  return row as unknown as ComplexReceipt;
}

async function recheckComplex(
  t: UserTree,
  dir: string,
  context: { confirmIdle?: () => Promise<IdleAnswer> },
  place: TreePlace,
  preserved: readonly string[],
): Promise<void> {
  const receipt = asReceipt(
    JSON.parse((await readNoFollow(join(dir, 'receipt.json'))).toString('utf8')),
    t.dir,
  );
  if (receipt.originalPath !== t.dir || receipt.realPath !== place.real) {
    throw keep('WORKTREE_PRESERVED', '回执上的路径和这棵树对不上，不能拿它删别的路径，保留原树', t.dir);
  }
  if (
    receipt.dev !== place.dev ||
    receipt.ino !== place.ino ||
    receipt.uid !== place.uid ||
    !SHA.test(receipt.head)
  ) {
    throw keep('WORKTREE_PRESERVED', '回执上的工作树身份和现在对不上，旧回执作废，保留原树', t.dir);
  }
  const usage = await treeProcessUsage(place.real, place.uid);
  if (usage !== 'idle') throw keep('WORKTREE_PRESERVED', '删除前确认不了没人用，保留原树', t.dir);
  if (context.confirmIdle) await assertPeopleIdle(context.confirmIdle, '删除前');
  const stateJson = await readNoFollow(join(dir, 'state.json'));
  const pack = await readNoFollow(join(dir, 'objects.pack'));
  const bundle = await readNoFollow(join(dir, 'recovery.bundle'));
  if (sha256(stateJson) !== receipt.artifacts.state || sha256(pack) !== receipt.artifacts.pack) {
    throw keep('ARCHIVE_FAILED', '归档内容哈希对不上', t.dir);
  }
  if (sha256(bundle) !== receipt.artifacts.bundle)
    throw keep('ARCHIVE_FAILED', '归档成果包哈希对不上', t.dir);
  const blobs = new Map<string, Buffer>();
  for (const sum of receipt.artifacts.blobs) {
    if (typeof sum !== 'string' || !SHA256.test(sum))
      throw keep('ARCHIVE_FAILED', '回执里的内容哈希认不出', t.dir);
    const bytes = await readNoFollow(join(dir, 'blobs', sum));
    if (sha256(bytes) !== sum) throw keep('ARCHIVE_FAILED', '归档内容哈希对不上', t.dir);
    blobs.set(sum, bytes);
  }
  const frame = buildFrame(stateJson, pack, bundle, blobs);
  const restored = asState(
    JSON.parse((await runSnap(t, 'verify', preserved, frame)).toString('utf8')),
    preserved,
    t.dir,
  );
  const live = await inspectLive(t, preserved);
  await assertSameWork(live, restored, t.dir);
  if (receipt.head !== live.head || receipt.head !== restored.head) {
    throw keep('WORKTREE_PRESERVED', '回执上的 HEAD 和现在对不上，旧回执作废，保留原树', t.dir);
  }
  if (sha256(Buffer.from(comparable(live))) !== receipt.fingerprint) {
    throw keep('WORKTREE_PRESERVED', '原树和回执指纹对不上，旧回执作废，保留原树', t.dir);
  }
  if (JSON.stringify(live.ignored) !== JSON.stringify(receipt.ignored)) {
    throw keep('WORKTREE_PRESERVED', '原树的忽略项变了，旧回执作废，保留原树', t.dir);
  }
}

async function recheckClean(t: UserTree, dir: string, preserved: readonly string[]): Promise<void> {
  const manifestBytes = await readNoFollow(join(dir, 'manifest.json'));
  const bundle = await readNoFollow(join(dir, 'recovery.bundle'));
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(manifestBytes.toString('utf8')) as unknown;
    const row = asRecord(parsed);
    if (!row) throw new Error('认不出');
    manifest = row;
  } catch {
    throw keep('ARCHIVE_FAILED', '成果清单认不出', t.dir);
  }
  if (manifest.version !== 1 || manifest.originalPath !== t.dir) {
    throw keep('WORKTREE_PRESERVED', '成果清单的路径和这棵树对不上，保留原树', t.dir);
  }
  if (manifest.sha256 !== sha256(bundle) || typeof manifest.identity !== 'string') {
    throw keep('ARCHIVE_FAILED', '成果包和清单对不上', t.dir);
  }
  const identity = manifest.identity;
  if ((await recoveryIdentity(t)) !== identity) {
    throw keep('WORKTREE_PRESERVED', '存档之后工作树成果发生变化，保留原树重新核验', t.dir);
  }
  await verifyRecoveryBundle(t, bundle, identity);
  const left = await treeLeftovers(t, [], { preservedPaths: preserved });
  if (left.kind !== 'repo' || left.dirtyCount > 0 || left.stashes > 0) {
    throw keep('WORKTREE_PRESERVED', '存档之后工作树里又有未提交成果，保留原树', t.dir);
  }
}

/** 删除前再读回执、再恢复、再看原树。不认目录里预先放好的标记。 */
export async function recheckPreservedArchive(
  t: UserTree,
  archivedTo: string,
  context: { workRoot?: string; confirmIdle?: () => Promise<IdleAnswer> },
  place: TreePlace,
  preserved: readonly string[],
): Promise<void> {
  if (context.workRoot) assertTreeInside(context.workRoot, place);
  const names = new Set(await listArchiveDir(archivedTo));
  const complex = names.has('receipt.json');
  const clean = names.has('manifest.json');
  if (complex && clean) throw keep('ARCHIVE_FAILED', '归档里同时有两套回执，认不出该信哪套', t.dir);
  if (complex) {
    await recheckComplex(t, archivedTo, context, place, preserved);
    return;
  }
  if (clean) {
    if (context.confirmIdle) await assertPeopleIdle(context.confirmIdle, '删除前');
    await recheckClean(t, archivedTo, preserved);
    return;
  }
  throw keep('ARCHIVE_FAILED', '归档没有受管回执，不能把旁边的备份当放行依据', t.dir);
}

export async function recheckNoUnique(t: UserTree, preserved: readonly string[]): Promise<void> {
  const left = await treeLeftovers(t, [], { preservedPaths: preserved });
  if (left.kind === 'empty') return;
  if (left.kind === 'repo' && left.dirtyCount === 0 && left.stashes === 0 && left.unpushedCount === 0) return;
  throw keep('WORKTREE_PRESERVED', '删除前这棵树又有了未归档成果，保留原树', t.dir);
}
