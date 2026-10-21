// 决定索引 docs/decisions/README.md 由各份决定书的头部生成，不手维护（决定 0093 之后的做法）。
// 每份 docs/decisions/NNNN-*.md 头部（第一行 `# NNNN 标题` 之后、第一个 `## ` 小节之前）要有：
//   - 日期：YYYY-MM-DD……      （取第一个 YYYY-MM-DD，后面的括号随便写）
//   - 索引状态：生效 | 未复核 | 历史 | 失效
//   - 被取代：0094（第 8 条）   （没被取代就不写这一行；写了必须带至少一个已存在的四位编号，不能是自己）
// 生成：pnpm decisions:index；核对：pnpm decisions:index --check（conventions 的 decisions-index.test.ts 拿真仓核对，CI 会跑）。
// 做法和 ops-tables.ts 一样：纯函数读 RepoView，真跑读盘、测试用内存假仓；生成结果和仓里文件逐字比。
import type { RepoView } from './repo.ts';

export const DECISIONS_DIR = 'docs/decisions';
export const INDEX_PATH = `${DECISIONS_DIR}/README.md`;
/** 生成命令，核对不一致时提示它。 */
export const GENERATE_COMMAND = 'pnpm decisions:index';

export const STATUSES = ['生效', '未复核', '历史', '失效'] as const;
export type DecisionStatus = (typeof STATUSES)[number];

/** 还在管事的状态；其余进「历史」一节。 */
const ACTIVE: readonly DecisionStatus[] = ['生效', '未复核'];

const FILE_NAME = /^(\d{4})-.+\.md$/;

export interface DecisionEntry {
  number: string;
  file: string;
  title: string;
  date: string;
  status: DecisionStatus;
  /** 「被取代」那行的原文（没写是空串）。 */
  supersededBy: string;
  /** 从「被取代」里认出的编号。 */
  supersededByNumbers: string[];
}

export interface DecisionsProblem {
  text: string;
  /** 没查成（读不到目录）；其余是内容不对 / 不一致。 */
  notQueried?: boolean;
}

/** 头部元数据行：`- 键：值`，只认第一个小节之前的。 */
function headerValue(lines: readonly string[], key: string): string | undefined {
  for (const line of lines) {
    if (line.startsWith('## ')) return undefined;
    const m = new RegExp(`^- ${key}：(.*)$`).exec(line);
    if (m) return (m[1] ?? '').trim();
  }
  return undefined;
}

/** 读全部决定书头部。问题（缺行、值不对）逐条返回，坏的那份不进 entries。 */
export function readDecisions(repo: RepoView): { entries: DecisionEntry[]; problems: DecisionsProblem[] } {
  const names = repo.list(DECISIONS_DIR);
  if (names === undefined) {
    return { entries: [], problems: [{ text: `没查成：读不到 ${DECISIONS_DIR}/ 目录。`, notQueried: true }] };
  }
  const problems: DecisionsProblem[] = [];
  const entries: DecisionEntry[] = [];
  const seen = new Map<string, string>();
  for (const file of names.filter((n) => FILE_NAME.test(n)).sort()) {
    const number = FILE_NAME.exec(file)?.[1] ?? '';
    const where = `${DECISIONS_DIR}/${file}`;
    const prior = seen.get(number);
    if (prior !== undefined) problems.push({ text: `${where}：编号 ${number} 和 ${prior} 重复。` });
    seen.set(number, file);
    const text = repo.read(where);
    if (text === undefined) {
      problems.push({ text: `没查成：读不到 ${where}。`, notQueried: true });
      continue;
    }
    const lines = text.split(/\r?\n/);
    const h1 = /^# (\d{4}) (.+)$/.exec(lines[0] ?? '');
    if (!h1 || h1[1] !== number) {
      problems.push({ text: `${where}：第一行要写成「# ${number} 标题」。` });
      continue;
    }
    const date = /\d{4}-\d{2}-\d{2}/.exec(headerValue(lines, '日期') ?? '')?.[0];
    if (date === undefined) {
      problems.push({ text: `${where}：头部缺「- 日期：YYYY-MM-DD」。` });
      continue;
    }
    const status = headerValue(lines, '索引状态');
    if (!STATUSES.includes(status as DecisionStatus)) {
      problems.push({
        text: `${where}：头部缺「- 索引状态：」或值不对（现在是${status === undefined ? '没写' : `「${status}」`}，只认 ${STATUSES.join(' / ')}）。`,
      });
      continue;
    }
    const supersededBy = headerValue(lines, '被取代') ?? '';
    entries.push({
      number,
      file,
      title: (h1[2] ?? '').trim(),
      date,
      status: status as DecisionStatus,
      supersededBy,
      supersededByNumbers: supersededBy.match(/\d{4}/g) ?? [],
    });
  }
  const known = new Set(entries.map((e) => e.number));
  for (const e of entries) {
    if (e.supersededBy !== '' && e.supersededByNumbers.length === 0) {
      problems.push({ text: `${DECISIONS_DIR}/${e.file}：「被取代」里要写取代它的决定编号（四位数）。` });
    }
    for (const n of e.supersededByNumbers) {
      if (n === e.number) problems.push({ text: `${DECISIONS_DIR}/${e.file}：「被取代」不能写自己。` });
      else if (!known.has(n))
        problems.push({ text: `${DECISIONS_DIR}/${e.file}：「被取代」里的 ${n} 不是仓里的决定。` });
    }
  }
  return { entries, problems };
}

