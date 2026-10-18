// 任务页「过程」的算法（#3140）：把一段会话的过程记录（run_transcript）切成「步骤」，算每步的小计，再把整张单的几段合成概览。
// 后端的任务详情调这一份，网页的假数据也调这一份，算法只有一份。
//
// 层次：段（对题 / 动手 / 验收，一笔 runs）→ 步骤 → 单个调用。
// - 一步 = Agent 说的一句话（顶层的 assistant 条目），加上它接着做的那串工具调用，到下一次 Agent 又开口说话为止。
//   连着几句话中间没有调用的并成一步，标题取第一句。第一句话之前就先调工具的，这一步没有标题（title 为 null）。
// - 子代理（meta.subagent）里的条目归它所属的那一步，不另起一步。提示词、截断说明不进步骤。
// - 命令数只数 Bash 一类（toolClass = command）；成没成看紧跟着的工具结果：同一个工具、同一层（子代理内外分开）的先进先出对上。
//   没有结果的：这一段还在跑就算「在跑」，已经结束就算「没读到结果」，不拿它当成功。
// - 改了哪些文件、+/−：引擎记 Edit / MultiEdit / Write 时在 meta 写 added、removed（行数）。老记录和别的执行体没写的，
//   文件照列，增删写不出来（added/removed 不带键），计入 uncounted，不拿 0 顶。没成的编辑不算改。
// - 这里只吃轻量行（文本已经按种类截短），不读整段会话。

import type { TranscriptKind } from './transcript.ts';

export type ToolClass = 'command' | 'read' | 'edit' | 'search' | 'agent' | 'other';

const COMMAND = new Set(['bash', 'shell', 'run_terminal_cmd', 'run_command', 'execute', 'exec_command']);
const READ = new Set(['read', 'read_file', 'readfile', 'view']);
const EDIT = new Set([
  'edit',
  'multiedit',
  'write',
  'notebookedit',
  'write_file',
  'writefile',
  'edit_file',
  'editfile',
  'str_replace',
  'apply_patch',
]);
const SEARCH = new Set([
  'grep',
  'glob',
  'ls',
  'list',
  'search',
  'websearch',
  'webfetch',
  'codegraph_explore',
]);
const AGENT = new Set(['agent', 'task']);

/** 工具名归哪一类（认不出的是 other）。名字比大小写、去掉 cursor 那种 ToolCall 后缀。 */
export function toolClass(tool: string | undefined): ToolClass {
  if (!tool) return 'other';
  const t = tool
    .toLowerCase()
    .replace(/toolcall$/, '')
    .trim();
  if (COMMAND.has(t)) return 'command';
  if (READ.has(t)) return 'read';
  if (EDIT.has(t)) return 'edit';
  if (SEARCH.has(t)) return 'search';
  if (AGENT.has(t)) return 'agent';
  return 'other';
}

/** 算法吃的一行：读库时只取这些列，文本按种类截短。 */
export interface ProcessRow {
  seq: number;
  /** ISO 时刻。 */
  at: string;
  kind: TranscriptKind;
  tool?: string | undefined;
  ok?: boolean | undefined;
  /** 助手的话、结论、报错：开头一截；工具调用：输入摘要（Bash 是命令、Edit 是路径）；别的可以空。 */
  text: string;
  /** 子代理里的条目。 */
  sub: boolean;
  /** 引擎记编辑时写的增删行数；没写不带键。 */
  added?: number | undefined;
  removed?: number | undefined;
}

export interface FileChange {
  path: string;
  /** 这个文件被改了几次（成功的编辑调用数）。 */
  edits: number;
  /** 已记下的增删行数合计；这个文件的编辑一次都没记行数就不带键。 */
  added?: number | undefined;
  removed?: number | undefined;
}

export interface ProcessStep {
  /** 从 0 起，这一段里的第几步。 */
  index: number;
  /** Agent 在这一步开头说的那句话（第一行，去掉标记）；没说话就先调工具的是 null。 */
  title: string | null;
  firstSeq: number;
  lastSeq: number;
  startedAt: string;
  /** 下一步开始的时刻；最后一步是这一段收场的时刻（没给就用最后一条的时刻）；这一步还在跑没有。 */
  endedAt?: string | undefined;
  durationMs?: number | undefined;
  running: boolean;
  /** 这一步里有调用没成、报错、或结论没成。 */
  failed: boolean;
  /** 工具调用数（含子代理里的）。 */
  calls: number;
  commands: number;
  commandsFailed: number;
  /** 没读到结果的命令：这一段已经结束，调用有、结果没有。 */
  commandsUnknown: number;
  reads: number;
  /** 没成的调用（任何工具）。 */
  callsFailed: number;
  /** 改了的文件，一个文件一行。 */
  files: FileChange[];
  /** 这一步里已记下的增删行数合计。 */
  added: number;
  removed: number;
  /** 编辑成功了但没记增删行数的次数。 */
  uncounted: number;
}

export interface ProcessCounts {
  commands: number;
  commandsFailed: number;
  commandsRunning: number;
  commandsUnknown: number;
  reads: number;
  files: FileChange[];
  added: number;
  removed: number;
  uncounted: number;
}

