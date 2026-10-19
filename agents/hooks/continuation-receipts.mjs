// 既有钩子的脱敏执行回执；只追加、有界、写失败不改变原决策，不读提示或工具参数。
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

export const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
export const MAX_RECEIPT_FILES = 128;
export const MAX_RECEIPT_ROWS = 4096;
const MAX_DIRECTORY_ENTRIES = MAX_RECEIPT_FILES * 2 + 2;
const MAX_ROW_BYTES = 2048;
const EVENTS = new Set(['Command', 'SessionStart', 'PostToolUse', 'Stop']);
const PHASES = new Set([
  'entered',
  'window',
  'bypass',
  'allow',
  'fault',
  'prepared',
  'emitted',
  'association_unknown',
  'same_turn',
  'next_turn_observed',
]);
const DECISIONS = new Set([
  'none',
  'on',
  'off',
  'done',
  'needs-you',
  'headless',
  'machine',
  'subagent',
  'identity_unknown',
  'invalid_input',
  'state_unknown',
  'results_unknown',
  'not_on',
  'expired',
  'paused',
  'queue',
  'block',
  'read_failed',
  'write_failed',
  'same_turn',
  'missing_turn',
  'source_unknown',
]);
const SAFE_CODES = new Set(['EACCES', 'EPERM', 'EEXIST', 'ENOENT', 'ENOSPC', 'EISDIR', 'ENOTDIR']);
/** @param {unknown} value */
export const fingerprint = (value) => createHash('sha256').update(String(value)).digest('hex');
/** @param {unknown} value */
const idOf = (value) =>
  typeof value === 'string' && /^[\w-]{1,128}$/.test(value) ? fingerprint(value) : null;
/** @param {unknown} error */
const codeOf = (error) => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return SAFE_CODES.has(code) ? code : 'IO';
};
/** @typedef {{version: 1, at: string, session: string|null, generation: string|null, event: string, eventKey: string|null, cli: string, source: string, turn: string|null, agent: string|null, phase: string, decision: string, continuation: string|null, originTurn: string|null, results: string[], omittedResults: number}} Receipt */
/** @typedef {{dir: string, session: string|null, generation: string|null, event: string, eventKey: string|null, cli: string, source: string, turn: string|null, agent: string|null, pool: 'session'|'diagnostic', authority: 'machine'|'unknown'|null}} Context */
/** @typedef {Receipt & {pool: 'non-root', authority: 'machine'|'unknown'}} PoolReceipt */
/** 事件身份只能取本次输入；缺失不能用继承环境补成已绑定。CLI家族不作为根来源证据。
 * authority 是入口已算出的原判定：只有 machine/unknown 才改存非根诊断池，allowed 或未传保持原会话日志。
 * @param {string} dir @param {unknown} input @param {unknown} state @param {string} event @param {NodeJS.ProcessEnv} [env]
 * @param {{kind?: string}} [authority]
 * @returns {Context}
 */
export function receiptContext(dir, input, state, event, env = process.env, authority) {
  const prop = (/** @type {unknown} */ obj, /** @type {string} */ key) =>
    obj && typeof obj === 'object' ? Reflect.get(obj, key) : undefined;
  const claude = !!env.CLAUDE_CODE_SESSION_ID,
    codex = !!(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID);
  const cli = claude === codex ? 'unknown' : codex ? 'codex' : 'claude';
  const agent = idOf(prop(input, 'agent_id'));
  return {
    dir,
    session: idOf(prop(input, 'session_id')),
    generation: idOf(prop(state, 'generation')),
    event,
    eventKey: idOf(prop(input, 'tool_use_id')),
    cli,
    source: agent ? 'subagent' : 'unknown',
    agent,
    turn: cli === 'codex' ? idOf(prop(input, 'turn_id')) : null,
    pool: authority?.kind === 'machine' || authority?.kind === 'unknown' ? 'diagnostic' : 'session',
    authority: authority?.kind === 'machine' || authority?.kind === 'unknown' ? authority.kind : null,
  };
}
/** 非根诊断池文件名是固定的64位十六进制，旧版目录准入认得；真实会话号过 idOf 后是其哈希，撞不上这个固定名。 */
const POOL_FILE = fingerprint('fleet-dao:non-root-receipt-diagnostic-pool:v1');
/** @param {string} dir @param {string|null} session @param {boolean} [pool] */
const paths = (dir, session, pool = false) => {
  const root = join(dir, '.receipts');
  const file = join(root, `${pool ? POOL_FILE : (session ?? 'unbound')}.jsonl`);
  return { root, file, lock: `${file}.lock` };
};
/** @param {string} root */
function checkRoot(root) {
  const st = lstatSync(root);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('unsafe');
}
/** @param {string} file */
function checkFile(file) {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('unsafe');
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }
}
/** 新文件准入在目录锁内进行；遍历有界，异常条目不按空目录处理。
 * @param {string} root
 */