function table(rows: readonly DecisionEntry[]): string[] {
  const out = ['| 编号 | 标题 | 日期 | 状态 | 被谁取代 |', '|---|---|---|---|---|'];
  for (const e of rows) {
    const cell = (s: string) => s.replaceAll('|', '\\|');
    out.push(
      `| [${e.number}](${e.file}) | ${cell(e.title)} | ${e.date} | ${e.status} | ${e.supersededBy === '' ? '—' : cell(e.supersededBy)} |`,
    );
  }
  return out;
}

/** 整份索引文件的内容（同一批决定书两次调用逐字相同）。 */
export function renderIndex(entries: readonly DecisionEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.number.localeCompare(b.number));
  const active = sorted.filter((e) => ACTIVE.includes(e.status));
  const history = sorted.filter((e) => !ACTIVE.includes(e.status));
  return `${[
    '# 决定索引',
    '',
    `<!-- 自动生成，别手改：改各份决定书头部的「日期」「索引状态」「被取代」，再跑 ${GENERATE_COMMAND} -->`,
    '',
    '一决定一文件，只增不改；被推翻时在那份头部加「被取代」行，不删（决定 0001 第 7 条）。本页由各份头部生成，新决定写好头部后跑 `pnpm decisions:index`，`conventions` 的测试会核对本页和头部一致。',
    '',
    '头部三行：`- 日期：YYYY-MM-DD`；`- 索引状态：生效 | 未复核 | 历史 | 失效`；被部分或整份取代时加 `- 被取代：0094（第 8 条）`。落地后把改之前 / 改之后的实测数字回填到那份决定里（哪天、怎么量的；没量成写原因），见 `docs/workflow.md`。',
    '',
    '## 还在管事',
    '',
    ...table(active),
    '',
    '## 历史',
    '',
    '已执行完、已被替代或已失效的。文件不搬。',
    '',
    ...table(history),
  ].join('\n')}\n`;
}

/** 核对：头部有问题就报问题；没问题再比生成结果和仓里文件。空数组 = 一致。 */
export function checkDecisionsIndex(repo: RepoView): DecisionsProblem[] {
  const { entries, problems } = readDecisions(repo);
  if (problems.length > 0) return problems;
  const have = repo.read(INDEX_PATH);
  if (have === undefined) {
    return [{ text: `没查成：读不到 ${INDEX_PATH}。跑 ${GENERATE_COMMAND} 生成。`, notQueried: true }];
  }
  if (have !== renderIndex(entries)) {
    return [
      {
        text: `${INDEX_PATH} 和各份决定书头部生成的不一致（别手改它）。跑 ${GENERATE_COMMAND} 重新生成并提交。`,
      },
    ];
  }
  return [];
}

/** 生成：头部有问题返回 problems、不给文本。 */
export function generateDecisionsIndex(repo: RepoView): { text?: string; problems: DecisionsProblem[] } {
  const { entries, problems } = readDecisions(repo);
  if (problems.length > 0) return { problems };
  return { text: renderIndex(entries), problems: [] };
}