export interface RunProcess {
  steps: ProcessStep[];
  /** 这一段每一步加起来的数（在跑的命令数在这里，不在步骤上）。 */
  counts: ProcessCounts;
  /** 一共读了几行；到了每段的条数上限被截断时 truncated 为 true（后面的没记）。 */
  rows: number;
  truncated: boolean;
}

const TITLE_MAX = 120;

/** 一句话的标题：取第一个有字的行，去掉列表、标题、强调的标记，截短。 */
export function stepTitle(text: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw
      .trim()
      .replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/, '')
      .replace(/\*\*|__|`/g, '')
      .trim();
    if (line) return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line;
  }
  return null;
}

interface OpenStep {
  step: ProcessStep;
  hasCalls: boolean;
  files: Map<string, FileChange>;
}

function newStep(index: number, row: ProcessRow, title: string | null): OpenStep {
  return {
    hasCalls: false,
    files: new Map(),
    step: {
      index,
      title,
      firstSeq: row.seq,
      lastSeq: row.seq,
      startedAt: row.at,
      running: false,
      failed: false,
      calls: 0,
      commands: 0,
      commandsFailed: 0,
      commandsUnknown: 0,
      reads: 0,
      callsFailed: 0,
      files: [],
      added: 0,
      removed: 0,
      uncounted: 0,
    },
  };
}

const ms = (iso: string): number => new Date(iso).getTime();

export interface CutOptions {
  /** 这一段还在跑。 */
  running: boolean;
  /** 这一段收场的时刻（ISO）；还在跑、没记的不给。 */
  endedAt?: string | undefined;
  /** 记录员的每段上限：行数到了它就认为后面被截断。 */
  maxEntries?: number | undefined;
}

/** 按序号排好的行 → 步骤和这一段的合计。 */
export function cutSteps(input: readonly ProcessRow[], opts: CutOptions): RunProcess {
  const rows = [...input].sort((a, b) => a.seq - b.seq);
  const open: OpenStep[] = [];
  let cur: OpenStep | undefined;
  // 工具调用等结果：键是「工具名 + 是不是子代理」，先进先出
  const waiting = new Map<string, { step: OpenStep; cls: ToolClass; row: ProcessRow }[]>();

  const begin = (row: ProcessRow, title: string | null): OpenStep => {
    const s = newStep(open.length, row, title);
    open.push(s);
    cur = s;
    return s;
  };

  for (const row of rows) {
    if (row.kind === 'prompt' || row.kind === 'truncated') continue;
    if (row.kind === 'assistant' && !row.sub) {
      if (!cur || cur.hasCalls) begin(row, stepTitle(row.text));
      else if (cur.step.title === null) cur.step.title = stepTitle(row.text);
      if (cur) cur.step.lastSeq = row.seq;
      continue;
    }
    const s = cur ?? begin(row, null);
    s.step.lastSeq = row.seq;
    if (row.kind === 'tool_call') {
      s.hasCalls = true;
      s.step.calls++;
      const cls = toolClass(row.tool);
      if (cls === 'command') s.step.commands++;
      if (cls === 'read') s.step.reads++;
      const key = `${(row.tool ?? '').toLowerCase()}|${row.sub ? 1 : 0}`;
      const q = waiting.get(key) ?? [];
      q.push({ step: s, cls, row });
      waiting.set(key, q);
    } else if (row.kind === 'tool_result') {
      s.hasCalls = true;
      const key = `${(row.tool ?? '').toLowerCase()}|${row.sub ? 1 : 0}`;
      const call = waiting.get(key)?.shift();
      if (!call) continue;
      if (row.ok === false) {
        call.step.step.callsFailed++;
        call.step.step.failed = true;
        if (call.cls === 'command') call.step.step.commandsFailed++;
      } else if (call.cls === 'edit') {
        recordEdit(call.step, call.row);
      }
    } else if (row.kind === 'error') {
      s.step.failed = true;
    } else if (row.kind === 'result' && row.ok === false) {
      s.step.failed = true;
    }
  }

  // 没等到结果的调用：段还在跑 = 在跑；已经结束 = 没读到结果。编辑没等到结果的按「不知道成没成」，不记改。
  let commandsRunning = 0;
  for (const q of waiting.values()) {
    for (const w of q) {
      if (w.cls === 'command') {
        if (opts.running) commandsRunning++;
        else w.step.step.commandsUnknown++;
      }
    }
  }

  const last = open.at(-1);
  const steps = open.map((o, i) => {
    const s = o.step;
    s.files = [...o.files.values()];
    const next = open[i + 1]?.step;
    if (next) {
      s.endedAt = next.startedAt;
    } else if (opts.running) {
      s.running = true;
    } else {
      const lastRow = rows.at(-1);
      const lastAt = lastRow?.at ?? s.startedAt;
      s.endedAt = opts.endedAt && ms(opts.endedAt) >= ms(lastAt) ? opts.endedAt : lastAt;
    }
    if (s.endedAt !== undefined) s.durationMs = Math.max(0, ms(s.endedAt) - ms(s.startedAt));
    return s;
  });
  if (last && opts.running) last.step.running = true;

  return {
    steps,
    counts: sumCounts(steps, commandsRunning),
    rows: rows.length,
    truncated: opts.maxEntries !== undefined && rows.length > opts.maxEntries,
  };
}

function recordEdit(step: OpenStep, call: ProcessRow): void {
  const path = call.text.trim();
  if (!path) return;
  const f = step.files.get(path) ?? { path, edits: 0 };
  f.edits++;
  if (call.added !== undefined || call.removed !== undefined) {
    f.added = (f.added ?? 0) + (call.added ?? 0);
    f.removed = (f.removed ?? 0) + (call.removed ?? 0);
    step.step.added += call.added ?? 0;
    step.step.removed += call.removed ?? 0;
  } else {
    step.step.uncounted++;
  }
  step.files.set(path, f);
}

/** 把几步（或几段）的文件合并：同一个路径的次数、增删相加。 */
export function mergeFiles(lists: readonly (readonly FileChange[])[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const list of lists) {
    for (const f of list) {
      const m = byPath.get(f.path) ?? { path: f.path, edits: 0 };
      m.edits += f.edits;
      if (f.added !== undefined || f.removed !== undefined) {
        m.added = (m.added ?? 0) + (f.added ?? 0);
        m.removed = (m.removed ?? 0) + (f.removed ?? 0);
      }
      byPath.set(f.path, m);
    }
  }
  return [...byPath.values()];
}

function sumCounts(steps: readonly ProcessStep[], commandsRunning: number): ProcessCounts {
  const files = mergeFiles(steps.map((s) => s.files));
  return {
    commands: steps.reduce((n, s) => n + s.commands, 0),
    commandsFailed: steps.reduce((n, s) => n + s.commandsFailed, 0),
    commandsRunning,
    commandsUnknown: steps.reduce((n, s) => n + s.commandsUnknown, 0),
    reads: steps.reduce((n, s) => n + s.reads, 0),
    files,
    added: steps.reduce((n, s) => n + s.added, 0),
    removed: steps.reduce((n, s) => n + s.removed, 0),
    uncounted: steps.reduce((n, s) => n + s.uncounted, 0),
  };
}

/** 几段的合计加在一起（读文件数是各段读的次数相加，不去重：同一个文件读两次算两次）。 */
export function sumRunCounts(runs: readonly ProcessCounts[]): ProcessCounts {
  return {
    commands: runs.reduce((n, r) => n + r.commands, 0),
    commandsFailed: runs.reduce((n, r) => n + r.commandsFailed, 0),
    commandsRunning: runs.reduce((n, r) => n + r.commandsRunning, 0),
    commandsUnknown: runs.reduce((n, r) => n + r.commandsUnknown, 0),
    reads: runs.reduce((n, r) => n + r.reads, 0),
    files: mergeFiles(runs.map((r) => r.files)),
    added: runs.reduce((n, r) => n + r.added, 0),
    removed: runs.reduce((n, r) => n + r.removed, 0),
    uncounted: runs.reduce((n, r) => n + r.uncounted, 0),
  };
}

/**
 * 引擎记一次编辑的增删行数（claude-code 的 Edit / MultiEdit / Write 输入）：
 * Edit 把改前改后两段按行去掉共同的头尾再数；Write 是整份内容按新增数（不读盘上原来的，覆盖写会多算）。
 * 数不出的（输入里没有这几个字段）返回 undefined，调用方不写 meta。
 */
export function countEditLines(
  tool: string,
  input: Record<string, unknown>,
): { added: number; removed: number } | undefined {
  const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const lines = (t: string): string[] => (t === '' ? [] : t.split('\n'));
  const diff = (oldText: string, newText: string): { added: number; removed: number } => {
    const a = lines(oldText);
    const b = lines(newText);
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (
      tail < a.length - head &&
      tail < b.length - head &&
      a[a.length - 1 - tail] === b[b.length - 1 - tail]
    )
      tail++;
    return { added: b.length - head - tail, removed: a.length - head - tail };
  };
  const cls = tool.toLowerCase();
  if (cls === 'edit') {
    const o = s(input.old_string);
    const n = s(input.new_string);
    return o === undefined || n === undefined ? undefined : diff(o, n);
  }
  if (cls === 'multiedit') {
    if (!Array.isArray(input.edits)) return undefined;
    let added = 0;
    let removed = 0;
    for (const e of input.edits) {
      if (typeof e !== 'object' || e === null) return undefined;
      const r = e as Record<string, unknown>;
      const o = s(r.old_string);
      const n = s(r.new_string);
      if (o === undefined || n === undefined) return undefined;
      const d = diff(o, n);
      added += d.added;
      removed += d.removed;
    }
    return { added, removed };
  }
  if (cls === 'write') {
    const c = s(input.content);
    return c === undefined ? undefined : { added: lines(c).length, removed: 0 };
  }
  return undefined;
}