function directoryCapacity(root) {
  const directory = opendirSync(root);
  let entries = 0;
  let journals = 0;
  let code = '';
  try {
    for (let item = directory.readSync(); item; item = directory.readSync()) {
      if (++entries > MAX_DIRECTORY_ENTRIES) {
        code = 'LIMIT';
        break;
      }
      if (
        !item.isFile() ||
        !/^(?:(?:[a-f0-9]{64}|unbound)\.jsonl(?:\.lock)?|\.admission\.lock)$/.test(item.name)
      ) {
        code = 'IO';
        break;
      }
      if (item.name.endsWith('.jsonl')) journals++;
    }
  } catch (error) {
    code = codeOf(error);
  }
  try {
    directory.closeSync();
  } catch {
    code = 'IO';
  }
  return code || (journals >= MAX_RECEIPT_FILES || entries + 2 > MAX_DIRECTORY_ENTRIES ? 'LIMIT' : '');
}
/** @param {unknown} value */
const isHash = (value) => value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
/** @param {unknown} value @returns {value is Receipt} */
function isReceipt(value) {
  if (!value || typeof value !== 'object') return false;
  const r = /** @type {Receipt} */ (value);
  return (
    Object.keys(r).sort().join(',') ===
      'agent,at,cli,continuation,decision,event,eventKey,generation,omittedResults,originTurn,phase,results,session,source,turn,version' &&
    r.version === 1 &&
    typeof r.at === 'string' &&
    Number.isFinite(Date.parse(r.at)) &&
    [r.session, r.generation, r.turn, r.agent, r.eventKey, r.continuation, r.originTurn].every(isHash) &&
    EVENTS.has(r.event) &&
    PHASES.has(r.phase) &&
    DECISIONS.has(r.decision) &&
    ['codex', 'claude', 'unknown'].includes(r.cli) &&
    ['subagent', 'unknown'].includes(r.source) &&
    Array.isArray(r.results) &&
    r.results.length <= 16 &&
    r.results.every((v) => typeof v === 'string' && isHash(v)) &&
    Number.isSafeInteger(r.omittedResults) &&
    r.omittedResults >= 0
  );
}
/** 诊断池行：在原回执格式上多 pool/authority 两字段，session 保存原事件指纹（可空），不充当会话身份。
 * @param {unknown} value @returns {value is PoolReceipt}
 */
function isPoolReceipt(value) {
  if (!value || typeof value !== 'object') return false;
  const { pool, authority, ...rest } = /** @type {Record<string, unknown>} */ (value);
  return pool === 'non-root' && (authority === 'machine' || authority === 'unknown') && isReceipt(rest);
}
/** @param {number} fd @param {string|null} session @param {boolean} [pool]
 * @returns {{ok:true, rows:Receipt[], evidence:'observed'|'unknown'}|{ok:false, code:string}}
 */
function readOpened(fd, session, pool = false) {
  const opened = fstatSync(fd);
  if (!opened.isFile()) return { ok: false, code: 'IO' };
  if (opened.size >= MAX_RECEIPT_BYTES) return { ok: false, code: 'LIMIT' };
  if (opened.size === 0) return { ok: true, rows: [], evidence: 'unknown' };
  const capture = Buffer.alloc(MAX_RECEIPT_BYTES);
  let length = 0;
  while (length < capture.length) {
    const n = readSync(fd, capture, length, capture.length - length, length);
    if (n === 0) break;
    length += n;
  }
  const bytes = capture.subarray(0, length);
  if (bytes.length >= MAX_RECEIPT_BYTES) return { ok: false, code: 'LIMIT' };
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.endsWith('\n')) return { ok: false, code: 'CORRUPT' };
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > MAX_RECEIPT_ROWS) return { ok: false, code: 'LIMIT' };
  const rows = lines.map((line) => {
    if (Buffer.byteLength(line) >= MAX_ROW_BYTES) throw new Error();
    const row = JSON.parse(line);
    if (pool ? !isPoolReceipt(row) : !isReceipt(row) || row.session !== session) throw new Error();
    return row;
  });
  return { ok: true, rows, evidence: 'observed' };
}
/** 有锁、损坏、超限均报未知；没有文件也不证明没触发。
 * @param {string} dir @param {string|null} session @param {boolean} [pool]
 * @returns {{ok:true, rows:Receipt[], evidence:'observed'|'unknown'}|{ok:false, code:string}}
 */
