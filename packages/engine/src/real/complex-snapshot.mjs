// 复杂工作树快照。capture 打帧，inspect 只出状态，verify 在临时仓独立恢复后再采集。
// 恢复仓不写 alternates，也不读调用方的 GIT_DIR / GIT_OBJECT_DIRECTORY。
// 对象包只按清单里的对象名打包。抓成果包之前先证明这些对象都在包里，不靠 refs、reflog 或成果包补洞。
// 索引按原始字节写回；指纹带标志和 resolve-undo。源仓上不做 reset、clean、stash drop。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const mode = process.env.FLEET_SNAP_MODE || 'inspect';
const gitBin = process.env.FLEET_GIT || 'git';
const skipDirs = new Set((process.env.FLEET_SKIP_DIRS || '').split('\n').filter(Boolean));
const skipFilePats = (process.env.FLEET_SKIP_FILES || '').split('\n').filter(Boolean);
const envPaths = new Set((process.env.FLEET_ENV_PATHS || '').split('\n').filter(Boolean));
const preserved = new Set((process.env.FLEET_PRESERVED || '').split('\n').filter(Boolean));
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

function git(args, cwd, input) {
  const result = spawnSync(
    gitBin,
    ['-c', 'core.quotePath=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args],
    { cwd, env: gitEnv(), input, maxBuffer: 110 * 1024 * 1024 },
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
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail(`路径不能归档：${String(path).slice(0, 80)}`);
  }
}

function readNoFollow(full, path) {
  let fd;
  try {
    fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    return readFileSync(fd);
  } catch (error) {
    fail(`读文件失败 ${path}：${error instanceof Error ? error.message : '读不了'}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return Buffer.alloc(0);
}

function walk(root, rel, files, ignored, blobs) {
  const abs = rel ? join(root, rel) : root;
  let names;
  try {
    names = readdirSync(abs);
  } catch (error) {
    fail(`列目录失败 ${rel || '.'}：${error instanceof Error ? error.message : '读不了'}`);
  }
  for (const name of names.sort()) {
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
        nested = readdirSync(full);
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
      const buf = readNoFollow(full, path);
      const sum = sha256(buf);
      files.push({ path, kind: 'file', mode: st.mode & 0o777, sha256: sum });
      blobs?.set(sum, buf);
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
    top = readdirSync(gitDir);
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
          entries = readdirSync(dir);
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
      names = readdirSync(abs);
    } catch (error) {
      fail(`列 Git 目录失败：${error instanceof Error ? error.message : '读不了'}`);
    }
    if (names.some((name) => name.startsWith('sharedindex'))) fail('分离索引不能自包含保全，保留原树');
  }
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
  return readFileSync(rest ? join(abs, rest) : abs);
}

function collect(cwd, keepBytes) {
  CLOSED.clear();
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
  const list = [...oids].sort();
  const checked = git(
    ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
    cwd,
    Buffer.from(`${list.join('\n')}\n`),
  )
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  if (checked.length !== list.length) fail(`对象闭包对不上：要 ${list.length} 个，看到 ${checked.length} 个`);
  const objects = checked.map((line) => {
    const [sha, type] = line.split(' ');
    if (!sha || !type || type === 'missing') fail(`对象缺失：${line}`);
    return { sha, type };
  });
  const objectsSha = sha256(Buffer.from(objects.map((item) => `${item.sha} ${item.type}`).join('\n')));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  ignored.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  merge.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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

function frameOf(state, blobs, pack, bundle) {
  const parts = [];
  const add = (name, buf) => {
    parts.push(Buffer.from(`${name} ${buf.length}\n`));
    parts.push(buf);
  };
  add('JSON', Buffer.from(JSON.stringify(state)));
  add('PACK', pack);
  add('BUNDLE', bundle);
  for (const [sum, buf] of [...blobs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) add(`BLOB ${sum}`, buf);
  parts.push(Buffer.from('END\n'));
  return Buffer.concat(parts);
}

function parseFrame(buf) {
  let at = 0;
  const blobs = new Map();
  let state;
  let pack;
  let bundle;
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) fail('快照帧不完整');
    const header = buf.subarray(at, nl).toString('utf8');
    at = nl + 1;
    if (header === 'END') break;
    const matched = /^(JSON|PACK|BUNDLE|BLOB [0-9a-f]{64}) (\d+)$/.exec(header);
    if (!matched?.[1] || !matched[2]) fail(`快照帧认不出：${header.slice(0, 80)}`);
    const len = Number(matched[2]);
    if (!Number.isInteger(len) || at + len > buf.length) fail('快照帧长度不对');
    const body = buf.subarray(at, at + len);
    at += len;
    if (matched[1] === 'JSON') state = JSON.parse(body.toString('utf8'));
    else if (matched[1] === 'PACK') pack = body;
    else if (matched[1] === 'BUNDLE') bundle = body;
    else blobs.set(matched[1].slice(5), Buffer.from(body));
  }
  if (at !== buf.length) fail('快照帧尾部有多余字节');
  if (!state || !pack || !bundle) fail('快照帧缺内容');
  return { state, pack, bundle, blobs };
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

function restore(frame) {
  const { state, pack, bundle, blobs } = parseFrame(frame);
  const root = join(tmpdir(), `fleet-recovery-${process.pid}-${Date.now()}`);
  mkdirSync(root, { mode: 0o700 });
  const repo = join(root, 'repo');
  try {
    if (state.version !== 3 || typeof state.indexBlob !== 'string')
      fail('快照状态不是完整版本，不能放行删除');
    git(['init', '-q', '-b', 'main', repo], root);
    // git 2.43 拒绝把成果包抓进当前检出的分支。这个名字不会落成引用。
    git(['symbolic-ref', 'HEAD', 'refs/heads/fleet-restore-unborn'], repo);
    git(['unpack-objects'], repo, pack);
    for (const obj of state.objects) {
      const got = spawnSync(gitBin, ['-C', repo, 'cat-file', '-t', obj.sha], { env: gitEnv() });
      if (got.status !== 0) fail(`对象包缺 ${obj.sha}，不能靠成果包补`);
      if (got.stdout.toString('utf8').trim() !== obj.type) {
        fail(`对象包里的 ${obj.sha} 应是 ${obj.type}，实际 ${got.stdout.toString('utf8').trim() || '没有'}`);
      }
    }
    const bundlePath = join(root, 'recovery.bundle');
    writeFileSync(bundlePath, bundle, { mode: 0o600 });
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
    for (const file of state.files) {
      const buf = blobs.get(file.sha256);
      if (!buf) fail(`归档缺文件内容：${file.path}`);
      if (sha256(buf) !== file.sha256) fail(`归档内容哈希对不上：${file.path}`);
      if (file.kind === 'symlink') {
        place(repo, file.path, (dest) => symlinkSync(buf.toString('utf8'), dest));
      } else if (file.kind === 'file') {
        place(repo, file.path, (dest) => {
          writeFileSync(dest, buf);
          chmodSync(dest, file.mode);
        });
      } else if (file.kind === 'dir') {
        place(repo, file.path, (dest) => {
          mkdirSync(dest, { recursive: true });
          chmodSync(dest, file.mode);
        });
      } else fail(`认不出的文件种类：${file.kind}`);
    }
    const indexBuf = blobs.get(state.indexBlob);
    if (!indexBuf || sha256(indexBuf) !== state.indexBlob) fail('归档缺索引内容');
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
      const buf = blobs.get(item.sha256);
      if (!buf || sha256(buf) !== item.sha256) fail(`合并状态内容对不上：${item.name}`);
      const dest = resolve(gitDir, item.name);
      const gitRoot = resolve(gitDir);
      if (dest !== gitRoot && !dest.startsWith(`${gitRoot}${sep}`)) fail(`合并状态越界：${item.name}`);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, buf, { mode: 0o600 });
    }
    rebuildStash(repo, state.stash);
    for (const obj of state.objects) {
      const got = git(['cat-file', '-t', obj.sha], repo).toString('utf8').trim();
      if (got !== obj.type) fail(`对象 ${obj.sha} 应是 ${obj.type}，实际 ${got}`);
    }
    return collect(repo, false).state;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  if (mode === 'verify') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    process.stdout.write(JSON.stringify(restore(Buffer.concat(chunks))));
  } else if (mode === 'inspect') {
    process.stdout.write(JSON.stringify(collect(process.cwd(), false).state));
  } else if (mode === 'capture') {
    const { state, blobs } = collect(process.cwd(), true);
    const oids = Buffer.from(`${state.objects.map((item) => item.sha).join('\n')}\n`);
    // git 2.43 把单独的 --stdin 缩成 --stdin-packs，不能拿来传对象名。
    // --all 会改走修订列表，只被 MERGE_HEAD、sequencer/todo 指着、又不在 refs/reflog/index 的对象进不了包。
    // 这里不传这些开关：pack-objects 默认从标准输入读对象名，清单里的每一个都要进包。
    const pack = git(['pack-objects', '--stdout'], process.cwd(), oids);
    if (pack.length === 0) fail('对象包是空的');
    const bundle = git(['bundle', 'create', '-', '--all', 'HEAD'], process.cwd());
    if (bundle.length === 0) fail('成果包是空的');
    process.stdout.write(frameOf(state, blobs, pack, bundle));
  } else fail(`不认识的快照模式：${mode}`);
} catch (error) {
  if (process.exitCode !== 1) {
    process.stderr.write(`${error instanceof Error ? error.message : '快照失败'}\n`);
    process.exitCode = 1;
  }
}
