// second-opinion.mjs 拆出来的纯函数（--selftest 覆盖）：认结论行、判会话快照和账本、反方的结论行。

/** @typedef {{ pass: boolean, blocking: number }} Verdict 一行「结论：通过 / 必须改 N 条」（只有 --ping 拿它核会话通不通） */

const DONE = new Set(['done', 'complete', 'completed']);
const FAILED = new Set(['error', 'failed', 'aborted', 'cancelled', 'canceled']);

// ---------- 纯函数（--selftest 覆盖） ----------

/**
 * 最后一行「结论：通过 / 必须改 N 条」。认不出 = null。
 * @param {unknown} text
 * @returns {Verdict | null}
 */
export function parseVerdict(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/[*`_]/g, '').trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? '';
  const m = /^结论\s*[：:]\s*(通过|必须改\s*(\d+)\s*条)\s*$/.exec(last);
  if (!m) return null;
  if (m[1] === '通过') return { pass: true, blocking: 0 };
  const n = Number(m[2]);
  return n > 0 ? { pass: false, blocking: n } : null;
}

/**
 * 快照 → 判断。只有 done 才往下核账本。
 * @param {{ phase?: unknown, error?: unknown, incomplete?: unknown } | null | undefined} view
 * @returns {{ status: 'unknown' | 'failed' | 'running' | 'done', why: string }}
 */
export function judgeSnapshot(view) {
  if (!view || typeof view.phase !== 'string' || !view.phase)
    return { status: 'unknown', why: '快照里没有 phase' };
  const phase = view.phase.toLowerCase();
  if (FAILED.has(phase))
    return { status: 'failed', why: `快照报 ${phase}${view.error ? `：${view.error}` : ''}` };
  if (!DONE.has(phase)) return { status: 'running', why: phase };
  if (view.incomplete === true)
    return {
      status: 'failed',
      why: `快照报 ${phase} 但带着 incomplete${view.error ? `：${view.error}` : ''}`,
    };
  if (view.error) return { status: 'failed', why: `快照报 ${phase}，但带着死因：${view.error}` };
  return { status: 'done', why: phase };
}

/** @typedef {Record<string, unknown>} LedgerRow Mirasim 账本里的一行（读回来的 JSON，字段按用到的几个核） */

/**
 * 账本行 → 起针后有没有成功调用、有没有没走中继的调用。
 * @param {LedgerRow[]} rows
 * @param {number} since
 * @param {boolean} mustRelay
 * @returns {{ ok: boolean, why: string }}
 */
export function judgeLedger(rows, since, mustRelay) {
  const fresh = rows.filter(
    (r) => Number.isFinite(Date.parse(String(r?.ts ?? ''))) && Date.parse(String(r.ts)) >= since - 1000,
  );
  const served = fresh.filter((r) => Number(r.status) >= 200 && Number(r.status) < 300);
  const offRelay = mustRelay ? fresh.filter((r) => r.viaRelay !== true) : [];
  if (offRelay.length > 0) {
    const hosts = [...new Set(offRelay.map((r) => String(r.upstreamHost ?? '?')))].join('、');
    return {
      ok: false,
      why: `有 ${offRelay.length} 次调用没走中继（上游 ${hosts}），可能走了按量计费的路——停用这个垫片，先查清`,
    };
  }
  if (served.length === 0)
    return {
      ok: false,
      why: `账本里没有起针后的成功调用（共 ${rows.length} 行，起针后 ${fresh.length} 行）`,
    };
  const hosts = [...new Set(served.map((r) => String(r.upstreamHost ?? '?')))].join('、');
  return {
    ok: true,
    why: `起针后 ${served.length} 次成功调用（上游 ${hosts}）${mustRelay ? '，全走中继' : ''}`,
  };
}

/**
 * 反方的结论行。认不出 = null。
 * @param {unknown} text
 * @returns {{ agree: boolean, objections: number } | null}
 */
export function parseCritique(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/[*`_]/g, '').trim())
    .filter(Boolean);
  const m = /^结论\s*[：:]\s*(同意|有异议\s*(\d+)\s*条)\s*$/.exec(lines.at(-1) ?? '');
  if (!m) return null;
  if (m[1] === '同意') return { agree: true, objections: 0 };
  const n = Number(m[2]);
  return n > 0 ? { agree: false, objections: n } : null;
}