export function readReceipts(dir, session, pool = false) {
  const p = paths(dir, session, pool);
  /** @type {number|undefined} */ let fd;
  /** @returns {{ok:true, rows:Receipt[], evidence:'observed'|'unknown'}|{ok:false, code:string}} */
  const read = () => {
    try {
      checkRoot(p.root);
      try {
        statSync(p.lock);
        return { ok: false, code: 'BUSY' };
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error;
      }
      checkFile(p.file);
      fd = openSync(p.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      return readOpened(fd, session, pool);
    } catch (error) {
      return codeOf(error) === 'ENOENT'
        ? { ok: true, rows: [], evidence: 'unknown' }
        : { ok: false, code: codeOf(error) };
    }
  };
  let result = read();
  if (fd !== undefined) {
    try {
      closeSync(fd);
    } catch {
      result = { ok: false, code: 'IO' };
    }
  }
  return result;
}
/** 非根诊断池只读：严格按池格式校验，行里的 session 是原事件指纹而非会话；任何行都不是根执行/续轮/消费证明。
 * @param {string} dir
 */
export const readDiagnosticPool = (dir) => readReceipts(dir, null, true);
/** @param {Context} context @param {{phase:string,decision:string,continuation?:string|null,originTurn?:string|null,results?:string[]}} detail
 * @returns {{ok:true}|{ok:false,code:string}}
 */
export function appendReceipt(context, detail) {
  const pool = context.pool === 'diagnostic';
  const p = paths(context.dir, context.session, pool);
  /** @type {number|undefined} */ let fd;
  /** @type {number|undefined} */ let output;
  /** @type {number|undefined} */ let admission;
  const admissionLock = join(p.root, '.admission.lock');
  /** @returns {{ok:true}|{ok:false,code:string}} */
  const append = () => {
    try {
      const results = detail.results ?? [];
      const row = {
        version: 1,
        at: new Date().toISOString(),
        session: context.session,
        generation: context.generation,
        event: context.event,
        eventKey: context.eventKey,
        cli: context.cli,
        source: context.source,
        turn: context.turn,
        agent: context.agent,
        phase: detail.phase,
        decision: detail.decision,
        continuation: detail.continuation ?? null,
        originTurn: detail.originTurn ?? null,
        results: results.slice(0, 16).map(fingerprint),
        omittedResults: Math.max(0, results.length - 16),
        ...(pool ? { pool: 'non-root', authority: context.authority } : {}),
      };
      if (pool ? !isPoolReceipt(row) : !isReceipt(row)) return { ok: false, code: 'SHAPE' };
      const text = `${JSON.stringify(row)}\n`;
      if (Buffer.byteLength(text) >= MAX_ROW_BYTES) return { ok: false, code: 'ROW_LIMIT' };
      mkdirSync(p.root, { recursive: true, mode: 0o700 });
      checkRoot(p.root);
      checkFile(p.file);
      try {
        lstatSync(p.file);
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error;
        admission = openSync(admissionLock, 'wx', 0o600);
        const limit = directoryCapacity(p.root);
        if (limit) return { ok: false, code: limit };
      }
      // 新会话先过准入才建日志锁，满额尝试不会积累新的会话文件。
      // 一次抢锁，不等、不重试；进程崩溃留锁时明确未知，不能覆盖别人的回执。
      fd = openSync(p.lock, 'wx', 0o600);
      output = openSync(
        p.file,
        constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const target = fstatSync(output);
      if (!target.isFile()) return { ok: false, code: 'IO' };
      const size = target.size;
      if (size + Buffer.byteLength(text) >= MAX_RECEIPT_BYTES) return { ok: false, code: 'LIMIT' };
      const prior = readOpened(output, context.session, pool);
      if (!prior.ok) return prior;
      if (prior.rows.length >= MAX_RECEIPT_ROWS) return { ok: false, code: 'LIMIT' };
      appendFileSync(output, text, { encoding: 'utf8' });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: codeOf(error) };
    }
  };
  let result = append();
  let cleanupOk = true;
  if (output !== undefined) {
    try {
      closeSync(output);
    } catch {
      cleanupOk = false;
      result = { ok: false, code: 'IO' };
    }
  }
  if (fd !== undefined) {
    try {
      closeSync(fd);
    } catch {
      cleanupOk = false;
      result = { ok: false, code: 'IO' };
    }
  }
  if (admission !== undefined) {
    try {
      closeSync(admission);
    } catch {
      cleanupOk = false;
      result = { ok: false, code: 'IO' };
    }
  }
  if (cleanupOk && admission !== undefined) {
    try {
      unlinkSync(admissionLock);
    } catch {
      cleanupOk = false;
      result = { ok: false, code: 'IO' };
    }
  }
  if (cleanupOk && fd !== undefined) {
    try {
      unlinkSync(p.lock);
    } catch {
      result = { ok: false, code: 'IO' };
    }
  }
  return result;
}
/** 回执失败仅固定诊断；不打印原始异常/路径/输入。
 * @param {Context} context @param {Parameters<typeof appendReceipt>[1]} detail
 */
export function noteReceipt(context, detail) {
  const r = appendReceipt(context, detail);
  if (!r.ok) {
    try {
      process.stderr.write(`无人值守执行回执没查成（${r.code}），原钩子决策不变。\n`);
    } catch {
      /* 诊断通道故障也不能改变原决策。 */
    }
  }
  return r;
}
/** 不把同session任意事件、同轮工具或子代理当根续轮，更不标结果已消费。
 * @param {Context} context
 */
export function observeContinuation(context) {
  const read = readReceipts(context.dir, context.session);
  if (!read.ok) {
    noteReceipt(context, { phase: 'fault', decision: 'read_failed' });
    return;
  }
  if (context.session === null || context.generation === null || context.source === 'subagent') return;
  const emitted = read.rows.findLast(
    (r) => r.phase === 'emitted' && r.generation === context.generation && r.continuation !== null,
  );
  if (!emitted) return;
  const phase =
    !context.turn || !emitted.turn
      ? 'association_unknown'
      : context.turn === emitted.turn
        ? 'same_turn'
        : 'next_turn_observed';
  if (
    read.rows.some(
      (r) => r.phase === phase && r.continuation === emitted.continuation && r.turn === context.turn,
    )
  )
    return;
  noteReceipt(context, {
    phase,
    decision:
      phase === 'association_unknown'
        ? 'missing_turn'
        : phase === 'same_turn'
          ? 'same_turn'
          : 'source_unknown',
    continuation: emitted.continuation,
    originTurn: emitted.turn,
  });
}
/** 只读投影：满额保留已验证历史，容量与后续覆盖单列；任何阶段均不宣称模型理解/消费。
 * @param {string} dir @param {unknown} sessionId @param {unknown} [generation]
 */
export function receiptStatus(dir, sessionId, generation = null) {
  const session = idOf(sessionId),
    read = readReceipts(dir, session);
  if (!read.ok)
    return {
      evidence: 'unknown',
      code: read.code,
      capacity: 'unknown',
      coverage: 'unknown',
      rootContinuation: 'unknown',
      resultConsumption: 'unknown',
    };
  const exhausted = read.rows.length >= MAX_RECEIPT_ROWS;
  const current = idOf(generation);
  const rows = read.rows.filter((r) => r.generation === current);
  const latest = rows.at(-1);
  const stages = Object.fromEntries(
    ['SessionStart', 'PostToolUse', 'Stop'].map((event) => {
      const r = rows.findLast((row) => row.event === event && row.phase === 'entered');
      return [event, r ? { evidence: 'observed', at: r.at } : { evidence: 'unknown' }];
    }),
  );
  return {
    evidence: latest ? 'observed' : 'unknown',
    ...(exhausted ? { code: 'LIMIT' } : {}),
    capacity: exhausted ? 'exhausted' : 'available',
    coverage: 'unknown',
    latest: latest
      ? {
          at: latest.at,
          event: latest.event,
          phase: latest.phase,
          decision: latest.decision,
          generation: latest.generation,
        }
      : null,
    rootContinuation: 'unknown',
    resultConsumption: 'unknown',
    stages,
    requestPrepared: rows.some((r) => r.phase === 'prepared'),
    requestEmitted: rows.some((r) => r.phase === 'emitted'),
    faults: rows
      .filter((r) => r.phase === 'fault')
      .slice(-8)
      .map((r) => ({ at: r.at, event: r.event, decision: r.decision })),
    nextTurnObserved: rows.some((r) => r.phase === 'next_turn_observed'),
  };
}
