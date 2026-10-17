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
 * 账本行 → 本次有没有成功的计费模型调用，计费调用有没有绕过中继。
 * @param {LedgerRow[]} rows
 * @param {number} since
 * @param {boolean} mustRelay
 * @returns {{ ok: boolean, why: string }}
 */
export function judgeLedger(rows, since, mustRelay) {
  if (!Number.isFinite(since)) return { ok: false, why: '起针时间认不出，无法核本次调用' };
  const at = (/** @type {LedgerRow} */ r) =>
    typeof r.ts === 'number' ? r.ts : Date.parse(String(r.ts ?? ''));
  if (rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r) || !Number.isFinite(at(r))))
    return { ok: false, why: '账本有格式或时间认不出的行，无法确认属于本次调用' };
  const fresh = rows.filter((r) => at(r) >= since);
  const calls = [];
  for (const row of fresh) {
    const path = typeof row.path === 'string' ? row.path.split('?')[0] : '';
    // 本地辅助请求即使 2xx 也不证明模型消耗了云端额度。
    if (/^\/(?:v1\/)?(?:models(?:\/[^/]+)?|messages\/count_tokens)$/.test(path ?? '')) continue;
    if (!/^\/(?:v1\/)?(?:messages|responses|chat\/completions)$/.test(path ?? ''))
      return { ok: false, why: '账本有计费路径认不出的请求，不能核成本次模型调用' };
    calls.push(row);
  }
  const served = calls.filter((r) => typeof r.status === 'number' && r.status >= 200 && r.status < 300);
  const offRelay = mustRelay ? calls.filter((r) => r.viaRelay !== true) : [];
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
      why: `账本里没有起针后的成功计费模型调用（共 ${rows.length} 行，起针后 ${fresh.length} 行，计费 ${calls.length} 行）`,
    };
  const hosts = [...new Set(served.map((r) => String(r.upstreamHost ?? '?')))].join('、');
  return {
    ok: true,
    why: `起针后 ${served.length} 次成功计费模型调用（上游 ${hosts}）${mustRelay ? '，全走中继' : ''}`,
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
