// 任务页「过程」的算法（#3140）：把一笔会话的过程记录（run_transcript）切成「步骤」、算每步的小计，再把一笔的小计合成整张单的。
// 后端读任务详情、读一笔的步骤时调这一份，网页的假数据也调这一份，算法只有一份。
//
// 层次：回合（task_rounds）→ 笔（runs 的一行）→ 步骤 → 调用。这里管后两层：
// - 步骤：Agent 说的一句话（主会话的 assistant 条目）开一步，加上它接着做的那串调用，到下一次 Agent 开口为止。
//   连着几句话中间没有调用的并成一步，标题取第一句；一开头就调工具（还没说话）的单开一步，标题用第一个调用的动词加对象
//   （「运行 pnpm test」）；整笔一句话都没有的，按时间空档切（STEP_GAP_MS 没动静就另起一步）。提示词、截断说明不进步骤。
// - 子代理里的条目（meta.subagent）跟着它出现的位置归当时那一步（步骤的序号范围连续，展开才好读），页面按 subOf 把它们挂在派它的
//   调用下面。
// - 调用和结果只按原生调用号（meta.callId）对：并行同名调用、结果倒序回来也不会错配。没有调用号的老记录不强配，那几条命令的成败
//   写「结果未知」（legacyCalls 点名有几条）。
// - 命令数只数 Bash 一类（toolClass = command）。成败：结果 ok=false 是失败；Mirasim 一类流里没有退出码（exitKnown=false），
//   「完成」不代表成功，记「结果未知」；没有结果的，这一笔还在跑就是「在跑」、已经结束就是「没读到结果」。
// - 改了哪些文件、各增删几行：改文件的调用成功了（结果 ok≠false）才算改；增删行数读结果条目 meta 里的 added / removed（适配器按
//   structuredPatch 等记，见 transcript.ts 的约定），没记的计入 uncounted、文件照列，不拿 0 顶。这是步骤小计；改动卡的文件和增删
//   行数以按头记的 numstat 为准，不靠把每次编辑加起来。
// - 这里只吃轻量行（文本已经按种类截短），不读整段会话。

import type { TranscriptKind } from './transcript.ts';

export type ToolClass = 'command' | 'read' | 'edit' | 'search' | 'agent' | 'other';

/** 各类工具名（小写，去掉 cursor 那种 ToolCall 后缀）。SQL 里的小计用同一份名单（db 的 readRunTallies）。 */
export const COMMAND_TOOLS = [
  'bash',
  'powershell',
  'shell',
  'run_terminal_cmd',
  'run_terminal_command',
  'run_command',
  'execute',
  'exec_command',
] as const;
export const READ_TOOLS = ['read', 'notebookread', 'read_file', 'readfile', 'view'] as const;
export const EDIT_TOOLS = [
  'edit',
  'multiedit',
  'write',
  'notebookedit',
  'write_file',
  'writefile',
  'edit_file',
  'editfile',
  'str_replace',
  'search_replace',
  'apply_patch',
] as const;
const SEARCH_TOOLS = [
  'grep',
  'glob',
  'ls',
  'list',
  'list_dir',
  'search',
  'websearch',
  'webfetch',
  'toolsearch',
];
const AGENT_TOOLS = ['agent', 'task', 'spawn_subagent'];

/** 工具名归一：小写，去掉 cursor 的 ToolCall 后缀。 */
export function toolKey(tool: string | undefined): string {
  return (tool ?? '')
    .toLowerCase()
    .replace(/toolcall$/, '')
    .trim();
}

/** 工具名归哪一类（认不出的是 other）。 */
export function toolClass(tool: string | undefined): ToolClass {
  const t = toolKey(tool);
  if ((COMMAND_TOOLS as readonly string[]).includes(t)) return 'command';
  if ((READ_TOOLS as readonly string[]).includes(t)) return 'read';
  if ((EDIT_TOOLS as readonly string[]).includes(t)) return 'edit';
  if (SEARCH_TOOLS.includes(t) || t.startsWith('codegraph')) return 'search';
  if (AGENT_TOOLS.includes(t)) return 'agent';
  return 'other';
}

