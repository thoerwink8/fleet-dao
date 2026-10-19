// 根回执的有界最新状态。旧jsonl只读，观测失败不改变无人值守业务。
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const MAX_LATEST_BYTES = 64 * 1024;
const MAX_FILES = 128;
const MAX_ENTRIES = 258;
const MAX_LEGACY_BYTES = 2 * 1024 * 1024;
const legacyName = /^(?:[a-f0-9]{64}|unbound)\.jsonl$/;
const latestName = /^([a-f0-9]{64})\.(latest-v2|next-v2)$/;
const associationRank = { association_unknown: 0, same_turn: 1, next_turn_observed: 2 };
/** @typedef {import('./continuation-receipts.mjs').Receipt} Receipt */
/** @typedef {import('./continuation-receipts.mjs').Context} Context */
/** @typedef {{attempt:string,floor:number,entered:Receipt,prepared:Receipt|null,emitted:Receipt|null,fault:Receipt|null,final:Receipt|null}} StopAttempt */
/** @typedef {{version:2,session:string,generation:string,revision:number,floor:number,latest:Record<string,Receipt|null>,stop:StopAttempt|null,pending:{attempt:string,emitted:Receipt}|null,association:{origin:Receipt,observation:Receipt}|null,knownReplacements:number,knownPendingReplacements:number,unknownLoss:'unknown',coverage:'unknown',rootContinuation:'unknown',resultConsumption:'unknown'}} LatestState */
/** @template T @typedef {{ok:true,state:T|null,identity?:{dev:number,ino:number}}|{ok:false,code:string}} SnapshotRead */
/** @typedef {SnapshotRead<LatestState>} ReadResult */
/** @typedef {{version:2,kind:'diagnostic',revision:number,authority:'machine'|'unknown',receipt:Receipt,knownReplacements:number,unknownLoss:'unknown',coverage:'unknown'}} DiagnosticState */
const diagnosticKey = '0'.repeat(64);
/** @param {unknown} error */
function code(error) {
  const value = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return ['EACCES', 'EPERM', 'EEXIST', 'ENOENT', 'ENOSPC', 'EISDIR', 'ENOTDIR'].includes(value)
    ? value
    : 'IO';
}
/** @param {unknown} value @returns {value is string} */
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
/** @param {unknown} value @returns {value is number} */
const integer = (value) => Number.isSafeInteger(value) && Number(value) >= 0;
/** @param {unknown} value @param {string} keys */
const keysAre = (value, keys) =>
  value !== null && typeof value === 'object' && Object.keys(value).sort().join(',') === keys;
