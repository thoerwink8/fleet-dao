// 规矩字数账（agents/rules-budget.json）：通用段和本仓段各记现字数、上次瘦身后的字数（baseline）、增减明细。
// 对账（checkLedger）进必过检查：只看检出来的文件，字数和账、明细和 baseline 必须对得上。
// 瘦身判定（slimDue）不进必过检查：累计增长（chars - baseline）超阈值，由每天的定时任务（debt.yml）开一张瘦身单（slimRun），不挡 PR。
// 瘦身 PR 合并时把 baseline 重置成新字数、清空明细（旧明细留在 git 历史里）。

export type SectionName = 'general' | 'repo';

export interface LogEntry {
  date: string;
  delta: number;
  why: string;
  /** PR 或决定号 */
  ref: string;
}

export interface Section {
  chars: number;
  baseline: number;
  log: LogEntry[];
}

export interface Ledger {
  threshold: Record<SectionName, number>;
  general: Section;
  repo: Section;
}

export const LABEL: Record<SectionName, string> = { general: '通用段', repo: '本仓段' };
export const SLIM_TITLE = '规矩瘦身：通用段/本仓段累计增长超阈值（机器人开）';
const SLIM_LABELS = ['杂项'];

/** 通用段（agents/shared-rules.md 的两个标记之间）字数。认不出标记就抛，不当 0 字。 */
export function countGeneral(text: string): number {
  const start = text.indexOf('通用段 开始');
  const end = text.indexOf('通用段 结束');
  if (start < 0 || end < start) throw new Error('agents/shared-rules.md 里认不出通用段标记，预算没法算');
  return text.slice(start, end).length;
}

/** 本仓段（仓根 AGENTS.md 「## 本仓（fleet-dao）」起）字数。 */
export function countRepo(text: string): number {
  const at = text.indexOf('## 本仓（fleet-dao）');
  if (at < 0) throw new Error('AGENTS.md 里认不出「## 本仓」标题，预算没法算');
  return text.length - at;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function parseSection(v: unknown, name: string): Section {
  if (!isObj(v) || !isInt(v.chars) || !isInt(v.baseline) || !Array.isArray(v.log))
    throw new Error(`字数账本认不出（${name}：要有 chars、baseline、log）`);
  const log = v.log.map((e, i): LogEntry => {
    if (
      !isObj(e) ||
      typeof e.date !== 'string' ||
      !isInt(e.delta) ||
      typeof e.why !== 'string' ||
      typeof e.ref !== 'string'
    )
      throw new Error(`字数账本认不出（${name}.log[${i}]：要有 date、delta、why、ref）`);
    return { date: e.date, delta: e.delta, why: e.why, ref: e.ref };
  });
  return { chars: v.chars, baseline: v.baseline, log };
}

export function parseLedger(text: string): Ledger {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error('字数账本不是合法 JSON');
  }
  if (!isObj(v) || !isObj(v.threshold) || !isInt(v.threshold.general) || !isInt(v.threshold.repo))
    throw new Error('字数账本认不出（要有 threshold.general、threshold.repo）');
  return {
    threshold: { general: v.threshold.general, repo: v.threshold.repo },
    general: parseSection(v.general, 'general'),
    repo: parseSection(v.repo, 'repo'),
  };
}

const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

/** 对账：实际字数 = 账上 chars；明细 delta 之和 = chars - baseline。返回问题列表，空 = 对得上。 */
export function checkLedger(ledger: Ledger, actual: Record<SectionName, number>): string[] {
  const out: string[] = [];
  for (const name of ['general', 'repo'] as const) {
    const s = ledger[name];
    const n = actual[name];
    if (n !== s.chars) {
      out.push(
        `${LABEL[name]}实际 ${n} 字，账上记 ${s.chars} 字：改了规矩要在 agents/rules-budget.json 的 ${name} 里在账上记一笔：${signed(n - s.chars)} 字、为什么（日期、delta、why、PR/决定号），并把 chars 改成 ${n}`,
      );
      continue;
    }
    const sum = s.log.reduce((a, e) => a + e.delta, 0);
    if (sum !== s.chars - s.baseline)
      out.push(
        `${LABEL[name]}明细 delta 之和 ${signed(sum)} 与 chars - baseline（${signed(s.chars - s.baseline)}）对不上：每次增减都要在账上记一笔 delta；瘦身重置时 baseline 设成新字数、明细清空`,
      );
  }
  return out;
}

export interface SlimItem {
  section: SectionName;
  chars: number;
  baseline: number;
  growth: number;
  threshold: number;
  over: number;
}

/** 累计增长超阈值（严格大于）的段。不红，只是「该瘦身」。 */
export function slimDue(ledger: Ledger): SlimItem[] {
  const out: SlimItem[] = [];
  for (const name of ['general', 'repo'] as const) {
    const s = ledger[name];
    const growth = s.chars - s.baseline;
    const threshold = ledger.threshold[name];
    if (growth > threshold)
      out.push({
        section: name,
        chars: s.chars,
        baseline: s.baseline,
        growth,
        threshold,
        over: growth - threshold,
      });
  }
  return out;
}

export function renderSlimIssue(items: SlimItem[]): string {
  const rows = items.map(
    (i) =>
      `- ${LABEL[i.section]}：现 ${i.chars} 字，baseline ${i.baseline} 字，累计增长 ${i.growth} 字，阈值 ${i.threshold}，超了 ${i.over} 字。`,
  );
  return [
    '## 场景',
    '规矩字数账（agents/rules-budget.json）显示累计增长超了阈值。每次会话都整份读这些规矩，越长越限制模型，该瘦身了。',
    '',
    '## 原话',
    '创始人 2026-10-10：「你想个更合适的方式，而不是通过硬限制，去约束字数；但是要防止膨胀」（#1737）。',
    '',
    '## 已知的模块',
    ...rows,
    '- agents/shared-rules.md、AGENTS.md、agents/rules-budget.json',
    '',
    '## 怎么算做完',
    '三条减法，做到累计增长回到阈值以内：',
    '1. 别处已有的（design、ops、技能、决定记录），只留一句指针；',
    '2. 钩子、测试已经管住的，缩成一句；',
    '3. 同一件事写了两处的，并成一处（并一处）。',
    '瘦身 PR 把账上 chars 改成新字数、baseline 重置成同一个数、明细清空，合并后这张单关掉。',
    '改通用段（agents/shared-rules.md）算改标准，PR 正文写「人闸：改标准」。',
  ].join('\n');
}

export interface SlimGh {
  openIssues(): Promise<{ number: number; title: string; isPr: boolean }[]>;
  createIssue(title: string, body: string, labels: string[]): Promise<number>;
}

export type SlimResult =
  | { kind: 'none' }
  | { kind: 'already'; number: number }
  | { kind: 'opened'; number: number };

/** 定时任务用：该瘦身且没有开着的瘦身单才开一张（同一时刻只开一张）。 */
export async function slimRun(ledger: Ledger, gh: SlimGh): Promise<SlimResult> {
  const due = slimDue(ledger);
  if (!due.length) return { kind: 'none' };
  const open = (await gh.openIssues()).find((i) => !i.isPr && i.title === SLIM_TITLE);
  if (open) return { kind: 'already', number: open.number };
  return { kind: 'opened', number: await gh.createIssue(SLIM_TITLE, renderSlimIssue(due), SLIM_LABELS) };
}