/** 一开头就调工具的那一步的标题动词（进行时的短话，后面接对象）。 */
export function stepVerb(tool: string | undefined): string {
  switch (toolClass(tool)) {
    case 'command':
      return '运行';
    case 'read':
      return '读取';
    case 'edit':
      return toolKey(tool) === 'write' ? '创建' : '编辑';
    case 'search':
      return '搜索';
    case 'agent':
      return '派子代理';
    default:
      return `调用 ${tool ?? '工具'}`;
  }
}

/** 算法吃的一行：读库时只取这些列，文本按种类截短。 */
export interface ProcessRow {
  seq: number;
  /** ISO 时刻。 */
  at: string;
  kind: TranscriptKind;
  tool?: string | undefined;
  ok?: boolean | undefined;
  /** 助手的话、结论、报错：开头一截；工具调用：输入摘要（命令、路径）；别的可以空。 */
  text: string;
  /** 子代理里的条目。 */
  sub: boolean;
  /** 子代理里的条目：派它的那次 Agent 调用的编号；拿不到编号不给。 */
  subOf?: string | undefined;
  /** 原生调用号：调用和它的结果同一个；老记录没有。 */
  callId?: string | undefined;
  /** 命令结果里有没有可信的退出码：false = 这一家的流里没有（Mirasim），「完成」不代表成功。 */
  exitKnown?: boolean | undefined;
  /** 改文件的结果：这一次增删几行；没记不给。 */
  added?: number | undefined;
  removed?: number | undefined;
}

/** 一条完整的会话记录条目（接口回的 TranscriptEntry 的形状）→ 算法吃的一行：和库里 readRunProcessRows 取同样的列、同样的文本长度。 */
export function processRowOf(e: {
  seq: number;
  at: string;
  kind: TranscriptKind;
  tool?: string | undefined;
  ok?: boolean | undefined;
  text: string;
  meta?: Record<string, unknown> | undefined;
}): ProcessRow {
  const m = e.meta ?? {};
  const sub = m.subagent !== undefined && m.subagent !== null && m.subagent !== false;
  const keep =
    e.kind === 'assistant' || e.kind === 'result' || e.kind === 'error'
      ? 400
      : e.kind === 'tool_call'
        ? 300
        : 0;
  const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined);
  const added = int(m.added);
  const removed = int(m.removed);
  return {
    seq: e.seq,
    at: e.at,
    kind: e.kind,
    ...(e.tool === undefined ? {} : { tool: e.tool }),
    ...(e.ok === undefined ? {} : { ok: e.ok }),
    text: e.text.slice(0, keep),
    sub,
    ...(typeof m.subagent === 'string' ? { subOf: m.subagent } : {}),
    ...(typeof m.callId === 'string' && m.callId !== '' ? { callId: m.callId } : {}),
    ...(m.exitKnown === false ? { exitKnown: false } : {}),
    ...(added === undefined ? {} : { added }),
    ...(removed === undefined ? {} : { removed }),
  };
}

export interface FileChange {
  path: string;
  /** 这个文件成功改了几次。 */
  edits: number;
  /** 已记下的增删行数合计；这个文件的编辑一次都没记行数就不带键。 */
  added?: number | undefined;
  removed?: number | undefined;
}

export interface ProcessStep {
  /** 从 0 起，这一笔里的第几步。 */
  index: number;
  /** 这一步的标题：Agent 开头那句话（第一行，去掉标记）；先调工具的是「动词 对象」；什么都没有是 null。 */
  title: string | null;
  /** 标题取自第一个调用（Agent 没说话就先调了工具）。 */
  titleFromCall: boolean;
  firstSeq: number;
  lastSeq: number;
  startedAt: string;
  /** 下一步开始的时刻；最后一步是这一笔收场的时刻（没给就用最后一条的时刻）；这一步还在跑没有。 */
  endedAt?: string | undefined;
  durationMs?: number | undefined;
  running: boolean;
  /** 这一步有调用没成、报错、或结论没成。 */
  failed: boolean;
  /** 工具调用数，含子代理里的（subCalls 单列）。 */
  calls: number;
  subCalls: number;
  commands: number;
  commandsFailed: number;
  /** 结果读不到的命令：老记录没调用号对不上、这一笔收场了结果没记下来、流里没有退出码（Mirasim）。 */
  commandsUnknown: number;
  /** 这一笔还在跑、还没回结果的命令。 */
  commandsRunning: number;
  reads: number;
  /** 没成的调用（任何工具）。 */
  callsFailed: number;
  /** 改了的文件，一个文件一行。 */
  files: FileChange[];
  added: number;
  removed: number;
  /** 编辑成功了但没记行数的次数：增删合计少了这几次。 */
  uncounted: number;
}