/** @param {unknown} value @param {string} session @param {(row:unknown)=>row is Receipt} rowValid @returns {value is LatestState} */
function stateValid(value, session, rowValid) {
  if (
    !keysAre(
      value,
      'association,coverage,floor,generation,knownPendingReplacements,knownReplacements,latest,pending,resultConsumption,revision,rootContinuation,session,stop,unknownLoss,version',
    )
  )
    return false;
  const s = /** @type {LatestState} */ (value);
  if (
    s.version !== 2 ||
    s.session !== session ||
    !hash(s.generation) ||
    ![s.revision, s.floor, s.knownReplacements, s.knownPendingReplacements].every(integer) ||
    s.revision === 0 ||
    s.knownReplacements !== s.revision - 1 ||
    s.knownPendingReplacements > s.knownReplacements ||
    ![s.unknownLoss, s.coverage, s.rootContinuation, s.resultConsumption].every((x) => x === 'unknown') ||
    !keysAre(s.latest, 'Command,PostToolUse,SessionStart,Stop')
  )
    return false;
  /** @param {unknown} row @returns {row is Receipt} */
  const valid = (row) =>
    rowValid(row) && row.session === s.session && row.generation === s.generation && row.agent === null;
  if (!Object.entries(s.latest).every(([event, row]) => row === null || (valid(row) && row.event === event)))
    return false;
  if (s.stop !== null) {
    const t = s.stop;
    if (
      !keysAre(t, 'attempt,emitted,entered,fault,final,floor,prepared') ||
      !hash(t.attempt) ||
      !integer(t.floor) ||
      t.floor > s.floor ||
      !valid(t.entered) ||
      t.entered.event !== 'Stop' ||
      t.entered.phase !== 'entered' ||
      !['prepared', 'emitted', 'fault', 'final'].every((phase) => {
        const row = Reflect.get(t, phase);
        return (
          row === null ||
          (valid(row) &&
            row.event === 'Stop' &&
            row.turn === t.entered.turn &&
            row.cli === t.entered.cli &&
            row.eventKey === t.entered.eventKey &&
            (phase === 'final' ? ['allow', 'bypass'].includes(row.phase) : row.phase === phase))
        );
      })
    )
      return false;
    if (t.emitted && (!t.prepared || t.emitted.continuation !== t.prepared.continuation)) return false;
    if (t.emitted && t.final) return false;
  }
  if (
    s.pending !== null &&
    (!keysAre(s.pending, 'attempt,emitted') ||
      !hash(s.pending.attempt) ||
      !valid(s.pending.emitted) ||
      s.pending.emitted.event !== 'Stop' ||
      s.pending.emitted.phase !== 'emitted' ||
      !hash(s.pending.emitted.continuation))
  )
    return false;
  if (
    s.stop &&
    s.pending?.attempt === s.stop.attempt &&
    JSON.stringify(s.stop.emitted) !== JSON.stringify(s.pending.emitted)
  )
    return false;
  if (s.association !== null) {
    const a = s.association;
    if (
      !keysAre(a, 'observation,origin') ||
      !valid(a.origin) ||
      !valid(a.observation) ||
      a.origin.phase !== 'emitted' ||
      a.origin.event !== 'Stop' ||
      a.observation.event !== 'PostToolUse' ||
      !Object.hasOwn(associationRank, a.observation.phase) ||
      !hash(a.origin.continuation) ||
      a.origin.continuation !== a.observation.continuation ||
      a.origin.turn !== a.observation.originTurn
    )
      return false;
    const expected =
      !a.origin.turn || !a.observation.turn
        ? 'association_unknown'
        : a.origin.turn === a.observation.turn
          ? 'same_turn'
          : 'next_turn_observed';
    if (a.observation.phase !== expected) return false;
  }
  return true;
}
/** @param {string} path */
function regular(path) {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || !s.isFile()) throw Error('type');
  return s;
}
/** @param {string} root */
function rootDirectory(root) {
  const s = lstatSync(root);
  if (s.isSymbolicLink() || !s.isDirectory()) throw Error('type');
  return s;
}
/** @param {string} root @param {string|null} target @param {string} [newLegacy] */
export function latestBudget(root, target, newLegacy) {
  const dir = opendirSync(root);
  const old = new Set(newLegacy ? [`${newLegacy}.jsonl`] : []);
  const latest = new Set(target ? [target] : []);
  let count = 0;
  let failure = '';
  try {
    for (let item = dir.readSync(); item; item = dir.readSync()) {
      if (++count > MAX_ENTRIES) {
        failure = 'LIMIT';
        break;
      }
      const st = regular(join(root, item.name));
      if (item.name === '.admission.lock') {
        if (st.size !== 0) {
          failure = 'IO';
          break;
        }
      } else if (legacyName.test(item.name)) {
        if (st.size >= MAX_LEGACY_BYTES) {
          failure = 'LIMIT';
          break;
        }
        old.add(item.name);
      } else if (item.name.endsWith('.jsonl.lock') && legacyName.test(item.name.slice(0, -5))) {
        if (st.size !== 0) {
          failure = 'IO';
          break;
        }
        old.add(item.name.slice(0, -5));
      } else {
        const match = latestName.exec(item.name);
        if (!match?.[1] || st.size >= MAX_LATEST_BYTES) {
          failure = 'IO';
          break;
        }
        latest.add(match[1]);
      }
    }
  } catch (error) {
    failure = code(error);
  }
  try {
    dir.closeSync();
  } catch {
    failure = 'IO';
  }
  const reservedSlots = old.size + latest.size * 2;
  const peakEntries = old.size * 2 + latest.size * 2 + 1;
  const reservedBytes = old.size * MAX_LEGACY_BYTES + latest.size * 2 * MAX_LATEST_BYTES;
  if (failure) return { ok: false, code: failure };
  if (reservedSlots > MAX_FILES || peakEntries > MAX_ENTRIES || reservedBytes > MAX_FILES * MAX_LEGACY_BYTES)
    return { ok: false, code: 'LIMIT' };
  return { ok: true, reservedSlots, peakEntries, reservedBytes };
}
/** @template T @param {string} root @param {string} session @param {(value:unknown)=>value is T} validate @returns {SnapshotRead<T>} */
function readCurrent(root, session, validate) {
  const path = join(root, `${session}.latest-v2`);
  let existed = false;
  /** @type {number|undefined} */ let fd;
  /** @type {SnapshotRead<T>} */ let result = { ok: false, code: 'IO' };
  try {
    const before = regular(path);
    existed = true;
    if (!before.size || before.size >= MAX_LATEST_BYTES) result = { ok: false, code: 'CORRUPT' };
    else {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      )
        throw Error('changed');
      const buffer = Buffer.alloc(MAX_LATEST_BYTES);
      let size = 0;
      while (size < buffer.length) {
        const n = readSync(fd, buffer, size, buffer.length - size, size);
        if (!n) break;
        size += n;
      }
      if (size >= MAX_LATEST_BYTES) result = { ok: false, code: 'LIMIT' };
      else {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
        const value = JSON.parse(text);
        const after = regular(path);
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          !text.endsWith('\n')
        )
          throw Error('changed');
        result = validate(value)
          ? { ok: true, state: value, identity: { dev: before.dev, ino: before.ino } }
          : { ok: false, code: 'CORRUPT' };
      }
    }
  } catch (error) {
    result =
      code(error) === 'ENOENT' && !existed
        ? { ok: true, state: null }
        : { ok: false, code: code(error) === 'ENOENT' ? 'IO' : code(error) };
  }
  if (fd !== undefined)
    try {
      closeSync(fd);
    } catch {
      result = { ok: false, code: 'IO' };
    }
  return result;
}
/** @param {string} dir @param {string|null} session @param {(row:unknown)=>row is Receipt} rowValid @returns {ReadResult} */
export function readLatest(dir, session, rowValid) {
  return readSnapshot(dir, session, (value) => stateValid(value, session ?? '', rowValid));
}
/** @template T @param {string} dir @param {string|null} session @param {(value:unknown)=>value is T} validate @returns {SnapshotRead<T>} */
function readSnapshot(dir, session, validate) {
  if (!hash(session)) return { ok: false, code: 'IDENTITY_UNKNOWN' };
  const root = join(dir, '.receipts');
  let existed = false;
  try {
    const before = rootDirectory(root);
    existed = true;
    for (const path of [join(root, '.admission.lock'), join(root, `${session}.next-v2`)]) {
      try {
        lstatSync(path);
        return { ok: false, code: 'BUSY' };
      } catch (error) {
        if (code(error) !== 'ENOENT') throw error;
      }
    }
    const read = readCurrent(root, session, validate);
    const after = rootDirectory(root);
    if (before.dev !== after.dev || before.ino !== after.ino) return { ok: false, code: 'IO' };
    // 写者可能在读取期间进场；不以rename前后的混合快照投影成功。
    for (const path of [join(root, '.admission.lock'), join(root, `${session}.next-v2`)]) {
      try {
        lstatSync(path);
        return { ok: false, code: 'BUSY' };
      } catch (error) {
        if (code(error) !== 'ENOENT') throw error;
      }
    }
    return read;
  } catch (error) {
    return code(error) === 'ENOENT' && !existed
      ? { ok: true, state: null }
      : { ok: false, code: code(error) === 'ENOENT' ? 'IO' : code(error) };
  }
}
/** @param {Context} context */
function liveMatches(context) {
  const live = context.window?.();
  if (!live?.ok || !live.state || typeof live.state !== 'object') return false;
  const generation = Reflect.get(live.state, 'generation');
  const blocks = Reflect.get(live.state, 'totalBlocks');
  // 指纹函数由可信上下文捕获，只核本次业务窗口，不生成或改写它。
  return (
    context.matchesGeneration?.(generation) === true &&
    integer(blocks) &&
    context.blocks !== null &&
    blocks >= context.blocks
  );
}
/** @param {LatestState|null} prior @param {Context} context @param {Receipt} row @returns {{ok:true,state:LatestState}|{ok:false,code:string}} */
export function reduceLatest(prior, context, row) {
  if (context.authority !== 'allowed' || context.agent !== null) return { ok: false, code: 'SOURCE_UNKNOWN' };
  if (!hash(context.session) || !hash(context.generation) || !integer(context.blocks))
    return { ok: false, code: 'WINDOW_UNKNOWN' };
  if (prior && prior.session !== context.session) return { ok: false, code: 'CONFLICT' };
  const reset = prior && prior.generation !== context.generation;
  const s =
    prior && !reset
      ? structuredClone(prior)
      : /** @type {LatestState} */ ({
          version: 2,
          session: context.session,
          generation: context.generation,
          revision: prior?.revision ?? 0,
          floor: 0,
          latest: { Command: null, SessionStart: null, PostToolUse: null, Stop: null },
          stop: null,
          pending: null,
          association: null,
          knownReplacements: prior?.knownReplacements ?? 0,
          knownPendingReplacements:
            (prior?.knownPendingReplacements ?? 0) + (reset && prior?.pending ? 1 : 0),
          unknownLoss: 'unknown',
          coverage: 'unknown',
          rootContinuation: 'unknown',
          resultConsumption: 'unknown',
        });
  if (context.blocks < s.floor) return { ok: false, code: 'STALE' };
  if (row.event === 'Stop') {
    if (!hash(context.attempt)) return { ok: false, code: 'ATTEMPT_UNKNOWN' };
    if (row.phase === 'entered') {
      if (s.stop && s.stop.attempt !== context.attempt && context.blocks <= s.stop.floor)
        return { ok: false, code: 'ORDER_UNKNOWN' };
      if (s.stop?.attempt === context.attempt) return { ok: false, code: 'STALE_STAGE' };
      s.stop = {
        attempt: context.attempt,
        floor: context.blocks,
        entered: row,
        prepared: null,
        emitted: null,
        fault: null,
        final: null,
      };
    } else {
      if (!s.stop || s.stop.attempt !== context.attempt) return { ok: false, code: 'STALE_ATTEMPT' };
      if (s.stop.final && row.phase !== 'fault') return { ok: false, code: 'STALE_STAGE' };
      if (row.phase === 'prepared') {
        if (s.stop.emitted) return { ok: false, code: 'STALE_STAGE' };
        if (!hash(row.continuation) || (s.stop.prepared && s.stop.prepared.continuation !== row.continuation))
          return { ok: false, code: 'CONFLICT' };
        s.stop.prepared = row;
      } else if (row.phase === 'emitted') {
        if (!s.stop.prepared || s.stop.prepared.continuation !== row.continuation || !hash(row.continuation))
          return { ok: false, code: 'REQUEST_UNKNOWN' };
        s.stop.emitted = row;
        if (s.pending && s.pending.emitted.continuation !== row.continuation) s.knownPendingReplacements++;
        s.pending = { attempt: context.attempt, emitted: row };
      } else if (row.phase === 'fault') s.stop.fault = row;
      else {
        if (s.stop.emitted) return { ok: false, code: 'STALE_STAGE' };
        s.stop.final = row;
      }
    }
  }
  if (Object.hasOwn(associationRank, row.phase)) {
    const origin = s.pending?.emitted;
    if (
      !origin ||
      row.event !== 'PostToolUse' ||
      row.continuation !== origin.continuation ||
      row.originTurn !== origin.turn
    )
      return { ok: false, code: 'CONFLICT' };
    const expected =
      !row.turn || !origin.turn
        ? 'association_unknown'
        : row.turn === origin.turn
          ? 'same_turn'
          : 'next_turn_observed';
    if (row.phase !== expected) return { ok: false, code: 'CONFLICT' };
    const previous = s.association;
    if (
      !previous ||
      previous.origin.continuation !== origin.continuation ||
      Reflect.get(associationRank, row.phase) > Reflect.get(associationRank, previous.observation.phase)
    )
      s.association = { origin: structuredClone(origin), observation: row };
  }
  s.latest[row.event] = row;
  s.floor = context.blocks;
  s.revision++;
  if (prior) s.knownReplacements++;
  if (![s.revision, s.knownReplacements, s.knownPendingReplacements].every(integer))
    return { ok: false, code: 'LIMIT' };
  return { ok: true, state: s };
}
/** @param {Context} context @param {Receipt} row @param {(row:unknown)=>row is Receipt} rowValid @returns {{ok:true}|{ok:false,code:string}} */
export function writeLatest(context, row, rowValid) {
  if (context.session === '0'.repeat(64)) return { ok: false, code: 'CONFLICT' };
  if (
    !hash(context.session) ||
    !hash(context.generation) ||
    !integer(context.blocks) ||
    !context.window ||
    !context.matchesGeneration
  )
    return { ok: false, code: 'WINDOW_UNKNOWN' };
  const session = context.session;
  return replaceSnapshot(
    context.dir,
    session,
    (value) => stateValid(value, session, rowValid),
    (prior) => reduceLatest(prior, context, row),
    () => liveMatches(context),
  );
}
/** @template T @param {string} dir @param {string} session @param {(value:unknown)=>value is T} validate
 * @param {(prior:T|null)=>{ok:true,state:T}|{ok:false,code:string}} reduce @param {()=>boolean} binding
 * @returns {{ok:true}|{ok:false,code:string}}
 */
