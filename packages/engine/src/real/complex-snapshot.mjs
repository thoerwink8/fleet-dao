// 复杂工作树快照。capture 打帧，inspect 只出状态，verify 在临时仓独立恢复后再采集。
// 恢复仓不写 alternates，也不读调用方的 GIT_DIR / GIT_OBJECT_DIRECTORY。
// 对象包只按清单里的对象名打包。抓成果包之前先证明这些对象都在包里，不靠 refs、reflog 或成果包补洞。
// 索引按原始字节写回；指纹带标志和 resolve-undo。源仓上不做 reset、clean、stash drop。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  openSync,
  readlinkSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createInflate } from 'node:zlib';

const mode = process.env.FLEET_SNAP_MODE || 'inspect';
const gitBin = process.env.FLEET_GIT || 'git';
const skipDirs = new Set((process.env.FLEET_SKIP_DIRS || '').split('\n').filter(Boolean));
const skipFilePats = (process.env.FLEET_SKIP_FILES || '').split('\n').filter(Boolean);
const envPaths = new Set((process.env.FLEET_ENV_PATHS || '').split('\n').filter(Boolean));
const preserved = new Set((process.env.FLEET_PRESERVED || '').split('\n').filter(Boolean));
const MAX_METADATA = 32 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
const MAX_COMPONENTS = 100003;
const MAX_OBJECTS = 250000;
const MAX_OBJECT_BYTES = 256 * 1024 * 1024;
let captureRoot;
let captureBytes = 0;
let metadataRead = 0;
let visitedPaths = 0;
const STATE_NAMES = [
  'MERGE_HEAD',
  'MERGE_MSG',
  'MERGE_MODE',
  'ORIG_HEAD',
  'AUTO_MERGE',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'SQUASH_MSG',
];
const POINTER = new Set([
  'MERGE_HEAD',
  'ORIG_HEAD',
  'AUTO_MERGE',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
]);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function gitEnv() {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_INDEX_FILE',
    'GIT_NAMESPACE',
    // 浅边界文件在真实 common-dir 里；继承来的这两个变量能让浅仓读成完整仓，或让完整仓读成浅仓。
    'GIT_SHALLOW_FILE',
    'GIT_COMMON_DIR',
  ]) {
    delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.LC_ALL = 'C';
  env.LANGUAGE = 'C';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  // 快照期间不许 git 为了刷新 stat 改写索引，否则标志指纹会对不上。
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

function git(args, cwd, input, maxBuffer = 110 * 1024 * 1024) {
  const result = spawnSync(
    gitBin,
    ['-c', 'core.quotePath=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args],
    { cwd, env: gitEnv(), input, maxBuffer },
  );
  if (result.error) fail(`git ${args[0]}：${result.error.message}`);
  if (result.status !== 0) {
    const err = result.stderr?.toString('utf8').trim().split('\n').slice(-4).join(' / ') || '没有输出';
    fail(`git ${args[0]}：退出码 ${result.status}（${err.slice(0, 400)}）`);
  }
  return result.stdout;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function glob(pattern, name) {
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  return re.test(name);
}

function safeRel(path) {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\0') ||
    path.includes('\n') ||
    path.includes('\\') ||
    Buffer.byteLength(path) > 4096 ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail(`路径不能归档：${String(path).slice(0, 80)}`);
  }
}

function readNoFollow(full, path) {
  let fd;
  try {
    fd = safeOpenFile(full);
    const before = fstatSync(fd);
    metadataRead += before.size;
    if (metadataRead > MAX_METADATA) fail(`元数据超过 32MiB：${path}`);
    const bytes = readFixedMetadata(fd, before.size);
    if (bytes.length !== before.size || !sameFile(before, fstatSync(fd))) fail(`元数据读取期间变化：${path}`);
    return bytes;
  } catch (error) {
    fail(`读文件失败 ${path}：${error instanceof Error ? error.message : '读不了'}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return Buffer.alloc(0);
}

function readFixedMetadata(fd, size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_METADATA) fail('元数据长度越界');
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const length = readSync(fd, bytes, offset, size - offset, offset);
    if (!length) fail('元数据读取截断');
    offset += length;
  }
  if (readSync(fd, Buffer.alloc(1), 0, 1, size)) fail('元数据读取期间变长');
  return bytes;
}

// 逐级固定目录FD，不能只防最后一级链接。沿用合法Unix名字，不增加Windows名单。
function safeOpenFile(full, directory = false) {
  const parts = resolve(full).split('/').filter(Boolean);
  let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (let i = 0; i < parts.length; i += 1) {
      const next = openSync(
        `/proc/self/fd/${fd}/${parts[i]}`,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (i === parts.length - 1 && !directory ? 0 : constants.O_DIRECTORY),
      );
      closeSync(fd);
      fd = next;
    }
    if (directory ? !fstatSync(fd).isDirectory() : !fstatSync(fd).isFile()) fail('快照组件类型不符');
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function boundedNames(full) {
  const fd = safeOpenFile(full, true);
  let directory;
  try {
    directory = opendirSync(`/proc/self/fd/${fd}`);
    const names = [];
    for (;;) {
      const item = directory.readSync();
      if (!item) break;
      if (names.length >= 100000) fail('目录项超过快照数量预算');
      names.push(item.name);
    }
    return names;
  } finally {
    directory?.closeSync();
    closeSync(fd);
  }
}

function operationRoot(prefix) {
  if (!process.env.FLEET_SNAP_TEMP) return mkdtempSync(join(tmpdir(), prefix));
  const identity = JSON.parse(process.env.FLEET_SNAP_TEMP);
  if (
    typeof identity.path !== 'string' ||
    !identity.path.endsWith(`/fleet-snapshot-${identity.token}`) ||
    !/^[0-9a-f-]{36}$/.test(identity.token)
  )
    fail('临时事务身份非法');
  const fd = safeOpenFile(identity.path, true);
  try {
    const stat = fstatSync(fd);
    if (
      String(stat.dev) !== identity.dev ||
      String(stat.ino) !== identity.ino ||
      String(stat.uid) !== identity.uid ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o700
    )
      fail('临时事务身份变化');
    return identity.path;
  } finally {
    closeSync(fd);
  }
}

function cleanupOperationRoot(root) {
  if (!process.env.FLEET_SNAP_TEMP) rmSync(root, { recursive: true, force: true });
}

function sameFile(a, b) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function streamSourceFile(full, path, save) {
  const fd = safeOpenFile(full);
  let output;
  let component;
  try {
    const before = fstatSync(fd);
    if (before.size > MAX_TOTAL) fail(`文件超过快照预算：${path}`);
    if (save) {
      captureBytes += before.size;
      if (captureBytes > MAX_TOTAL) fail('快照临时组件超过 1GiB');
      const dest = join(captureRoot, `blob-${captureBytes}-${Math.random().toString(16).slice(2)}`);
      output = openSync(
        dest,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      component = { path: dest, length: before.size };
    }
    const hash = createHash('sha256');
    const block = Buffer.alloc(64 * 1024);
    let offset = 0;
    for (;;) {
      const length = readSync(fd, block, 0, block.length, offset);
      if (!length) break;
      offset += length;
      if (offset > before.size) fail(`文件读取期间变长：${path}`);
      const bytes = block.subarray(0, length);
      hash.update(bytes);
      if (output !== undefined) writeAll(output, bytes);
    }
    if (offset !== before.size || !sameFile(before, fstatSync(fd))) fail(`文件读取期间变化：${path}`);
    return { sum: hash.digest('hex'), component };
  } finally {
    closeSync(fd);
    if (output !== undefined) closeSync(output);
  }
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!written) fail('组件写入没有进展');
    offset += written;
  }
}

function walk(root, rel, files, ignored, blobs) {
  const abs = rel ? join(root, rel) : root;
  let names;
  try {
    names = boundedNames(abs);
  } catch (error) {
    fail(`列目录失败 ${rel || '.'}：${error instanceof Error ? error.message : '读不了'}`);
  }
  for (const name of names.sort()) {
    if (++visitedPaths > 100000) fail('快照路径太多');
    const path = rel ? `${rel}/${name}` : name;
    safeRel(path);
    const full = join(abs, name);
    let st;
    try {
      st = lstatSync(full);
    } catch (error) {
      fail(`看文件失败 ${path}：${error instanceof Error ? error.message : '读不了'}`);
    }
    if (name === '.git') {
      if (rel) fail(`里面还有别的 Git 仓 ${path}，不能当成可丢弃`);
      ignored.push({ path, rule: 'git-metadata' });
      continue;
    }
    if (st.isDirectory()) {
      if (skipDirs.has(name)) {
        ignored.push({ path, rule: `${name}/` });
        continue;
      }
      let nested;
      try {
        nested = boundedNames(full);
      } catch (error) {
        fail(`列目录失败 ${path}：${error instanceof Error ? error.message : '读不了'}`);
      }
      if (nested.length === 0) {
        const buf = Buffer.alloc(0);
        const sum = sha256(buf);
        files.push({ path, kind: 'dir', mode: st.mode & 0o777, sha256: sum });
        blobs?.set(sum, buf);
      }
      walk(root, path, files, ignored, blobs);
      continue;
    }
    if (envPaths.has(path)) {
      ignored.push({ path, rule: `env:${path}` });
      continue;
    }
    if (preserved.has(path)) {
      ignored.push({ path, rule: `shot:${path}` });
      continue;
    }
    const fileRule = skipFilePats.find((pattern) => glob(pattern, name));
    if (fileRule) {
      ignored.push({ path, rule: fileRule });
      continue;
    }
    if (st.isSymbolicLink()) {
      let target;
      try {
        target = readlinkSync(full);
      } catch (error) {
        fail(`读链接失败 ${path}：${error instanceof Error ? error.message : '读不了'}`);
      }
      const buf = Buffer.from(target);
      const sum = sha256(buf);
      files.push({ path, kind: 'symlink', mode: st.mode & 0o777, sha256: sum });
      blobs?.set(sum, buf);
      continue;
    }
    if (st.isFile()) {
      const content = streamSourceFile(full, path, Boolean(blobs));
      const sum = content.sum;
      files.push({ path, kind: 'file', mode: st.mode & 0o777, sha256: sum });
      blobs?.set(sum, content.component);
      continue;
    }
    fail(`${path} 不是普通文件、目录或符号链接，不能丢`);
  }
}

function gitPath(name, cwd) {
  return git(['rev-parse', '--git-path', name], cwd).toString('utf8').trim();
}

function readStateFiles(cwd, blobs) {
  const gitDir = git(['rev-parse', '--absolute-git-dir'], cwd).toString('utf8').trim();
  const wanted = new Set(STATE_NAMES);
  let top;
  try {
    top = boundedNames(gitDir);
  } catch (error) {
    fail(`列 Git 目录失败：${error instanceof Error ? error.message : '读不了'}`);
  }
  for (const name of top) {
    // 和 complex-preserve.ts 的 OPERATION_STATE 同一份名单。变基目录不认得全的内容会在 sequenceObjects 里拒绝，不静默漏掉。
    if (
      /^(?:MERGE_|REBASE|rebase-merge$|rebase-apply$|CHERRY_PICK|REVERT_|SQUASH_|BISECT|AUTO_MERGE|ORIG_HEAD|sequencer$)/.test(
        name,
      )
    ) {
      wanted.add(name);
    }
  }
  const merge = [];
  for (const name of [...wanted].sort()) {
    const rel = gitPath(name, cwd);
    const abs = rel.startsWith('/') ? rel : join(cwd, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) fail(`合并状态 ${name} 是符号链接，不归档`);
    if (st.isDirectory()) {
      const stack = [''];
      while (stack.length > 0) {
        const sub = stack.pop() ?? '';
        const dir = sub ? join(abs, sub) : abs;
        let entries;
        try {
          entries = boundedNames(dir);
        } catch (error) {
          fail(`列合并状态 ${name} 失败：${error instanceof Error ? error.message : '读不了'}`);
        }
        for (const entry of entries) {
          const child = sub ? `${sub}/${entry}` : entry;
          safeRel(`${name}/${child}`);
          const full = join(dir, entry);
          const childStat = lstatSync(full);
          if (childStat.isSymbolicLink()) fail(`合并状态 ${name}/${child} 是符号链接，不归档`);
          if (childStat.isDirectory()) stack.push(child);
          else if (childStat.isFile()) {
            const buf = readNoFollow(full, `${name}/${child}`);
            const sum = sha256(buf);
            merge.push({ name: `${name}/${child}`, sha256: sum });
            blobs?.set(sum, buf);
          } else fail(`合并状态 ${name}/${child} 不是普通文件`);
        }
      }
      continue;
    }
    if (!st.isFile()) fail(`合并状态 ${name} 不是普通文件`);
    const buf = readNoFollow(abs, name);
    const sum = sha256(buf);
    merge.push({ name, sha256: sum });
    blobs?.set(sum, buf);
  }
  return merge;
}

function stashEntries(cwd) {
  const listed = git(['stash', 'list', '--format=%H'], cwd).toString('utf8').trim();
  if (!listed) return [];
  const raw = git(['log', '-g', '--format=%H%x09%gs', 'refs/stash'], cwd).toString('utf8').replace(/\n$/, '');
  if (!raw) fail('stash 引用在，reflog 却是空的');
  return raw.split('\n').map((line) => {
    const tab = line.indexOf('\t');
    const sha = tab >= 0 ? line.slice(0, tab) : line;
    const subject = tab >= 0 ? line.slice(tab + 1) : '';
    if (!/^[0-9a-f]{40}$/.test(sha)) fail(`stash 记录认不出：${line.slice(0, 80)}`);
    if (subject.includes('\n') || subject.startsWith('-')) fail(`stash 说明不能归档：${sha}`);
    const parents = git(['rev-parse', `${sha}^@`], cwd)
      .toString('utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    if (parents.length < 2 || parents.some((parent) => !/^[0-9a-f]{40}$/.test(parent))) {
      fail(`stash ${sha} 的父提交不完整`);
    }
    return { sha, parents, subject };
  });
}

function addOids(text, into) {
  for (const line of text.split('\n')) {
    const sha = line.split(/[\s]/)[0];
    if (/^[0-9a-f]{40}$/.test(sha)) into.add(sha);
  }
}

function addIndexOids(indexInfo, into) {
  for (const line of indexInfo.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const left = tab >= 0 ? line.slice(0, tab) : line;
    const sha = left.split(' ')[1];
    if (!/^[0-9a-f]{40}$/.test(sha ?? '')) fail(`索引行认不出：${line.slice(0, 80)}`);
    into.add(sha);
  }
}

/** 和 complex-preserve.ts 的 indexCanonical 必须逐字相同。stage 行相等不算索引相等。 */
function indexCanonical(indexInfo, indexFlags, resolveUndo) {
  return `stage\n${indexInfo}flags\n${indexFlags}\nresolve-undo\n${resolveUndo}\n`;
}

const INDEX_FLAG_KNOWN = (0x3000 | 0x4000 | 0x8000 | 0x20000000 | 0x40000000 | 0x80000000) >>> 0;
const INDEX_EXTENSIONS = new Set(['TREE', 'REUC', 'UNTR', 'FSMN', 'EOIE', 'IEOT', 'sdir']);

function parseIndex(buf) {
  if (buf.length < 32 || buf.subarray(0, 4).toString('latin1') !== 'DIRC') fail('索引签名不对，不能保全');
  const version = buf.readUInt32BE(4);
  const count = buf.readUInt32BE(8);
  if (version !== 2 && version !== 3) fail(`索引版本 ${version} 不能完整保全，保留原树`);
  const end = buf.length - 20;
  if (end < 12) fail('索引被截断');
  const sum = createHash('sha1').update(buf.subarray(0, end)).digest();
  if (!sum.equals(buf.subarray(end))) fail('索引校验和不对，不能保全');
  let off = 12;
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    if (off + 62 > end) fail('索引条目被截断');
    const flags16 = buf.readUInt16BE(off + 60);
    let flags = flags16;
    let nameAt = off + 62;
    if ((flags16 & 0x4000) !== 0) {
      if (off + 64 > end) fail('索引扩展标志被截断');
      flags = (flags16 | (buf.readUInt16BE(off + 62) << 16)) >>> 0;
      nameAt = off + 64;
    }
    const nameLenField = flags16 & 0x0fff;
    let nameLen = nameLenField;
    if (nameLenField === 0x0fff) {
      let cursor = nameAt;
      while (cursor < end && buf[cursor] !== 0) cursor += 1;
      nameLen = cursor - nameAt;
    }
    if (nameAt + nameLen >= end || buf[nameAt + nameLen] !== 0) fail('索引文件名被截断');
    const semantic = (flags & ~0x0fff) >>> 0;
    const unknown = (semantic & ~INDEX_FLAG_KNOWN) >>> 0;
    const name = buf.subarray(nameAt, nameAt + nameLen).toString('utf8');
    if (unknown !== 0) fail(`索引有不能保全的标志 ${unknown.toString(16)}：${name}`);
    const stage = (flags16 & 0x3000) >> 12;
    lines.push(`${stage} ${semantic.toString(16)} ${name}`);
    const entrySize = (nameAt - off + nameLen + 8) & ~7;
    if (entrySize < nameAt - off + nameLen + 1) fail('索引条目长度不对');
    off += entrySize;
    if (off > end) fail('索引条目越界');
  }
  let resolveUndo = null;
  let resolveUndoOids = [];
  while (off + 8 <= end) {
    const sig = buf.subarray(off, off + 4).toString('latin1');
    const size = buf.readUInt32BE(off + 4);
    off += 8;
    if (off + size > end) fail('索引扩展被截断');
    const body = buf.subarray(off, off + size);
    off += size;
    if (sig === 'link') fail('分离索引不能自包含保全，保留原树');
    if (sig === 'REUC') {
      if (resolveUndo !== null) fail('索引里有两段 resolve-undo，认不出');
      const parsed = parseResolveUndo(body);
      resolveUndo = parsed.text;
      resolveUndoOids = parsed.oids;
    } else if (!INDEX_EXTENSIONS.has(sig)) fail(`索引扩展 ${sig} 不能保全，保留原树`);
  }
  if (off !== end) fail('索引尾部对不上');
  return { indexFlags: lines.join('\n'), resolveUndo: resolveUndo ?? '', resolveUndoOids };
}

/**
 * REUC：路径 NUL，三个八进制模式各以 NUL 结尾（没有这一层写 "0"），再按非零模式依次跟 20 字节二进制对象号。
 * 这些对象常常只被 resolve-undo 指着，不在引用、reflog 和当前索引里，要进对象闭包。子模块提交保全不了，拒绝。
 */
function parseResolveUndo(body) {
  const lines = [];
  const oids = [];
  let at = 0;
  const field = (what) => {
    const end = body.indexOf(0, at);
    if (end < 0) fail(`resolve-undo ${what}被截断`);
    const value = body.subarray(at, end).toString('utf8');
    at = end + 1;
    return value;
  };
  while (at < body.length) {
    const path = field('路径');
    if (!path) fail('resolve-undo 路径是空的');
    const modes = [];
    for (let stage = 1; stage <= 3; stage += 1) {
      const text = field('模式');
      if (!/^[0-7]{1,7}$/.test(text)) fail(`resolve-undo 模式认不出：${path}`);
      const mode = Number.parseInt(text, 8);
      if (mode !== 0 && mode !== 0o100644 && mode !== 0o100755 && mode !== 0o120000) {
        fail(`resolve-undo 里的模式 ${text} 不能保全：${path}`);
      }
      modes.push(mode);
    }
    const parts = [];
    for (const mode of modes) {
      if (mode === 0) {
        parts.push('0 -');
        continue;
      }
      if (at + 20 > body.length) fail(`resolve-undo 对象号被截断：${path}`);
      const oid = body.subarray(at, at + 20).toString('hex');
      at += 20;
      oids.push(oid);
      parts.push(`${mode.toString(8)} ${oid}`);
    }
    lines.push(`${path}\t${parts.join(' ')}`);
  }
  return { text: lines.join('\n'), oids };
}

function resolveObject(expr, cwd) {
  if (/^[0-9a-f]{40}$/.test(expr)) {
    const kind = spawnSync(gitBin, ['cat-file', '-t', expr], { cwd, env: gitEnv() });
    if (kind.status !== 0) fail(`对象缺失：${expr}`);
    return expr;
  }
  const result = spawnSync(gitBin, ['rev-parse', '--verify', `${expr}^{object}`], { cwd, env: gitEnv() });
  if (result.status !== 0) fail(`序列里的提交认不出：${expr.slice(0, 80)}`);
  const sha = result.stdout.toString('utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) fail(`序列里的提交认不出：${expr.slice(0, 80)}`);
  return sha;
}

const CLOSED = new Set();

function addClosure(sha, cwd, into) {
  if (CLOSED.has(sha)) return;
  CLOSED.add(sha);
  into.add(sha);
  const kind = spawnSync(gitBin, ['cat-file', '-t', sha], { cwd, env: gitEnv() });
  if (kind.status !== 0) fail(`对象缺失：${sha}`);
  const type = kind.stdout.toString('utf8').trim();
  if (type === 'blob') return;
  if (type === 'commit') {
    addOids(git(['rev-list', '--objects', sha], cwd).toString('utf8'), into);
    return;
  }
  if (type === 'tag') {
    const peeled = git(['rev-parse', '--verify', `${sha}^{}`], cwd)
      .toString('utf8')
      .trim();
    if (!/^[0-9a-f]{40}$/.test(peeled)) fail(`标签 ${sha} 指的对象认不出`);
    addClosure(peeled, cwd, into);
    return;
  }
  if (type === 'tree') {
    for (const line of git(['ls-tree', '-r', '-t', sha], cwd).toString('utf8').split('\n')) {
      if (!line) continue;
      const matched = /^[0-9]+ (?:blob|tree|commit) ([0-9a-f]{40})\b/.exec(line);
      if (!matched?.[1]) fail(`树 ${sha} 里有认不出的对象`);
      into.add(matched[1]);
    }
    return;
  }
  fail(`对象类型不能归档：${type} ${sha}`);
}

function pointerLines(name, text) {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.length > 0);
  if (lines.length === 0) fail(`${name} 没有合并头，不能保全`);
  for (const line of lines) {
    if (!/^[0-9a-f]{40}$/.test(line)) fail(`${name} 里有认不出的合并头：${line.slice(0, 80)}`);
  }
  return lines;
}

const TODO_FILES = new Set(['todo', 'git-rebase-todo', 'done']);
const COMMIT_CMDS = new Set([
  'pick',
  'p',
  'revert',
  'reword',
  'r',
  'edit',
  'e',
  'squash',
  's',
  'fixup',
  'f',
  'drop',
  'd',
]);
const SKIP_CMDS = new Set(['exec', 'x', 'break', 'b', 'label', 'l', 'noop', 'n', 'update-ref']);

function todoObjects(name, text, cwd) {
  const found = [];
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const cmd = parts[0] ?? '';
    if (SKIP_CMDS.has(cmd)) continue;
    if (cmd === 'reset') {
      const arg = parts[1] ?? '';
      if (!arg) fail(`${name} 的 reset 缺参数`);
      if (/^[0-9a-f]{4,40}$/.test(arg)) found.push(resolveObject(arg, cwd));
      continue;
    }
    if (cmd === 'merge' || cmd === 'm') {
      const flag = parts.indexOf('-C') >= 0 ? parts.indexOf('-C') : parts.indexOf('-c');
      if (flag >= 0) {
        const sha = parts[flag + 1];
        if (!sha || sha.startsWith('-')) fail(`${name} 的 merge 缺提交：${line.slice(0, 80)}`);
        found.push(resolveObject(sha, cwd));
      }
      continue;
    }
    if (COMMIT_CMDS.has(cmd)) {
      let sha = parts[1] ?? '';
      if (
        (cmd === 'fixup' || cmd === 'f' || cmd === 'squash' || cmd === 's') &&
        (sha === '-C' || sha === '-c')
      ) {
        sha = parts[2] ?? '';
      }
      if (!sha || sha.startsWith('-')) fail(`${name} 的序列指令缺提交：${line.slice(0, 80)}`);
      found.push(resolveObject(sha, cwd));
      continue;
    }
    fail(`${name} 有不支持的序列指令：${line.slice(0, 80)}`);
  }
  return found;
}

function sequenceObjects(itemName, text, cwd) {
  const top = itemName.split('/')[0] ?? '';
  const base = itemName.split('/').pop() ?? '';
  if (POINTER.has(top) && itemName === top) return pointerLines(itemName, text);
  if (top !== 'sequencer' && top !== 'rebase-merge' && top !== 'rebase-apply') return [];
  if (TODO_FILES.has(base)) return todoObjects(itemName, text, cwd);
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.length > 0);
  if (lines.length > 0 && lines.every((line) => /^[0-9a-f]{40}$/.test(line))) return lines;
  fail(`不支持的序列状态 ${itemName}，不能只存文字就删树`);
  return [];
}

function rejectSplitIndex(cwd) {
  const configured = spawnSync(gitBin, ['config', '--get', '--type=bool', 'core.splitIndex'], {
    cwd,
    env: gitEnv(),
  });
  if (configured.status === 0 && configured.stdout.toString('utf8').trim() === 'true') {
    fail('分离索引不能自包含保全，保留原树');
  }
  if (configured.status !== 0 && configured.status !== 1) fail('看分离索引没看成');
  for (const arg of ['--absolute-git-dir', '--git-common-dir']) {
    const rel = git(['rev-parse', arg], cwd).toString('utf8').trim();
    const abs = rel.startsWith('/') ? rel : join(cwd, rel);
    let names;
    try {
      names = boundedNames(abs);
    } catch (error) {
      fail(`列 Git 目录失败：${error instanceof Error ? error.message : '读不了'}`);
    }
    if (names.some((name) => name.startsWith('sharedindex'))) fail('分离索引不能自包含保全，保留原树');
  }
}

// v3 不保留 shallow 边界：浅仓的对象闭包不完整，只会晚到独立恢复才缺对象。采集前就拒绝，不支持浅历史保全。
// 读不到、命令失败、输出认不出都当失败，不把空输出或 0 当完整仓。
function rejectShallow(cwd) {
  const probe = spawnSync(gitBin, ['rev-parse', '--is-shallow-repository'], { cwd, env: gitEnv() });
  if (probe.error || probe.status !== 0) fail('浅仓判定没看成，保留原树');
  const answer = probe.stdout.toString('utf8').trim();
  if (answer === 'true') fail('浅仓不能自包含保全，保留原树');
  if (answer !== 'false') fail('浅仓判定认不出，保留原树');
}

function readIndexBytes(cwd) {
  rejectSplitIndex(cwd);
  const format = git(['rev-parse', '--show-object-format'], cwd).toString('utf8').trim();
  if (format !== 'sha1') fail(`对象格式 ${format || '空的'} 不能完整保全索引，保留原树`);
  const lockRel = gitPath('index.lock', cwd);
  const lockAbs = lockRel.startsWith('/') ? lockRel : join(cwd, lockRel);
  try {
    lstatSync(lockAbs);
    fail('索引锁还在，不能保全，保留原树');
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
      fail('看索引锁没看成');
    }
  }
  const rel = gitPath('index', cwd);
  const abs = rel.startsWith('/') ? rel : join(cwd, rel);
  let st;
  try {
    st = lstatSync(abs);
  } catch (error) {
    fail(`读索引失败：${error instanceof Error ? error.message : '读不了'}`);
  }
  if (st.isSymbolicLink()) fail('索引是符号链接，不归档');
  if (!st.isFile()) fail('索引不是普通文件，不能保全');
  return readNoFollow(abs, 'index');
}

function mergeText(cwd, name) {
  const top = name.split('/')[0] ?? '';
  const rest = name.slice(top.length + 1);
  const rel = gitPath(top, cwd);
  const abs = rel.startsWith('/') ? rel : join(cwd, rel);
  return readNoFollow(rest ? join(abs, rest) : abs, name);
}

function collect(cwd, keepBytes, restoredObjects = false) {
  CLOSED.clear();
  metadataRead = 0;
  visitedPaths = 0;
  rejectShallow(cwd);
  const blobs = keepBytes ? new Map() : null;
  const head = git(['rev-parse', 'HEAD'], cwd).toString('utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(head)) fail(`HEAD 认不出：${head}`);
  const sym = spawnSync(gitBin, ['symbolic-ref', '-q', 'HEAD'], { cwd, env: gitEnv() });
  if (sym.status !== 0 && sym.status !== 1) fail('看 HEAD 是不是分支没看成');
  const headRef = sym.status === 0 ? sym.stdout.toString('utf8').trim() : null;
  if (headRef && (headRef.includes('\n') || !headRef.startsWith('refs/')))
    fail(`HEAD 引用认不出：${headRef}`);
  const tree = git(['rev-parse', 'HEAD^{tree}'], cwd).toString('utf8').trim();
  const refs = git(['for-each-ref', '--format=%(objectname) %(refname)'], cwd).toString('utf8');
  const identity = `${head}\n${tree}\n${refs}`;
  const indexBytes = readIndexBytes(cwd);
  const indexBlob = sha256(indexBytes);
  const parsedIndex = parseIndex(indexBytes);
  const indexInfo = git(['ls-files', '--stage'], cwd).toString('utf8');
  const indexFlags = parsedIndex.indexFlags;
  const resolveUndo = parsedIndex.resolveUndo;
  const indexSha = sha256(Buffer.from(indexCanonical(indexInfo, indexFlags, resolveUndo)));
  blobs?.set(indexBlob, indexBytes);
  const files = [];
  const ignored = [];
  walk(cwd, '', files, ignored, blobs);
  const merge = readStateFiles(cwd, blobs);
  const stash = stashEntries(cwd);
  const oids = new Set();
  addOids(git(['rev-list', '--objects', '--all', '--reflog'], cwd).toString('utf8'), oids);
  addIndexOids(indexInfo, oids);
  for (const sha of parsedIndex.resolveUndoOids) {
    const kind = spawnSync(gitBin, ['cat-file', '-t', sha], { cwd, env: gitEnv() });
    if (kind.status !== 0) fail(`resolve-undo 指的对象缺失：${sha}`);
    if (kind.stdout.toString('utf8').trim() !== 'blob') fail(`resolve-undo 指的对象不是文件内容：${sha}`);
    oids.add(sha);
  }
  for (const entry of stash) {
    oids.add(entry.sha);
    for (const parent of entry.parents) oids.add(parent);
    addOids(git(['rev-list', '--objects', entry.sha], cwd).toString('utf8'), oids);
  }
  for (const item of merge) {
    const text = mergeText(cwd, item.name).toString('utf8');
    for (const sha of sequenceObjects(item.name, text, cwd)) addClosure(sha, cwd, oids);
  }
  if (restoredObjects) {
    // 仅用于新建的隔离恢复仓：普通 reflog 不重建，但其中的对象必须真实恢复；额外对象也不能藏掉。
    const output = git(
      ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'],
      cwd,
      undefined,
      (MAX_OBJECTS + 1) * 41,
    ).toString('utf8');
    if (output.length === 0 || !output.endsWith('\n')) fail('恢复物理对象枚举输出为空或截断');
    const physical = new Set();
    for (const sha of output.slice(0, -1).split('\n')) {
      if (!/^[0-9a-f]{40}$/.test(sha)) fail('恢复物理对象枚举输出认不出');
      if (physical.has(sha)) fail('恢复物理对象枚举重复');
      physical.add(sha);
      if (physical.size > MAX_OBJECTS) fail('恢复物理对象太多');
      oids.add(sha);
    }
  }
  const list = [...oids].sort();
  if (list.length > MAX_OBJECTS) fail('快照对象太多');
  const output = git(
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    cwd,
    Buffer.from(`${list.join('\n')}\n`),
  ).toString('utf8');
  if (!output.endsWith('\n')) fail('对象闭包核对输出截断');
  const checked = output.slice(0, -1).split('\n');
  if (checked.length !== list.length) fail(`对象闭包对不上：要 ${list.length} 个，看到 ${checked.length} 个`);
  let expanded = 0;
  const objects = checked.map((line, index) => {
    const match = /^([0-9a-f]{40}) (blob|tree|commit|tag) (0|[1-9][0-9]*)$/.exec(line);
    if (!match || match[1] !== list[index]) fail(`对象闭包核对输出认不出：${line}`);
    const [, sha, type, sizeText] = match;
    const size = Number(sizeText);
    expanded += size;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_OBJECT_BYTES || expanded > MAX_TOTAL)
      fail('对象解压预算越界');
    return { sha, type };
  });
  const objectsSha = sha256(Buffer.from(objects.map((item) => `${item.sha} ${item.type}`).join('\n')));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  ignored.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  merge.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (files.length + ignored.length + merge.length > 100000) fail('快照路径太多');
  return {
    state: {
      version: 3,
      head,
      headRef,
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
    },
    blobs: blobs ?? new Map(),
  };
}

async function gitComponent(args, input, name) {
  const path = join(captureRoot, name);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const child = spawn(gitBin, ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], {
    cwd: process.cwd(),
    env: gitEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let length = 0;
  let stderr = '';
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  try {
    for await (const chunk of child.stdout) {
      length += chunk.length;
      captureBytes += chunk.length;
      if (captureBytes > MAX_TOTAL) throw new Error('快照临时组件超过 1GiB');
      writeAll(fd, chunk);
    }
    if ((await closed) !== 0) fail(`git ${args[0]} 失败：${stderr}`);
    if (!length) fail(`git ${args[0]} 输出为空`);
    return { path, length };
  } catch (error) {
    child.kill('SIGKILL');
    await closed.catch(() => {});
    throw error;
  } finally {
    closeSync(fd);
  }
}

async function outputBytes(bytes) {
  if (!process.stdout.write(bytes)) await once(process.stdout, 'drain');
}

async function outputFrame(state, blobs, pack, bundle) {
  const json = Buffer.from(JSON.stringify(state));
  if (json.length > MAX_METADATA) fail('快照状态超过 32MiB');
  let total = 4;
  const components = [
    ['JSON', json],
    ['PACK', pack],
    ['BUNDLE', bundle],
    ...[...blobs.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([sum, value]) => [`BLOB ${sum}`, value]),
  ];
  if (components.length > MAX_COMPONENTS) fail('快照组件太多');
  for (const [name, value] of components) {
    const length = Buffer.isBuffer(value) ? value.length : value.length;
    total += Buffer.byteLength(`${name} ${length}\n`) + length;
  }
  if (total > MAX_TOTAL) fail('快照帧超过 1GiB');
  for (const [name, value] of components) {
    if (Buffer.isBuffer(value)) {
      await outputBytes(Buffer.from(`${name} ${value.length}\n`));
      await outputBytes(value);
      continue;
    }
    const fd = safeOpenFile(value.path);
    try {
      const before = fstatSync(fd);
      if (before.size !== value.length || (before.mode & 0o777) !== 0o600 || before.uid !== process.getuid())
        fail('临时组件身份或长度变化');
      await outputBytes(Buffer.from(`${name} ${value.length}\n`));
      const block = Buffer.alloc(64 * 1024);
      const hash = createHash('sha256');
      let offset = 0;
      while (offset < value.length) {
        const length = readSync(fd, block, 0, Math.min(block.length, value.length - offset), offset);
        if (!length) fail('临时组件读取不全');
        const bytes = block.subarray(0, length);
        hash.update(bytes);
        await outputBytes(bytes);
        offset += length;
      }
      if (!sameFile(before, fstatSync(fd))) fail('临时组件读取期间变化');
      if (name.startsWith('BLOB ') && hash.digest('hex') !== name.slice(5)) fail('源文件内容变化');
    } finally {
      closeSync(fd);
    }
  }
  await outputBytes(Buffer.from('END\n'));
}

function place(root, rel, write) {
  safeRel(rel);
  const parts = rel.split('/');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur = join(cur, parts[i] ?? '');
    if (cur !== root && !cur.startsWith(`${root}${sep}`)) fail(`写出越界：${rel}`);
    try {
      const st = lstatSync(cur);
      if (st.isSymbolicLink()) fail(`恢复路径上有符号链接：${rel}`);
      if (!st.isDirectory()) fail(`恢复路径被文件挡住：${rel}`);
    } catch {
      mkdirSync(cur);
    }
  }
  const leaf = parts[parts.length - 1] ?? '';
  const dest = join(cur, leaf);
  if (dest !== root && !dest.startsWith(`${root}${sep}`)) fail(`写出越界：${rel}`);
  try {
    if (lstatSync(dest).isSymbolicLink()) fail(`恢复目标是符号链接：${rel}`);
  } catch {
    // 还不存在
  }
  write(dest);
}

function rebuildStash(repo, stash) {
  const gitDir = git(['rev-parse', '--absolute-git-dir'], repo).toString('utf8').trim();
  rmSync(join(gitDir, 'logs', 'refs', 'stash'), { force: true });
  const removed = spawnSync(gitBin, ['-C', repo, 'update-ref', '-d', 'refs/stash'], { env: gitEnv() });
  if (removed.status !== 0) {
    const err = removed.stderr?.toString('utf8') ?? '';
    if (!/does not exist|no such|unable to delete/i.test(err)) {
      fail(`清掉恢复仓里的 stash 引用失败：${err.slice(0, 200)}`);
    }
  }
  let prev = null;
  for (const entry of [...stash].reverse()) {
    if (prev === null) {
      git(['update-ref', '--create-reflog', '-m', entry.subject, 'refs/stash', entry.sha], repo);
    } else {
      git(['update-ref', '-m', entry.subject, 'refs/stash', entry.sha, prev], repo);
    }
    prev = entry.sha;
  }
}

function readComponent(component, limit) {
  if (component.length > limit) fail('恢复元数据过大');
  const fd = safeOpenFile(component.path);
  try {
    if (fstatSync(fd).size !== component.length) fail('恢复组件长度不符');
    return readFixedMetadata(fd, component.length);
  } finally {
    closeSync(fd);
  }
}

function copyComponent(component, dest, expected) {
  const fd = safeOpenFile(component.path);
  const output = openSync(
    dest,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const before = fstatSync(fd);
    const hash = createHash('sha256');
    const block = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < component.length) {
      const length = readSync(fd, block, 0, Math.min(block.length, component.length - offset), offset);
      if (!length) fail('恢复组件截断');
      const bytes = block.subarray(0, length);
      hash.update(bytes);
      writeAll(output, bytes);
      offset += length;
    }
    if (
      !sameFile(before, fstatSync(fd)) ||
      before.size !== component.length ||
      hash.digest('hex') !== expected
    )
      fail('恢复组件内容变化');
  } finally {
    closeSync(fd);
    closeSync(output);
  }
}

async function receiveFrame(root) {
  const blobs = new Map();
  const components = {};
  let header = Buffer.alloc(0);
  let current;
  let fd;
  let hash;
  let remaining = 0;
  let total = 0;
  let declared = 0;
  let count = 0;
  let ended = false;
  let lastBlob = '';
  const finish = () => {
    closeSync(fd);
    fd = undefined;
    const sum = hash.digest('hex');
    if (current.name.startsWith('BLOB ')) {
      if (sum !== current.name.slice(5)) fail('恢复BLOB哈希不符');
      blobs.set(sum, current);
    } else components[current.name] = current;
    current = undefined;
  };
  try {
    for await (const chunk of process.stdin) {
      total += chunk.length;
      if (total > MAX_TOTAL) fail('恢复帧超过 1GiB');
      let offset = 0;
      while (offset < chunk.length) {
        if (ended) fail('恢复帧END后有多余字节');
        if (current) {
          const take = Math.min(remaining, chunk.length - offset);
          const bytes = chunk.subarray(offset, offset + take);
          writeAll(fd, bytes);
          hash.update(bytes);
          remaining -= take;
          offset += take;
          if (!remaining) finish();
          continue;
        }
        const nl = chunk.indexOf(10, offset);
        const stop = nl < 0 ? chunk.length : nl;
        if (header.length + stop - offset > 100) fail('恢复帧头太长');
        header = Buffer.concat([header, chunk.subarray(offset, stop)]);
        offset = stop;
        if (nl < 0) break;
        offset += 1;
        if ([...header].some((byte) => byte > 127)) fail('恢复帧头不是ASCII');
        const line = header.toString('ascii');
        declared += header.length + 1;
        header = Buffer.alloc(0);
        if (line === 'END') {
          if (count < 3 || declared > MAX_TOTAL) fail('恢复帧缺组件');
          ended = true;
          continue;
        }
        const matched = /^(JSON|PACK|BUNDLE|BLOB [0-9a-f]{64}) (0|[1-9][0-9]*)$/.exec(line);
        if (!matched) fail('恢复帧头认不出');
        const name = matched[1];
        const length = Number(matched[2]);
        const required = ['JSON', 'PACK', 'BUNDLE'][count];
        if (required ? name !== required : !name.startsWith('BLOB ')) fail('恢复组件重复或次序不符');
        if (name.startsWith('BLOB ')) {
          if (name.slice(5) <= lastBlob) fail('恢复BLOB重复或次序不符');
          lastBlob = name.slice(5);
        }
        if (!Number.isSafeInteger(length) || length < 0 || (name === 'JSON' && length > MAX_METADATA))
          fail('恢复组件长度越界');
        declared += length;
        if (declared + 4 > MAX_TOTAL || ++count > MAX_COMPONENTS) fail('恢复帧超过预算');
        current = { name, path: join(root, `component-${count}`), length };
        fd = openSync(
          current.path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        hash = createHash('sha256');
        remaining = length;
        if (!remaining) finish();
      }
    }
    if (!ended || current || header.length || total !== declared) fail('恢复帧不完整');
    const state = JSON.parse(readComponent(components.JSON, MAX_METADATA).toString('utf8'));
    if (
      !Array.isArray(state.objects) ||
      state.objects.length > MAX_OBJECTS ||
      !Array.isArray(state.files) ||
      state.files.length > 100000 ||
      !Array.isArray(state.merge) ||
      state.merge.length > 100000
    )
      fail('恢复状态数量越界');
    for (const obj of state.objects)
      if (!/^[0-9a-f]{40}$/.test(obj.sha) || !['blob', 'tree', 'commit', 'tag'].includes(obj.type))
        fail('恢复对象声明非法');
    for (const item of state.files) safeRel(item.path);
    for (const item of state.merge) safeRel(item.name);
    return { state, pack: components.PACK, bundle: components.BUNDLE, blobs };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// 在交给Git之前逐对象验证解压预算。丢弃解压块，不持有对象或整个PACK。
// 单次调用私有的顺序预读：一个固定 64KiB 缓冲从起始 offset 往后读，缓冲读空才再读，所以文件字节只读一遍，
// 读取量随包长而不随对象数放大。对象头逐字节和 zlib 输入共用这一个缓冲，zlib 没消费的字节留在里面给下一个对象。
// 缓冲交给 zlib 的那段在异步 write 结束前不会被再读进缓冲覆盖：只有缓冲读空才重读，而读空发生在调用方
// 等完 write、按 bytesWritten 推进之后。
const PACK_READ_WINDOW = 64 * 1024;

function packReader(fd, start) {
  const buffer = Buffer.alloc(PACK_READ_WINDOW);
  let begin = 0;
  let end = 0;
  let next = start;
  const fill = (message) => {
    if (begin < end) return;
    const length = readSync(fd, buffer, 0, buffer.length, next);
    if (!length) fail(message);
    begin = 0;
    end = length;
    next += length;
  };
  return {
    // 下一个未消费字节在文件里的位置。
    offset: () => next - (end - begin),
    byte(message) {
      fill(message);
      return buffer[begin++];
    },
    // 未消费字节的视图；缓冲读空时先续读，文件到头就按 message 拒绝。
    pending(message) {
      fill(message);
      return buffer.subarray(begin, end);
    },
    consume(count) {
      if (!Number.isSafeInteger(count) || count < 0 || count > end - begin) fail('对象压缩流消费量异常');
      begin += count;
    },
  };
}

async function validatePackedBudget(component, expectedCount, initialOffset = 0, exact = true) {
  const fd = safeOpenFile(component.path);
  const before = fstatSync(fd);
  const reader = packReader(fd, initialOffset);
  const byte = () => reader.byte('对象包头截断');
  try {
    const header = Buffer.alloc(12);
    for (let n = 0; n < header.length; n += 1) header[n] = reader.byte('对象包头非法');
    if (header.toString('ascii', 0, 4) !== 'PACK' || ![2, 3].includes(header.readUInt32BE(4)))
      fail('对象包头非法');
    const count = header.readUInt32BE(8);
    if (count > MAX_OBJECTS || (exact ? count !== expectedCount : count > expectedCount))
      fail('对象包数量不符或越界');
    let expanded = 0;
    let inflatedTotal = 0;
    for (let index = 0; index < count; index += 1) {
      let value = byte();
      const type = (value >> 4) & 7;
      let size = value & 15;
      let factor = 16;
      let headerBytes = 1;
      while (value & 128) {
        if (++headerBytes > 10) fail('对象长度头越界');
        value = byte();
        size += (value & 127) * factor;
        factor *= 128;
      }
      if (!Number.isSafeInteger(size) || size > MAX_OBJECT_BYTES) fail('单对象解压超过 256MiB');
      if (![1, 2, 3, 4, 6, 7].includes(type)) fail('对象包类型非法');
      if (type === 6) {
        let n = 0;
        do {
          value = byte();
          if (++n > 10) fail('delta偏移越界');
        } while (value & 128);
      }
      if (type === 7) for (let n = 0; n < 20; n += 1) byte();
      // 输出块不必比对象本身大（多留 1 字节好发现多出来的输出）；zlib 最小块 64 字节。
      const inflater = createInflate({ chunkSize: Math.min(PACK_READ_WINDOW, Math.max(64, size + 1)) });
      let ended = false;
      let error;
      let output = 0;
      let prefix = Buffer.alloc(0);
      let settle;
      const settled = new Promise((resolve) => {
        settle = resolve;
      });
      inflater.on('end', () => {
        ended = true;
        settle();
      });
      inflater.on('error', (cause) => {
        error = cause;
        settle();
      });
      inflater.on('data', (chunk) => {
        output += chunk.length;
        inflatedTotal += chunk.length;
        if (prefix.length < 20) prefix = Buffer.concat([prefix, chunk.subarray(0, 20 - prefix.length)]);
        if (output > size || output > MAX_OBJECT_BYTES || inflatedTotal > MAX_TOTAL)
          inflater.destroy(new Error('对象实际解压越界'));
      });
      try {
        while (!ended && !error) {
          const chunk = reader.pending('对象压缩流截断');
          const consumed = inflater.bytesWritten;
          // 坏流时 zlib 只发 error、不调 write 回调：error / end 也算这一次写完（它们都在 zlib 处理完这块输入之后才发）。
          const written = new Promise((resolve, reject) =>
            inflater.write(chunk, (cause) => (cause ? reject(cause) : resolve())),
          );
          written.catch(() => {});
          await Promise.race([written, settled]);
          if (error) break;
          const used = inflater.bytesWritten - consumed;
          reader.consume(used);
          // zlib 没吃完这块输入就是流结束了；结束事件晚一拍到，等它，别把没吃的字节当成下一块输入。
          if (used < chunk.length) await settled;
        }
        if (error) throw error;
        if (output !== size || !ended) fail('对象解压长度不符');
      } finally {
        inflater.destroy();
      }
      let actual = size;
      if (type === 6 || type === 7) {
        let pos = 0;
        const number = () => {
          let result = 0;
          let scale = 1;
          let b;
          do {
            if (pos >= prefix.length) fail('delta长度头截断');
            b = prefix[pos++];
            result += (b & 127) * scale;
            scale *= 128;
            if (!Number.isSafeInteger(result) || result > MAX_OBJECT_BYTES) fail('delta对象解压超过 256MiB');
          } while (b & 128);
          return result;
        };
        number();
        actual = number();
      }
      expanded += actual;
      if (expanded > MAX_TOTAL) fail('对象解压总量超过 1GiB');
    }
    if (reader.offset() + 20 !== component.length || !sameFile(before, fstatSync(fd)))
      fail('对象包尾部或身份不符');
  } finally {
    closeSync(fd);
  }
}

// 恢复仓里按清单顺序核对象类型。每批一个短命 cat-file，输入输出都有上界，逐行核对象号、类型和行数。
// 缺失、错类型、多行少行、截断、非法输出、退出码非零或被信号杀掉都失败，不当成通过。
const CHECK_BATCH = 4096;
// 40 位对象号、空格、最长的 missing、换行。
const CHECK_LINE = 49;

function checkObjectTypes(repo, objects, mismatch) {
  if (!Array.isArray(objects) || objects.length > MAX_OBJECTS) fail('恢复对象清单数量越界');
  const seen = new Set();
  for (const obj of objects) {
    if (!/^[0-9a-f]{40}$/.test(obj?.sha) || !['blob', 'tree', 'commit', 'tag'].includes(obj.type))
      fail('恢复对象声明非法');
    if (seen.has(obj.sha)) fail(`恢复对象声明重复：${obj.sha}`);
    seen.add(obj.sha);
  }
  for (let start = 0; start < objects.length; start += CHECK_BATCH) {
    const batch = objects.slice(start, start + CHECK_BATCH);
    const out = git(
      ['cat-file', '--buffer', '--batch-check=%(objectname) %(objecttype)'],
      repo,
      Buffer.from(`${batch.map((obj) => obj.sha).join('\n')}\n`),
      batch.length * CHECK_LINE,
    ).toString('latin1');
    if (!out.endsWith('\n')) fail(`批量核对输出截断：第 ${start + 1} 个起`);
    const lines = out.slice(0, -1).split('\n');
    if (lines.length !== batch.length)
      fail(`批量核对行数对不上：要 ${batch.length} 行，看到 ${lines.length} 行`);
    for (let i = 0; i < batch.length; i += 1) {
      const obj = batch[i];
      const line = lines[i];
      if (!line.startsWith(`${obj.sha} `)) fail(`批量核对输出对不上 ${obj.sha}：${line.slice(0, 80)}`);
      const got = line.slice(41);
      if (got === 'missing') fail(mismatch(obj, 'missing'));
      if (!['blob', 'tree', 'commit', 'tag'].includes(got)) fail(`批量核对输出认不出：${line.slice(0, 80)}`);
      if (got !== obj.type) fail(mismatch(obj, got));
    }
  }
}

function bundlePackOffset(component) {
  const fd = safeOpenFile(component.path);
  try {
    const block = Buffer.alloc(64 * 1024);
    let offset = 0;
    let previous = -1;
    while (offset < Math.min(component.length, MAX_METADATA)) {
      const length = readSync(fd, block, 0, Math.min(block.length, MAX_METADATA - offset), offset);
      if (!length) break;
      for (let i = 0; i < length; i += 1) {
        if (previous === 10 && block[i] === 10) return offset + i + 1;
        previous = block[i];
      }
      offset += length;
    }
    fail('成果包头缺失或超过元数据预算');
  } finally {
    closeSync(fd);
  }
}

async function restore(components, root) {
  const { state, pack, bundle, blobs } = components;
  const repo = join(root, 'repo');
  try {
    if (state.version !== 3 || typeof state.indexBlob !== 'string')
      fail('快照状态不是完整版本，不能放行删除');
    await validatePackedBudget(pack, state.objects.length);
    await validatePackedBudget(bundle, state.objects.length, bundlePackOffset(bundle), false);
    git(['init', '-q', '-b', 'main', repo], root);
    // git 2.43 拒绝把成果包抓进当前检出的分支。这个名字不会落成引用。
    git(['symbolic-ref', 'HEAD', 'refs/heads/fleet-restore-unborn'], repo);
    const packFd = safeOpenFile(pack.path);
    try {
      const result = spawnSync(
        gitBin,
        ['index-pack', '--stdin', '--strict', '--threads=1', `--max-input-size=${MAX_TOTAL}`],
        {
          cwd: repo,
          env: gitEnv(),
          stdio: [packFd, 'pipe', 'pipe'],
          maxBuffer: MAX_METADATA,
        },
      );
      if (result.error || result.status !== 0)
        fail(`对象包独立恢复失败：${result.stderr?.toString().slice(0, 400) || result.error?.message}`);
    } finally {
      closeSync(packFd);
    }
    // 成果包导入前单独核对象包：BUNDLE 补上的对象不算原包完整。
    checkObjectTypes(repo, state.objects, (obj, got) =>
      got === 'missing'
        ? `对象包缺 ${obj.sha}，不能靠成果包补`
        : `对象包里的 ${obj.sha} 应是 ${obj.type}，实际 ${got}`,
    );
    const bundlePath = bundle.path;
    const verified = spawnSync(gitBin, ['-C', repo, 'bundle', 'verify', bundlePath], { env: gitEnv() });
    if (verified.status !== 0) fail(`成果包核对失败：${verified.stderr?.toString('utf8').slice(0, 400)}`);
    git(['fetch', '--no-tags', '-q', bundlePath, '+refs/*:refs/*', 'HEAD'], repo);
    if (state.headRef) {
      git(['update-ref', state.headRef, state.head], repo);
      git(['symbolic-ref', 'HEAD', state.headRef], repo);
    } else {
      git(['update-ref', '--no-deref', 'HEAD', state.head], repo);
    }
    try {
      lstatSync(join(repo, '.git', 'objects', 'info', 'alternates'));
      fail('恢复仓出现了 alternates，不能借用别的仓');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
        fail('看恢复仓 alternates 没看成');
      }
    }
    let restoredBytes = 0;
    for (const file of state.files) {
      const component = blobs.get(file.sha256);
      if (!component) fail(`归档缺文件内容：${file.path}`);
      restoredBytes += component.length;
      if (restoredBytes > MAX_TOTAL) fail('恢复工作文件超过 1GiB');
      if (file.kind === 'symlink') {
        const buf = readComponent(component, 4096);
        place(repo, file.path, (dest) => symlinkSync(buf.toString('utf8'), dest));
      } else if (file.kind === 'file') {
        place(repo, file.path, (dest) => {
          copyComponent(component, dest, file.sha256);
          chmodSync(dest, file.mode);
        });
      } else if (file.kind === 'dir') {
        place(repo, file.path, (dest) => {
          mkdirSync(dest, { recursive: true });
          chmodSync(dest, file.mode);
        });
      } else fail(`认不出的文件种类：${file.kind}`);
    }
    const indexComponent = blobs.get(state.indexBlob);
    if (!indexComponent) fail('归档缺索引内容');
    const indexBuf = readComponent(indexComponent, MAX_METADATA);
    if (sha256(indexBuf) !== state.indexBlob) fail('归档索引内容不符');
    const indexRel = gitPath('index', repo);
    const indexAbs = indexRel.startsWith('/') ? indexRel : join(repo, indexRel);
    try {
      if (lstatSync(indexAbs).isSymbolicLink()) fail('恢复索引是符号链接');
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
        fail('看恢复索引没看成');
      }
    }
    writeFileSync(indexAbs, indexBuf, { mode: 0o600 });
    const gitDir = git(['rev-parse', '--absolute-git-dir'], repo).toString('utf8').trim();
    for (const item of state.merge) {
      safeRel(item.name);
      const component = blobs.get(item.sha256);
      if (!component) fail(`合并状态内容对不上：${item.name}`);
      restoredBytes += component.length;
      if (restoredBytes > MAX_TOTAL) fail('恢复状态超过 1GiB');
      const dest = resolve(gitDir, item.name);
      const gitRoot = resolve(gitDir);
      if (dest !== gitRoot && !dest.startsWith(`${gitRoot}${sep}`)) fail(`合并状态越界：${item.name}`);
      mkdirSync(dirname(dest), { recursive: true });
      copyComponent(component, dest, item.sha256);
    }
    rebuildStash(repo, state.stash);
    checkObjectTypes(repo, state.objects, (obj, got) => `对象 ${obj.sha} 应是 ${obj.type}，实际 ${got}`);
    return collect(repo, false, true).state;
  } finally {
    cleanupOperationRoot(root);
  }
}

try {
  if (mode === 'verify') {
    const root = operationRoot('fleet-recovery-');
    try {
      const components = await receiveFrame(root);
      const json = JSON.stringify(await restore(components, root));
      if (Buffer.byteLength(json) > MAX_METADATA) fail('恢复元数据超过 32MiB');
      process.stdout.write(json);
    } finally {
      cleanupOperationRoot(root);
    }
  } else if (mode === 'inspect') {
    const json = JSON.stringify(collect(process.cwd(), false).state);
    if (Buffer.byteLength(json) > MAX_METADATA) fail('快照元数据超过 32MiB');
    process.stdout.write(json);
  } else if (mode === 'capture') {
    captureRoot = operationRoot('fleet-snapshot-');
    const { state, blobs } = collect(process.cwd(), true);
    const oids = Buffer.from(`${state.objects.map((item) => item.sha).join('\n')}\n`);
    // git 2.43 把单独的 --stdin 缩成 --stdin-packs，不能拿来传对象名。
    // --all 会改走修订列表，只被 MERGE_HEAD、sequencer/todo 指着、又不在 refs/reflog/index 的对象进不了包。
    // 这里不传这些开关：pack-objects 默认从标准输入读对象名，清单里的每一个都要进包。
    const pack = await gitComponent(['pack-objects', '--stdout'], oids, 'objects.pack');
    const bundle = await gitComponent(
      ['bundle', 'create', '-', '--all', 'HEAD'],
      undefined,
      'recovery.bundle',
    );
    await outputFrame(state, blobs, pack, bundle);
  } else fail(`不认识的快照模式：${mode}`);
} catch (error) {
  if (process.exitCode !== 1) {
    process.stderr.write(`${error instanceof Error ? error.message : '快照失败'}\n`);
    process.exitCode = 1;
  }
} finally {
  if (captureRoot) cleanupOperationRoot(captureRoot);
}
