// issue 正文里的进度段（纯文本处理，不碰网络）。人写的部分一个字不动，只替换两个标记之间的那一段：
//   <!-- fleet:progress:start as-of=<时刻> --> … <!-- fleet:progress:end -->
// as-of 是这份进度的快照时刻：库里（正文里）的比要写的新，就不写——慢到的旧快照不能盖掉新的。
import type { RepoRef } from './client.ts';
import { inert } from './text.ts';

export const PROGRESS_START = '<!-- fleet:progress:start';
export const PROGRESS_END = '<!-- fleet:progress:end -->';
const START_RE = /<!-- fleet:progress:start(?:\s+as-of=([^\s>]+))?\s*-->/g;

/** 和引擎的 IssueProgress 同形。 */
export interface IssueProgress {
  /** 需求状态（TaskState）。 */
  state: string;
  /** 白话「正在：……」。 */
  current: string;
  done: number;
  total: number;
  subtasks: { key: string; title: string; state: string; prNumber: number | null }[];
  /** 需求文档在仓里的路径（specs/…/需求.md 这类）。 */
  docs: { requirement?: string | undefined; plan?: string | undefined; result?: string | undefined };
}

const TASK_STATE: Record<string, string> = {
  queued: '排队中',
  triaging: '分诊中',
  asking: '等回答',
  planning: '规划中',
  running: '进行中',
  merging: '合并中',
  done: '已完成',
  stopped: '已叫停',
  failed: '失败',
  stalled: '停滞',
};

const SUBTASK_ICON: Record<string, string> = {
  merged: '✅',
  running: '🔄',
  verifying: '🔄',
  in_merge_queue: '🔄',
  pending: '⏳',
  waiting_deps: '⏳',
  waiting_slot: '⏳',
  stopped: '⏹️',
  failed: '❌',
  stalled: '⚠️',
};

export function progressBar(done: number, total: number, cells = 5): string {
  if (total <= 0) return '';
  const filled = Math.max(0, Math.min(cells, Math.round((done / total) * cells)));
  return `${'■'.repeat(filled)}${'□'.repeat(cells - filled)} `;
}

export function renderProgress(
  p: IssueProgress,
  where: { repo: RepoRef; defaultBranch: string; serverUrl?: string | undefined },
  asOf: string,
): string {
  const state = TASK_STATE[p.state] ?? p.state;
  const lines = [`${PROGRESS_START} as-of=${asOf} -->`];
  const now = p.current.trim() ? ` · 正在：${inert(p.current)}` : '';
  lines.push(`**进度**：${progressBar(p.done, p.total)}${p.done}/${p.total} · ${state}${now}`);
  if (p.subtasks.length) {
    // 只写编号，不写 Closes/Fixes（C13）
    const items = p.subtasks.map((s) => {
      const icon = SUBTASK_ICON[s.state] ?? s.state;
      return `${inert(s.key)} ${inert(s.title)} ${icon}${s.prNumber ? ` #${s.prNumber}` : ''}`;
    });
    lines.push(`**子任务**：${items.join(' · ')}`);
  }
  const server = (where.serverUrl ?? 'https://github.com').replace(/\/+$/, '');
  const link = (label: string, path: string | undefined) =>
    path
      ? `[${label}](${server}/${where.repo.owner}/${where.repo.name}/blob/${encodeURIComponent(where.defaultBranch)}/${path
          .split('/')
          .map(encodeURIComponent)
          .join('/')})`
      : null;
  const docs = [
    link('需求', p.docs.requirement),
    link('方案', p.docs.plan),
    link('结果', p.docs.result),
  ].filter(Boolean);
  if (docs.length) lines.push(`**文档**：${docs.join(' · ')}`);
  lines.push('<sub>这一段由引擎自动更新，改了会被覆盖；要说的话写在上面或评论里。</sub>');
  lines.push(PROGRESS_END);
  return lines.join('\n');
}

export interface ParsedBody {
  /** 第一段进度前后的人写部分（原样，不改换行）。 */
  before: string;
  after: string;
  /** 已有进度段的 as-of；没有进度段为 null。 */
  asOf: string | null;
  /** 已有进度段的原文（含标记）；没有为 null。 */
  section: string | null;
}

/** 拆正文：第一段完整的进度段之外都是人写的；多出来的进度段、落单的开始标记都去掉。 */
export function parseBody(body: string): ParsedBody {
  START_RE.lastIndex = 0;
  const start = START_RE.exec(body);
  if (!start) return { before: body, after: '', asOf: null, section: null };
  const endAt = body.indexOf(PROGRESS_END, start.index);
  if (endAt < 0) {
    // 结束标记被人删了：只去掉落单的开始标记，其余当人写的，新进度段追加在末尾
    const rest = body.slice(0, start.index) + body.slice(start.index + start[0].length);
    return { before: stripSections(rest), after: '', asOf: null, section: null };
  }
  const sectionEnd = endAt + PROGRESS_END.length;
  return {
    before: body.slice(0, start.index),
    after: stripSections(body.slice(sectionEnd)),
    asOf: start[1] ?? null,
    section: body.slice(start.index, sectionEnd),
  };
}

function stripSections(text: string): string {
  let out = text;
  for (;;) {
    START_RE.lastIndex = 0;
    const m = START_RE.exec(out);
    if (!m) return out;
    const endAt = out.indexOf(PROGRESS_END, m.index);
    const cut = endAt < 0 ? m.index + m[0].length : endAt + PROGRESS_END.length;
    out = out.slice(0, m.index) + out.slice(cut);
  }
}

/** 放进新进度段：原来有就原地换，没有就追加在末尾（空一行）。 */
export function spliceProgress(body: string, section: string): string {
  const parsed = parseBody(body);
  if (parsed.section !== null) return `${parsed.before}${section}${parsed.after}`;
  const human = parsed.before.replace(/\s+$/, '');
  return human ? `${human}\n\n${section}\n` : `${section}\n`;
}

/** 人写部分（比较用）：去掉进度段，CRLF→LF，去掉行尾与末尾空白。 */
export function humanPart(body: string): string {
  const p = parseBody(body);
  return normalize(`${p.before}${p.after}`);
}

export function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '')
    .replace(/^\s+/, '');
}

/** as-of 比较：ISO 时刻按时间比；读不懂的当最旧。 */
export function isNewer(a: string | null, than: string): boolean {
  if (!a) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(than);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta > tb;
}
