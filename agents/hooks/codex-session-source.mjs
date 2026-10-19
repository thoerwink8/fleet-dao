// 仅认当前 Codex rollout 的首条 session_meta；不扫描对话，不把用户正文当身份。
import {
  closeSync,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { cleanSessionId } from './session-id.mjs';

export const MAX_SOURCE_BYTES = 1024 * 1024;
export const MAX_SOURCE_ENTRIES = 4096;
export const MAX_SOURCE_MS = 1000;

/** @typedef {{ kind: 'root'|'child'|'unknown'|'not_codex', code: string }} Source */
/** @param {string} code @returns {Source} */
const unknown = (code) => ({ kind: 'unknown', code });
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value @param {string} key */
const get = (value, key) => (object(value) ? Reflect.get(value, key) : undefined);

/** 不返回原始metadata、路径、异常或正文。
 * @param {unknown} record @param {string} id @returns {Source}
 */
export function classifyCodexMetadata(record, id) {
  const payload = get(record, 'payload');
  if (get(record, 'type') !== 'session_meta' || get(payload, 'id') !== id) return unknown('META_IDENTITY');
  const source = get(payload, 'source');
  const parent = get(payload, 'parent_thread_id');
  const spawn = get(get(source, 'subagent'), 'thread_spawn');
  if (spawn !== undefined) {
    const nested = cleanSessionId(get(spawn, 'parent_thread_id'));
    const depth = get(spawn, 'depth');
    if (
      !nested ||
      nested === id ||
      cleanSessionId(parent) !== nested ||
      !Number.isSafeInteger(depth) ||
      Number(depth) < 1 ||
      typeof get(spawn, 'agent_path') !== 'string' ||
      !get(spawn, 'agent_path')
    )
      return unknown('META_PARENT');
    return { kind: 'child', code: 'THREAD_SPAWN' };
  }
  // 只承认已知交互来源；exec、其他subagent变体和不完整父来源均不猜root。
  if ((source === 'cli' || source === 'vscode') && (parent === undefined || parent === null))
    return { kind: 'root', code: 'INTERACTIVE' };
  return unknown('META_SOURCE');
}

/** @param {NodeJS.ProcessEnv} env @param {unknown} hookId @param {boolean} hookSource @returns {{ id: string } | { error: Source }} */
function currentId(env, hookId, hookSource) {
  const thread = env.CODEX_THREAD_ID;
  const session = env.CODEX_SESSION_ID;
  const raw = thread || session || (hookSource ? hookId : undefined);
  const id = cleanSessionId(raw);
  if (!id) return { error: unknown('ENV_IDENTITY') };
  if ((thread && thread !== id) || (session && session !== id)) return { error: unknown('ENV_CONFLICT') };
  if (env.CLAUDE_CODE_SESSION_ID && env.CLAUDE_CODE_SESSION_ID !== id)
    return { error: unknown('CLI_CONFLICT') };
  if (hookId !== null && hookId !== undefined && hookId !== '' && hookId !== id)
    return { error: unknown('EVENT_CONFLICT') };
  return { id };
}

/** 有界本地目录遍历与首记录读取；任何未知都拒绝开on，不借其他home/会话兜底。
 * 时间预算在每次本地IO之间核验，不声称能中止内核中正在进行的文件IO。
 * @param {{ env?: NodeJS.ProcessEnv, hookId?: unknown, expectedCli?: 'codex'|undefined }} [opts] @returns {Source}
 */
export function codexSessionSource({ env = process.env, hookId, expectedCli } = {}) {
  if (!env.CODEX_THREAD_ID && !env.CODEX_SESSION_ID && expectedCli !== 'codex')
    return { kind: 'not_codex', code: 'OTHER_CLI' };
  const selected = currentId(env, hookId, expectedCli === 'codex');
  if ('error' in selected) return selected.error;
  const { id } = selected;
  const started = Date.now();
  let entries = 0;
  const checkTime = () => {
    if (Date.now() - started > MAX_SOURCE_MS) throw new Error('TIME_LIMIT');
  };
  /** @type {string[]} */
  const matches = [];
  const root = join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  let canonical = '';
  /** @type {Map<string, { dev: number, ino: number }>} */
  const directories = new Map();
  /** @param {string} left @param {string} right */
  const samePath = (left, right) =>
    process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  /** @param {string} path */
  function inside(path) {
    const r = relative(canonical, path);
    return r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r);
  }
  /** @param {string} path @param {number} level */
  function visit(path, level) {
    checkTime();
    const st = lstatSync(path);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('SOURCE_TYPE');
    if (!inside(realpathSync(path)) || !samePath(realpathSync(path), path)) throw new Error('SOURCE_CHANGED');
    directories.set(path, { dev: st.dev, ino: st.ino });
    const dir = opendirSync(path);
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        checkTime();
        if (++entries > MAX_SOURCE_ENTRIES) throw new Error('ENTRY_LIMIT');
        if (level < 3) {
          if ((level === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name))
            visit(join(path, entry.name), level + 1);
        } else if (entry.name.startsWith('rollout-') && entry.name.endsWith(`-${id}.jsonl`)) {
          if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('SOURCE_TYPE');
          matches.push(join(path, entry.name));
          if (matches.length > 1) throw new Error('AMBIGUOUS_SOURCE');
        }
      }
    } finally {
      dir.closeSync();
    }
  }
  /** 检查到open之间没有公开的原子openat合同；这里只夹证本次路径和已打开文件身份，不保证防恶意ABA。
   * @param {string} file @param {{ dev: number, ino: number }} identity
   */
  function verify(file, identity) {
    checkTime();
    if (!samePath(realpathSync(root), canonical)) throw new Error('SOURCE_CHANGED');
    for (let path = dirname(file); ; path = dirname(path)) {
      checkTime();
      const expected = directories.get(path);
      const current = lstatSync(path);
      const actual = realpathSync(path);
      if (
        !expected ||
        current.isSymbolicLink() ||
        !current.isDirectory() ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino ||
        !inside(actual) ||
        !samePath(actual, path)
      )
        throw new Error('SOURCE_CHANGED');
      if (samePath(path, canonical)) break;
      if (dirname(path) === path) throw new Error('SOURCE_CHANGED');
    }
    const current = lstatSync(file);
    const actual = realpathSync(file);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      !inside(actual) ||
      !samePath(actual, file)
    )
      throw new Error('SOURCE_CHANGED');
  }
  try {
    // Mirasim 的受配 sessions 根可链接到共享正式来源；只解析此一层，不借默认home兜底。
    const home = lstatSync(env.CODEX_HOME || join(homedir(), '.codex'));
    if (!home.isDirectory() || home.isSymbolicLink()) return unknown('SOURCE_TYPE');
    canonical = realpathSync(root);
    const rootBefore = statSync(canonical);
    if (!rootBefore.isDirectory()) return unknown('SOURCE_TYPE');
    visit(canonical, 0);
    if (matches.length !== 1) return unknown('SOURCE_MISSING');
    const file = matches[0];
    if (!file) return unknown('SOURCE_MISSING');
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) return unknown('SOURCE_TYPE');
    verify(file, before);
    const fd = openSync(file, 'r');
    const bytes = Buffer.alloc(MAX_SOURCE_BYTES);
    const byte = Buffer.alloc(1);
    let length = 0;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
        return unknown('SOURCE_CHANGED');
      verify(file, opened);
      // 单字节到换行为止，连首记录后的用户/工具记录也不预读。
      while (length < MAX_SOURCE_BYTES) {
        checkTime();
        if (readSync(fd, byte, 0, 1, length) !== 1) return unknown('META_INCOMPLETE');
        if (byte[0] === 10) {
          const rootAfter = statSync(canonical);
          if (
            realpathSync(root) !== canonical ||
            rootAfter.dev !== rootBefore.dev ||
            rootAfter.ino !== rootBefore.ino
          )
            return unknown('SOURCE_CHANGED');
          verify(file, opened);
          return classifyCodexMetadata(JSON.parse(bytes.subarray(0, length).toString('utf8')), id);
        }
        bytes[length++] = byte.readUInt8(0);
      }
      return unknown('BYTE_LIMIT');
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    return unknown(
      ['TIME_LIMIT', 'ENTRY_LIMIT', 'SOURCE_TYPE', 'SOURCE_CHANGED', 'AMBIGUOUS_SOURCE'].includes(reason)
        ? reason
        : 'SOURCE_READ',
    );
  }
}