function replaceSnapshot(dir, session, validate, reduce, binding) {
  const root = join(dir, '.receipts');
  const lock = join(root, '.admission.lock');
  const current = join(root, `${session}.latest-v2`);
  const next = join(root, `${session}.next-v2`);
  /** @type {number|undefined} */ let held;
  /** @type {{dev:number,ino:number}|undefined} */ let lockIdentity;
  /** @type {{dev:number,ino:number}|undefined} */ let directoryIdentity;
  /** @type {number|undefined} */ let output;
  /** @type {{ok:true}|{ok:false,code:string}} */ let result = { ok: false, code: 'IO' };
  let safeClose = true;
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const before = rootDirectory(root);
    directoryIdentity = { dev: before.dev, ino: before.ino };
    held = openSync(lock, 'wx', 0o600);
    const acquired = fstatSync(held);
    if (!acquired.isFile()) throw Error('type');
    lockIdentity = { dev: acquired.dev, ino: acquired.ino };
    const budget = latestBudget(root, session);
    if (!budget.ok) result = { ok: false, code: budget.code ?? 'IO' };
    else {
      // 孤立next可能属于未知提交，不删除/接管；原current保持可诊断的BUSY。
      let orphan = false;
      try {
        lstatSync(next);
        orphan = true;
      } catch (error) {
        if (code(error) !== 'ENOENT') throw error;
      }
      if (orphan) result = { ok: false, code: 'BUSY' };
      else {
        const prior = readCurrent(root, session, validate);
        if (!prior.ok) result = prior;
        else if (!binding()) result = { ok: false, code: 'WINDOW_UNKNOWN' };
        else {
          const reduced = reduce(prior.state);
          if (!reduced.ok) result = reduced;
          else if (!validate(reduced.state)) result = { ok: false, code: 'SHAPE' };
          else {
            const text = `${JSON.stringify(reduced.state)}\n`;
            if (Buffer.byteLength(text) >= MAX_LATEST_BYTES) result = { ok: false, code: 'LIMIT' };
            else {
              output = openSync(
                next,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
                0o600,
              );
              const opened = fstatSync(output);
              if (!opened.isFile()) throw Error('type');
              writeFileSync(output, text, { encoding: 'utf8' });
              fsyncSync(output);
              try {
                closeSync(output);
                output = undefined;
              } catch {
                safeClose = false;
                throw Error('close');
              }
              const after = rootDirectory(root);
              if (before.dev !== after.dev || before.ino !== after.ino) throw Error('changed');
              if (!binding()) result = { ok: false, code: 'WINDOW_UNKNOWN' };
              else {
                const staged = regular(next);
                const ownedLock = regular(lock);
                if (
                  staged.dev !== opened.dev ||
                  staged.ino !== opened.ino ||
                  staged.size !== Buffer.byteLength(text) ||
                  ownedLock.dev !== lockIdentity.dev ||
                  ownedLock.ino !== lockIdentity.ino
                )
                  throw Error('changed');
                // 仅替换已验证的同名current。不是跨平台掉电原子性保证。
                if (prior.identity) {
                  const target = regular(current);
                  if (target.dev !== prior.identity.dev || target.ino !== prior.identity.ino)
                    throw Error('changed');
                } else {
                  try {
                    lstatSync(current);
                    throw Error('changed');
                  } catch (error) {
                    if (code(error) !== 'ENOENT') throw error;
                  }
                }
                renameSync(next, current);
                result = binding() ? { ok: true } : { ok: false, code: 'WINDOW_UNKNOWN' };
              }
            }
          }
        }
      }
    }
  } catch (error) {
    result = { ok: false, code: code(error) };
  }
  if (output !== undefined && safeClose)
    try {
      closeSync(output);
    } catch {
      safeClose = false;
      result = { ok: false, code: 'IO' };
    }
  if (held !== undefined)
    try {
      closeSync(held);
    } catch {
      safeClose = false;
      result = { ok: false, code: 'IO' };
    }
  if (held !== undefined && safeClose)
    try {
      const directory = rootDirectory(root);
      const acquired = regular(lock);
      if (
        !directoryIdentity ||
        !lockIdentity ||
        directory.dev !== directoryIdentity.dev ||
        directory.ino !== directoryIdentity.ino ||
        acquired.dev !== lockIdentity.dev ||
        acquired.ino !== lockIdentity.ino
      )
        throw Error('changed');
      unlinkSync(lock);
    } catch {
      result = { ok: false, code: 'IO' };
    }
  return result;
}
/** @param {unknown} value @param {(row:unknown)=>row is Receipt} rowValid @returns {value is DiagnosticState} */
function diagnosticValid(value, rowValid) {
  if (!keysAre(value, 'authority,coverage,kind,knownReplacements,receipt,revision,unknownLoss,version'))
    return false;
  const s = /** @type {DiagnosticState} */ (value);
  return (
    s.version === 2 &&
    s.kind === 'diagnostic' &&
    ['machine', 'unknown'].includes(s.authority) &&
    integer(s.revision) &&
    s.revision > 0 &&
    integer(s.knownReplacements) &&
    s.knownReplacements === s.revision - 1 &&
    s.unknownLoss === 'unknown' &&
    s.coverage === 'unknown' &&
    rowValid(s.receipt)
  );
}
/** @param {string} dir @param {(row:unknown)=>row is Receipt} rowValid */
export function readLatestDiagnostic(dir, rowValid) {
  return readSnapshot(dir, diagnosticKey, (value) => diagnosticValid(value, rowValid));
}
/** 仅一条可覆盖的非根诊断，不追加既有v1池、不生成根执行/消费证明。
 * @param {Context} context @param {Receipt} row @param {(row:unknown)=>row is Receipt} rowValid
 */
