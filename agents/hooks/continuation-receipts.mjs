// 既有v1历史只读保留，根事件写有界最新状态；观测失败不改变原决策，不读正文。
import { createHash, randomUUID } from 'node:crypto';
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
import {
  latestRows,
  readLatest,
  readLatestDiagnostic,
  writeLatest,
  writeLatestDiagnostic,
} from './continuation-latest.mjs';

export const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
export const MAX_RECEIPT_FILES = 128;
export const MAX_RECEIPT_ROWS = 4096;
const MAX_DIRECTORY_ENTRIES = MAX_RECEIPT_FILES * 2 + 2;
const MAX_ROW_BYTES = 2048;
// 纯存储键，没有借用任何已知 session 输入的指纹；旧版目录准入仍认得这个名字。
export const DIAGNOSTIC_RECEIPT_KEY = '0'.repeat(64);
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
/** @typedef {'allowed'|'machine'|'unknown'} Authority */
/** @typedef {{version: 1, authority: 'machine'|'unknown', receipt: Receipt}} DiagnosticReceipt */
/** @typedef {()=>{ok:boolean,state?:unknown}} WindowReader */
/** @typedef {{dir: string, session: string|null, generation: string|null, event: string, eventKey: string|null, cli: string, source: string, turn: string|null, agent: string|null, authority: Authority, blocks:number|null, attempt:string|null, window:WindowReader|undefined,matchesGeneration:(value:unknown)=>boolean}} Context */
/** 事件身份只能取本次输入；缺失不能用继承环境补成已绑定。CLI家族不作为根来源证据。
 * authority 由入口传已算好的准入结果；缺失默认 unknown，不在回执层重新推断根来源。
 * expectedCli 仅由可信登记入口传入，不从事件正文选择；它只识别CLI家族，不改变authority。
 * @param {string} dir @param {unknown} input @param {unknown} state @param {string} event @param {NodeJS.ProcessEnv} [env] @param {Authority} [authority] @param {'codex'|undefined} [expectedCli] @param {WindowReader} [window]
 * @returns {Context}
 */