export interface ProcessCounts {
  commands: number;
  /** 成了的命令：总数 − 失败 − 结果未知 − 在跑。 */
  commandsDone: number;
  commandsFailed: number;
  commandsUnknown: number;
  commandsRunning: number;
  reads: number;
  callsFailed: number;
  files: FileChange[];
  added: number;
  removed: number;
  uncounted: number;
}

export interface RunProcess {
  steps: ProcessStep[];
  /** 这一笔每一步加起来的数。 */
  counts: ProcessCounts;
  /** 一共读了几行；到了每段的条数上限被截断时 truncated 为 true（后面的没记）。 */
  rows: number;
  truncated: boolean;
  /** 没有调用号的调用有几条（老记录）：这几条对不上结果，命令成败写「结果未知」。 */
  legacyCalls: number;
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

/** 整笔一句话都没有时，两条之间隔多久没动静就另起一步（毫秒）。 */
export const STEP_GAP_MS = 60_000;

interface OpenStep {
  step: ProcessStep;
  hasCalls: boolean;
  lastAt: string;
  files: Map<string, FileChange>;
}

interface PendingCall {
  step: OpenStep;
  cls: ToolClass;
  row: ProcessRow;
}

const ms = (iso: string): number => new Date(iso).getTime();

function newStep(index: number, row: ProcessRow, title: string | null, fromCall: boolean): OpenStep {
  return {
    hasCalls: false,
    lastAt: row.at,
    files: new Map(),
    step: {
      index,
      title,
      titleFromCall: fromCall,
      firstSeq: row.seq,
      lastSeq: row.seq,
      startedAt: row.at,
      running: false,
      failed: false,
      calls: 0,
      subCalls: 0,
      commands: 0,
      commandsFailed: 0,
      commandsUnknown: 0,
      commandsRunning: 0,
      reads: 0,
      callsFailed: 0,
      files: [],
      added: 0,
      removed: 0,
      uncounted: 0,
    },
  };
}

function callTitle(row: ProcessRow): string {
  const t = `${stepVerb(row.tool)} ${row.text}`.trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t;
}

export interface CutOptions {
  /** 这一笔还在跑。 */
  running: boolean;
  /** 这一笔收场的时刻（ISO）；还在跑、没记的不给。 */
  endedAt?: string | undefined;
  /** 整笔没有话时切步的空档（毫秒），默认 STEP_GAP_MS。 */
  gapMs?: number | undefined;
}

/** 按序号排好的行 → 步骤和这一笔的合计。 */
export function cutSteps(input: readonly ProcessRow[], opts: CutOptions): RunProcess {
  const rows = [...input]
    .sort((a, b) => a.seq - b.seq)
    .filter((r) => r.kind !== 'prompt' && r.kind !== 'truncated');
  const gapMs = opts.gapMs ?? STEP_GAP_MS;
  const hasMainSay = rows.some((r) => r.kind === 'assistant' && !r.sub);
  const open: OpenStep[] = [];
  let cur: OpenStep | undefined;
  const calls = new Map<string, PendingCall>();
  const resolved = new Set<string>();
  let legacyCalls = 0;

  const begin = (row: ProcessRow, title: string | null, fromCall: boolean): OpenStep => {
    const s = newStep(open.length, row, title, fromCall);
    open.push(s);
    cur = s;
    return s;
  };

  for (const row of rows) {
    if (row.kind === 'assistant' && !row.sub) {
      if (!cur || cur.hasCalls) begin(row, stepTitle(row.text), false);
      else if (cur.step.title === null) cur.step.title = stepTitle(row.text);
      if (cur) {
        cur.step.lastSeq = row.seq;
        cur.lastAt = row.at;
      }
      continue;
    }
    // 整笔一句话都没有：按时间空档切（只切调用，免得结果、报错单独成步）
    if (!hasMainSay && !row.sub && cur && row.kind === 'tool_call' && ms(row.at) - ms(cur.lastAt) > gapMs) {
      cur = undefined;
    }
    let s = cur;
    if (!s) {
      s = row.kind === 'tool_call' && !row.sub ? begin(row, callTitle(row), true) : begin(row, null, false);
    } else if (row.kind === 'tool_call' && !row.sub && s.step.title === null && !s.hasCalls) {
      s.step.title = callTitle(row);
      s.step.titleFromCall = true;
    }
    s.step.lastSeq = row.seq;
    s.lastAt = row.at;
    if (row.kind === 'tool_call') {
      s.hasCalls = true;
      s.step.calls++;
      if (row.sub) s.step.subCalls++;
      const cls = toolClass(row.tool);
      if (cls === 'command') s.step.commands++;
      if (cls === 'read') s.step.reads++;
      if (row.callId === undefined) {
        // 老记录没有调用号：不强配结果，命令的成败写「结果未知」
        legacyCalls++;
        if (cls === 'command') s.step.commandsUnknown++;
      } else {
        calls.set(row.callId, { step: s, cls, row });
      }
    } else if (row.kind === 'tool_result') {
      s.hasCalls = true;
      const call = row.callId === undefined ? undefined : calls.get(row.callId);
      if (!call || resolved.has(row.callId as string)) continue;
      resolved.add(row.callId as string);
      applyResult(call, row);
    } else if (row.kind === 'error') {
      s.step.failed = true;
    } else if (row.kind === 'result' && row.ok === false) {
      s.step.failed = true;
    }
  }

  // 没等到结果的命令：这一笔还在跑 = 在跑；已经结束 = 没读到结果。改文件没等到结果的不算改（不知道成没成）
  for (const [id, call] of calls) {
    if (resolved.has(id) || call.cls !== 'command') continue;
    if (opts.running) call.step.step.commandsRunning++;
    else call.step.step.commandsUnknown++;
  }

  const steps = open.map((o, i) => {
    const s = o.step;
    s.files = [...o.files.values()];
    const next = open[i + 1]?.step;
    if (next) {
      s.endedAt = next.startedAt;
    } else if (opts.running) {
      s.running = true;
    } else {
      const lastAt = rows.at(-1)?.at ?? s.startedAt;
      s.endedAt = opts.endedAt && ms(opts.endedAt) >= ms(lastAt) ? opts.endedAt : lastAt;
    }
    if (s.endedAt !== undefined) s.durationMs = Math.max(0, ms(s.endedAt) - ms(s.startedAt));
    return s;
  });

  return {
    steps,
    counts: sumStepCounts(steps),
    rows: rows.length,
    // 记录员到了每段的条数上限会补一条 truncated：有它就是后面的没记
    truncated: input.some((r) => r.kind === 'truncated'),
    legacyCalls,
  };

  function applyResult(call: PendingCall, row: ProcessRow): void {
    const s = call.step.step;
    if (row.ok === false) {
      s.callsFailed++;
      s.failed = true;
      if (call.cls === 'command') s.commandsFailed++;
      return;
    }
    if (call.cls === 'command' && row.exitKnown === false) {
      s.commandsUnknown++;
      return;
    }
    if (call.cls === 'edit') recordEdit(call.step, call.row, row);
  }
}

/** 改文件的调用成功了：算一个文件；增删行数读结果里的，没记的计入 uncounted。 */
function recordEdit(step: OpenStep, call: ProcessRow, result: ProcessRow): void {
  const path = call.text.trim();
  if (!path) return;
  const f = step.files.get(path) ?? { path, edits: 0 };
  f.edits++;
  if (result.added !== undefined || result.removed !== undefined) {
    f.added = (f.added ?? 0) + (result.added ?? 0);
    f.removed = (f.removed ?? 0) + (result.removed ?? 0);
    step.step.added += result.added ?? 0;
    step.step.removed += result.removed ?? 0;
  } else {
    step.step.uncounted++;
  }
  step.files.set(path, f);
}

/** 把几步（或几笔）的文件合并：同一个路径的次数、增删相加。 */
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

function sumStepCounts(steps: readonly ProcessStep[]): ProcessCounts {
  const sum = (pick: (s: ProcessStep) => number) => steps.reduce((n, s) => n + pick(s), 0);
  const commands = sum((s) => s.commands);
  const failed = sum((s) => s.commandsFailed);
  const unknown = sum((s) => s.commandsUnknown);
  const running = sum((s) => s.commandsRunning);
  return {
    commands,
    commandsDone: Math.max(0, commands - failed - unknown - running),
    commandsFailed: failed,
    commandsUnknown: unknown,
    commandsRunning: running,
    reads: sum((s) => s.reads),
    callsFailed: sum((s) => s.callsFailed),
    files: mergeFiles(steps.map((s) => s.files)),
    added: sum((s) => s.added),
    removed: sum((s) => s.removed),
    uncounted: sum((s) => s.uncounted),
  };
}

// —— 一笔的小计（任务详情用）：库里一条 GROUP BY run_id 现算出一行，这里折成页面要的数 ——

/** 库里按 run_id 分组算出的一行（db 的 readRunTallies）：命令的成败拆成几个互不重叠的数，在跑还是没记结果由这里按这一笔在不在跑定。 */
export interface RunTallyRow {
  /** 一共几条记录。 */
  entries: number;
  calls: number;
  commands: number;
  commandsFailed: number;
  /** 命令结果「完成」但流里没有退出码（Mirasim）。 */
  commandsExitUnknown: number;
  /** 命令有调用号、可是没有对上的结果。 */
  commandsNoResult: number;
  /** 命令没有调用号（老记录）：对不上结果。 */
  commandsLegacy: number;
  reads: number;
  callsFailed: number;
  /** 成功的改文件调用数，和其中没记行数的。 */
  editsOk: number;
  editsUncounted: number;
  /** 成功的改文件结果里记下的增删行数合计（不是 PR 的净改动，见 numstat）。 */
  added: number;
  removed: number;
  firstAt?: string | undefined;
  lastAt?: string | undefined;
}

export interface RunTally {
  entries: number;
  calls: number;
  commands: number;
  commandsDone: number;
  commandsFailed: number;
  commandsUnknown: number;
  commandsRunning: number;
  reads: number;
  callsFailed: number;
  editsOk: number;
  uncounted: number;
  added: number;
  removed: number;
  firstAt?: string | undefined;
  lastAt?: string | undefined;
}

/** 一行折成小计：这一笔还在跑，没有结果的命令算「在跑」，收场了算「结果未知」；老记录没调用号的、没有退出码的都算结果未知。 */
export function tallyOf(row: RunTallyRow, running: boolean): RunTally {
  const unknown = row.commandsExitUnknown + row.commandsLegacy + (running ? 0 : row.commandsNoResult);
  const live = running ? row.commandsNoResult : 0;
  return {
    entries: row.entries,
    calls: row.calls,
    commands: row.commands,
    commandsDone: Math.max(0, row.commands - row.commandsFailed - unknown - live),
    commandsFailed: row.commandsFailed,
    commandsUnknown: unknown,
    commandsRunning: live,
    reads: row.reads,
    callsFailed: row.callsFailed,
    editsOk: row.editsOk,
    uncounted: row.editsUncounted,
    added: row.added,
    removed: row.removed,
    ...(row.firstAt === undefined ? {} : { firstAt: row.firstAt }),
    ...(row.lastAt === undefined ? {} : { lastAt: row.lastAt }),
  };
}

/** 几笔的小计加在一起（读文件数是各笔读的次数相加，不去重）。 */
export function sumTallies(list: readonly RunTally[]): RunTally {
  const sum = (pick: (t: RunTally) => number) => list.reduce((n, t) => n + pick(t), 0);
  return {
    entries: sum((t) => t.entries),
    calls: sum((t) => t.calls),
    commands: sum((t) => t.commands),
    commandsDone: sum((t) => t.commandsDone),
    commandsFailed: sum((t) => t.commandsFailed),
    commandsUnknown: sum((t) => t.commandsUnknown),
    commandsRunning: sum((t) => t.commandsRunning),
    reads: sum((t) => t.reads),
    callsFailed: sum((t) => t.callsFailed),
    editsOk: sum((t) => t.editsOk),
    uncounted: sum((t) => t.uncounted),
    added: sum((t) => t.added),
    removed: sum((t) => t.removed),
  };
}