export function writeLatestDiagnostic(context, row, rowValid) {
  if (context.authority === 'allowed') return { ok: false, code: 'CONFLICT' };
  return replaceSnapshot(
    context.dir,
    diagnosticKey,
    (value) => diagnosticValid(value, rowValid),
    (prior) => {
      const state = /** @type {DiagnosticState} */ ({
        version: 2,
        kind: 'diagnostic',
        revision: (prior?.revision ?? 0) + 1,
        authority: context.authority === 'machine' ? 'machine' : 'unknown',
        receipt: row,
        knownReplacements: (prior?.knownReplacements ?? -1) + 1,
        unknownLoss: 'unknown',
        coverage: 'unknown',
      });
      return integer(state.revision) && integer(state.knownReplacements)
        ? { ok: true, state }
        : { ok: false, code: 'LIMIT' };
    },
    () => true,
  );
}
/** 只返回当前保留的事实，不承诺历史事件的逐条永久保存。
 * @param {LatestState} state
 */
export function latestRows(state) {
  const rows = [...Object.values(state.latest)];
  if (state.stop)
    rows.push(
      state.stop.entered,
      state.stop.prepared,
      state.stop.emitted,
      state.stop.fault,
      state.stop.final,
    );
  if (state.pending) rows.push(state.pending.emitted);
  if (state.association) rows.push(state.association.origin, state.association.observation);
  const seen = new Set();
  return rows.filter((/** @type {Receipt|null} */ row) => {
    if (!row) return false;
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
