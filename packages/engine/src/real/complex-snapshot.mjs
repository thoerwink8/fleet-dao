// 复杂工作树快照。capture 打帧，inspect 只出状态，verify 在临时仓独立恢复后再采集。
// 恢复仓不写 alternates，也不读调用方的 GIT_DIR / GIT_OBJECT_DIRECTORY。源仓上不做 reset、clean、stash drop。
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
    if (/^(MERGE_|REBASE|CHERRY_PICK|REVERT_|SQUASH_|BISECT|AUTO_MERGE|ORIG_HEAD|sequencer)/.test(name)) {
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

function mergeText(cwd, name) {
  const top = name.split('/')[0] ?? '';
  const rest = name.slice(top.length + 1);
  const rel = gitPath(top, cwd);
  const abs = rel.startsWith('/') ? rel : join(cwd, rel);
  return readFileSync(rest ? join(abs, rest) : abs);
}

function collect(cwd, keepBytes) {
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
  const indexRaw = git(['ls-files', '--stage', '-z'], cwd);
  const indexInfo = git(['ls-files', '--stage'], cwd).toString('utf8');
  const files = [];
  const ignored = [];
  walk(cwd, '', files, ignored, blobs);
  const merge = readStateFiles(cwd, blobs);
  const stash = stashEntries(cwd);
  const oids = new Set();
  addOids(git(['rev-list', '--objects', '--all', '--reflog'], cwd).toString('utf8'), oids);
  addIndexOids(indexInfo, oids);
  for (const entry of stash) {
    oids.add(entry.sha);
    for (const parent of entry.parents) oids.add(parent);
    addOids(git(['rev-list', '--objects', entry.sha], cwd).toString('utf8'), oids);
  }
  for (const item of merge) {
    const top = item.name.split('/')[0] ?? '';
    if (!POINTER.has(top) || item.name !== top) continue;
    const text = mergeText(cwd, item.name).toString('utf8').trim();
    if (!/^[0-9a-f]{40}$/.test(text)) continue;
    oids.add(text);
    const kind = spawnSync(gitBin, ['cat-file', '-t', text], { cwd, env: gitEnv() });
    if (kind.status !== 0) fail(`合并状态 ${item.name} 指向的对象缺失：${text}`);
    const type = kind.stdout.toString('utf8').trim();
    if (type === 'commit' || type === 'tree' || type === 'tag') {
      addOids(git(['rev-list', '--objects', text], cwd).toString('utf8'), oids);
    }
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
      version: 2,
      head,
      headRef,
      identity,
      indexSha: sha256(indexRaw),
      indexInfo,
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
    git(['init', '-q', '-b', 'main', repo], root);
    // git 2.43 拒绝把成果包抓进当前检出的分支。这个名字不会落成引用。
    git(['symbolic-ref', 'HEAD', 'refs/heads/fleet-restore-unborn'], repo);
    git(['unpack-objects'], repo, pack);
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
    git(['update-index', '--index-info'], repo, Buffer.from(state.indexInfo));
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
    const pack = git(
      ['pack-objects', '--stdout', '--all', '--reflog', '--indexed-objects'],
      process.cwd(),
      oids,
    );
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