export function receiptContext(
  dir,
  input,
  state,
  event,
  env = process.env,
  authority = 'unknown',
  expectedCli,
  window,
) {
  const prop = (/** @type {unknown} */ obj, /** @type {string} */ key) =>
    obj && typeof obj === 'object' ? Reflect.get(obj, key) : undefined;
  const claude = !!env.CLAUDE_CODE_SESSION_ID,
    codex = expectedCli === 'codex' || !!(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID);
  const cli = claude === codex ? 'unknown' : codex ? 'codex' : 'claude';
  const agent = idOf(prop(input, 'agent_id'));
  const generation = idOf(prop(state, 'generation'));
  const blocks = prop(state, 'totalBlocks');
  return {
    dir,
    session: idOf(prop(input, 'session_id')),
    generation,
    event,
    eventKey: idOf(prop(input, 'tool_use_id')),
    cli,
    source: agent ? 'subagent' : 'unknown',
    agent,
    turn: cli === 'codex' ? idOf(prop(input, 'turn_id')) : null,
    authority,
    blocks: typeof blocks === 'number' && Number.isSafeInteger(blocks) && blocks >= 0 ? blocks : null,
    attempt: event === 'Stop' ? fingerprint(randomUUID()) : null,
    window,
    matchesGeneration: (value) => generation !== null && idOf(value) === generation,
  };
}
/** @param {string} dir @param {string|null} session */
const paths = (dir, session) => {
  const root = join(dir, '.receipts');
  const file = join(root, `${session ?? 'unbound'}.jsonl`);
  return { root, file, lock: `${file}.lock` };
};
/** @param {string} root */
function checkRoot(root) {
  const st = lstatSync(root);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('unsafe');
  return st;
}
/** @param {string} file */
function checkFile(file) {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('unsafe');
    return st;
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
/** @param {unknown} value @returns {value is DiagnosticReceipt} */
function isDiagnosticReceipt(value) {
  if (!value || typeof value !== 'object') return false;
  const r = /** @type {DiagnosticReceipt} */ (value);
  return (
    Object.keys(r).sort().join(',') === 'authority,receipt,version' &&
    r.version === 1 &&
    (r.authority === 'machine' || r.authority === 'unknown') &&
    isReceipt(r.receipt)
  );
}
/** @param {string|null} session @returns {(value:unknown)=>value is Receipt} */
function sessionReceipt(session) {
  /** @param {unknown} value @returns {value is Receipt} */
  function matches(value) {
    return isReceipt(value) && value.session === session;
  }
  return matches;
}
/** @template T @param {number} fd @param {(value:unknown)=>value is T} validate @param {string} [mismatch]
 * @returns {{ok:true, rows:T[], evidence:'observed'|'unknown'}|{ok:false, code:string}}
 */
function readOpened(fd, validate, mismatch = 'IO') {
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
  /** @type {T[]} */
  const rows = [];
  for (const line of lines) {
    if (Buffer.byteLength(line) >= MAX_ROW_BYTES) throw new Error();
    const row = JSON.parse(line);
    if (!validate(row)) return { ok: false, code: mismatch };
    rows.push(row);
  }
  return { ok: true, rows, evidence: 'observed' };
}
/** 有锁、损坏、超限均报未知；不同存储格式使用各自严格验证器。
 * @template T @param {string} dir @param {string|null} key @param {(value:unknown)=>value is T} validate @param {string} [mismatch]
 * @returns {{ok:true, rows:T[], evidence:'observed'|'unknown'}|{ok:false, code:string}}
 */
function readJournal(dir, key, validate, mismatch = 'IO') {
  const p = paths(dir, key);
  /** @type {number|undefined} */ let fd;
  let rootExisted = false;
  /** @returns {{ok:true, rows:T[], evidence:'observed'|'unknown'}|{ok:false, code:string}} */
  const read = () => {
    try {
      const beforeRoot = checkRoot(p.root);
      rootExisted = true;
      try {
        statSync(p.lock);
        return { ok: false, code: 'BUSY' };
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error;
      }
      const before = checkFile(p.file);
      if (!before) {
        const afterRoot = checkRoot(p.root);
        if (beforeRoot.dev !== afterRoot.dev || beforeRoot.ino !== afterRoot.ino) throw Error('changed');
        return { ok: true, rows: [], evidence: 'unknown' };
      }
      fd = openSync(p.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size)
        throw Error('changed');
      const result = readOpened(fd, validate, mismatch);
      const afterRoot = checkRoot(p.root),
        after = checkFile(p.file);
      if (
        !after ||
        beforeRoot.dev !== afterRoot.dev ||
        beforeRoot.ino !== afterRoot.ino ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size
      )
        throw Error('changed');
      try {
        statSync(p.lock);
        return { ok: false, code: 'BUSY' };
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error;
      }
      return result;
    } catch (error) {
      return codeOf(error) === 'ENOENT' && !rootExisted
        ? { ok: true, rows: [], evidence: 'unknown' }
        : { ok: false, code: codeOf(error) === 'ENOENT' ? 'IO' : codeOf(error) };
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
/** 原会话历史始终逐行核 session，不能接受混合诊断池。
 * @param {string} dir @param {string|null} session
 */
export function readReceipts(dir, session) {
  return readJournal(dir, session, sessionReceipt(session));
}
/** 混合池只作非根诊断，保留每条原事件身份，不提供根续轮或消费投影。
 * @param {string} dir
 */
export function readDiagnosticReceipts(dir) {
  return readJournal(dir, DIAGNOSTIC_RECEIPT_KEY, isDiagnosticReceipt, 'CONFLICT');
}
/** @param {Context} context @param {{phase:string,decision:string,continuation?:string|null,originTurn?:string|null,results?:string[]}} detail
 * @returns {{ok:true}|{ok:false,code:string}}
 */
export function appendReceipt(context, detail) {
  try {
    const row = receiptRow(context, detail);
    if (context.authority === 'allowed') {
      if (context.session === DIAGNOSTIC_RECEIPT_KEY) return { ok: false, code: 'CONFLICT' };
      return appendJournal(context.dir, context.session, row, sessionReceipt(context.session));
    }
    const diagnostic = {
      version: /** @type {const} */ (1),
      authority: /** @type {'machine'|'unknown'} */ (context.authority === 'machine' ? 'machine' : 'unknown'),
      receipt: row,
    };
    return appendJournal(context.dir, DIAGNOSTIC_RECEIPT_KEY, diagnostic, isDiagnosticReceipt, true);
  } catch (error) {
    return { ok: false, code: codeOf(error) };
  }
}
/** @param {Context} context @param {Parameters<typeof appendReceipt>[1]} detail @returns {Receipt} */
function receiptRow(context, detail) {
  const results = detail.results ?? [];
  return {
    version: /** @type {const} */ (1),
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
  };
}
/** 共用原有有界安全写入；新混合池不能接管已有空文件或不兼容的历史。
 * @template T @param {string} dir @param {string|null} key @param {T} row
 * @param {(value:unknown)=>value is T} validate @param {boolean} [rejectExistingEmpty]
 * @returns {{ok:true}|{ok:false,code:string}}
 */
function appendJournal(dir, key, row, validate, rejectExistingEmpty = false) {
  const p = paths(dir, key);
  /** @type {number|undefined} */ let fd;
  /** @type {number|undefined} */ let output;
  /** @type {number|undefined} */ let admission;
  const admissionLock = join(p.root, '.admission.lock');
  let creating = false;
  /** @returns {{ok:true}|{ok:false,code:string}} */
  const append = () => {
    try {
      if (!validate(row)) return { ok: false, code: 'SHAPE' };
      const text = `${JSON.stringify(row)}\n`;
      if (Buffer.byteLength(text) >= MAX_ROW_BYTES) return { ok: false, code: 'ROW_LIMIT' };
      mkdirSync(p.root, { recursive: true, mode: 0o700 });
      checkRoot(p.root);
      checkFile(p.file);
      try {
        lstatSync(p.file);
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error;
        creating = true;
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
      if (rejectExistingEmpty && !creating && size === 0) return { ok: false, code: 'CONFLICT' };
      if (size + Buffer.byteLength(text) >= MAX_RECEIPT_BYTES) return { ok: false, code: 'LIMIT' };
      const prior = readOpened(output, validate, rejectExistingEmpty ? 'CONFLICT' : 'IO');
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
  const r =
    context.authority === 'allowed'
      ? writeLatest(context, receiptRow(context, detail), isReceipt)
      : writeLatestDiagnostic(context, receiptRow(context, detail), isReceipt);
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
  if (context.authority !== 'allowed') return;
  if (context.window) {
    const read = readLatest(context.dir, context.session, isReceipt);
    if (!read.ok) {
      noteReceipt(context, { phase: 'fault', decision: 'read_failed' });
      return;
    }
    const emitted = read.state?.generation === context.generation ? read.state.pending?.emitted : null;
    if (!emitted || context.source === 'subagent') return;
    const phase =
      !context.turn || !emitted.turn
        ? 'association_unknown'
        : context.turn === emitted.turn
          ? 'same_turn'
          : 'next_turn_observed';
    if (
      read.state &&
      latestRows(read.state).some(
        (row) =>
          row !== null &&
          row.phase === phase &&
          row.continuation === emitted.continuation &&
          row.turn === context.turn,
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
    return;
  }
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
function legacyReceiptStatus(dir, sessionId, generation = null) {
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

/** @param {string} dir @param {string|null} session */
export function readLatestReceiptState(dir, session) {
  return readLatest(dir, session, isReceipt);
}
/** @param {string} dir */
export function readLatestDiagnosticState(dir) {
  return readLatestDiagnostic(dir, isReceipt);
}
/** 当前保留事实与不可变v1历史分列；新快照不能洗掉旧读取故障或LIMIT。
 * @param {string} dir @param {unknown} sessionId @param {unknown} [generation]
 */
export function receiptStatus(dir, sessionId, generation = null) {
  const legacy = legacyReceiptStatus(dir, sessionId, generation);
  if (idOf(generation) === null)
    return { ...legacy, evidence: 'unknown', latestState: { evidence: 'unknown' } };
  const read = readLatestReceiptState(dir, idOf(sessionId));
  if (!read.ok)
    return {
      ...legacy,
      evidence: 'unknown',
      code: 'code' in legacy ? legacy.code : read.code,
      latestState: { evidence: 'unknown', code: read.code },
    };
  const state = read.state;
  if (!state || state.generation !== idOf(generation))
    return { ...legacy, latestState: { evidence: 'unknown' } };
  const rows = latestRows(state);
  const latest = rows
    .filter((r) => r !== null)
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1);
  const latestState = {
    evidence: 'observed',
    capacity: 'bounded',
    revision: state.revision,
    retention: 'replaceable_latest_state',
    retained: [
      'latest_event_per_kind',
      'latest_stop_attempt',
      'one_emitted_request',
      'one_recent_association',
    ],
    knownReplacements: state.knownReplacements,
    knownPendingReplacements: state.knownPendingReplacements,
    unknownLoss: 'unknown',
    coverage: 'unknown',
  };
  if ('code' in legacy) return { ...legacy, latestState };
  return {
    ...legacy,
    evidence: 'observed',
    latestState,
    latest: latest
      ? {
          at: latest.at,
          event: latest.event,
          phase: latest.phase,
          decision: latest.decision,
          generation: latest.generation,
        }
      : null,
    stages: Object.fromEntries(
      ['SessionStart', 'PostToolUse', 'Stop'].map((event) => {
        const row = state.latest[event];
        return [event, row ? { evidence: 'observed', at: row.at } : { evidence: 'unknown' }];
      }),
    ),
    requestPrepared: !!state.stop?.prepared,
    requestEmitted: !!state.pending,
    nextTurnObserved: state.association?.observation.phase === 'next_turn_observed',
    faults: rows
      .filter((r) => r?.phase === 'fault')
      .map((r) => ({ at: r?.at, event: r?.event, decision: r?.decision })),
  };
}
