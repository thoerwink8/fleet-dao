// 方案索引 specs/README.md 由各方案目录主文件的头部生成，不手维护（#3498，照 decisions-index.ts 的做法）。
// 一单一目录 specs/<编号>-<短名>/；正文写下就不改，头部的状态行可以改。
// 主文件：目录里有 需求.md 取它，没有取 方案.md，都没有取按文件名（码位）排第一份 .md；一份 .md 也没有的目录（只放截图等附件）
// 不标状态，索引里单列。
// 头部：有 `# 标题` 就从标题下一行起、没有就从第一行起，跳过开头的空行，连着的 `- ` 行；第一个空行或别的行就结束。要有：
//   - 状态：在做 | 做完 | 被取代 | 未复核
//   - 被取代：specs/<目录>     （状态是「被取代」才写、也必须写；指向的目录要在 specs/ 下，不能是自己）
// 编号是目录名开头的数字。两个目录编号相同、都没标「被取代」就报红；SHARED_NUMBERS 里写死的是加这道检查前就撞了号、
// 又谁也没取代谁的几组（同一母单下的不同题目、母单的切片），只认名单里那几个目录，再来一个照样报红。
// 生成：pnpm specs:index；核对：pnpm specs:index --check（进 pnpm check；specs-index.test.ts 拿真仓核对，CI 会跑）。
// 存量的状态由 bin/specs-backfill.ts 按单的开关机械回填过一次（关了 → 做完，开着 → 在做，对不上单 → 未复核）。
import type { RepoView } from './repo.ts';

export const SPECS_DIR = 'specs';
export const SPECS_INDEX_PATH = `${SPECS_DIR}/README.md`;
/** 生成命令，核对不一致时提示它。 */
export const SPECS_GENERATE_COMMAND = 'pnpm specs:index';

export const SPEC_STATUSES = ['在做', '做完', '被取代', '未复核'] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

/** 还在管事的状态；其余进「历史」一节。 */
const ACTIVE: readonly SpecStatus[] = ['在做', '未复核'];

/** 加检查前就撞了号、谁也没取代谁的目录（见文件开头）。只许减，不许加：新方案换个编号。 */
export const SHARED_NUMBERS: Readonly<Record<string, readonly string[]>> = {
  '555': ['555-2-冷调用进合并闸', '555-验收'],
  '902': ['902-驾驶舱用户视角e2e', '902-驾驶舱首页流程图'],
  '1798': ['1798-探针重做', '1798-驾驶舱重排'],
};

const DIR_NAME = /^(\d+)-.+$/;
const PREFERRED_MAIN = ['需求.md', '方案.md'];

export interface SpecEntry {
  dir: string;
  number: string;
  /** 主文件名（目录里的）。 */
  file: string;
  title: string;
  status: SpecStatus;
  /** 取代它的目录名（没写是空串）。 */
  supersededBy: string;
}

export interface SpecsProblem {
  text: string;
  /** 没查成（读不到目录、文件）；其余是内容不对 / 不一致。 */
  notQueried?: boolean;
}

/** 码位比较：不随机器的区域设置变，生成结果才逐字一样。 */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 目录里的主文件；没有 .md 是 undefined。 */
export function mainFile(names: readonly string[]): string | undefined {
  const md = names.filter((n) => n.endsWith('.md')).sort(byCodePoint);
  return PREFERRED_MAIN.find((n) => md.includes(n)) ?? md[0];
}

/** 头部从第几行起：有 `# 标题` 是 1，没有是 0。 */
function headerStart(lines: readonly string[]): number {
  return (lines[0] ?? '').startsWith('# ') ? 1 : 0;
}

/** 头部那几行（见文件开头）。 */
export function headerLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  let i = headerStart(lines);
  while (i < lines.length && lines[i] === '') i++;
  const out: string[] = [];
  for (; i < lines.length && (lines[i] ?? '').startsWith('- '); i++) out.push(lines[i] ?? '');
  return out;
}

function headerValue(header: readonly string[], key: string): string | undefined {
  for (const line of header) {
    const m = new RegExp(`^- ${key}：(.*)$`).exec(line);
    if (m) return (m[1] ?? '').trim();
  }
  return undefined;
}

/** 读全部方案目录。问题逐条返回，坏的那份不进 entries；attachmentsOnly 是没有 .md 的目录。 */
export function readSpecs(repo: RepoView): {
  entries: SpecEntry[];
  attachmentsOnly: string[];
  problems: SpecsProblem[];
} {
  const names = repo.list(SPECS_DIR);
  if (names === undefined) {
    return {
      entries: [],
      attachmentsOnly: [],
      problems: [{ text: `没查成：读不到 ${SPECS_DIR}/ 目录。`, notQueried: true }],
    };
  }
  const problems: SpecsProblem[] = [];
  const entries: SpecEntry[] = [];
  const attachmentsOnly: string[] = [];
  const dirs = names.filter((n) => repo.isDir(`${SPECS_DIR}/${n}`)).sort(byCodePoint);
  for (const dir of dirs) {
    const where = `${SPECS_DIR}/${dir}`;
    const number = DIR_NAME.exec(dir)?.[1];
    if (number === undefined) {
      problems.push({ text: `${where}/：目录名要写成「<编号>-<短名>」。` });
      continue;
    }
    const files = repo.list(where);
    if (files === undefined) {
      problems.push({ text: `没查成：列不出 ${where}/。`, notQueried: true });
      continue;
    }
    const file = mainFile(files);
    if (file === undefined) {
      attachmentsOnly.push(dir);
      continue;
    }
    const text = repo.read(`${where}/${file}`);
    if (text === undefined) {
      problems.push({ text: `没查成：读不到 ${where}/${file}。`, notQueried: true });
      continue;
    }
    const header = headerLines(text);
    const status = headerValue(header, '状态');
    if (!SPEC_STATUSES.includes(status as SpecStatus)) {
      problems.push({
        text: `${where}/${file}：头部缺「- 状态：」或值不对（现在是${status === undefined ? '没写' : `「${status}」`}，只认 ${SPEC_STATUSES.join(' / ')}）。`,
      });
      continue;
    }
    const by = headerValue(header, '被取代');
    let supersededBy = '';
    if (status === '被取代' && by === undefined) {
      problems.push({ text: `${where}/${file}：状态是「被取代」，头部要另带「- 被取代：specs/<目录>」。` });
      continue;
    }
    if (by !== undefined) {
      const m = /^specs\/([^/\s]+)\/?$/.exec(by);
      if (status !== '被取代') {
        problems.push({
          text: `${where}/${file}：写了「- 被取代：」，状态却是「${status}」；要么改成「被取代」，要么删掉那行。`,
        });
        continue;
      }
      if (!m) {
        problems.push({ text: `${where}/${file}：「被取代」要写成「specs/<目录>」（现在是「${by}」）。` });
        continue;
      }
      supersededBy = m[1] ?? '';
    }
    const h1 = /^# (.+)$/.exec(text.split(/\r?\n/)[0] ?? '');
    entries.push({
      dir,
      number,
      file,
      title: (h1?.[1] ?? dir.slice(number.length + 1)).trim(),
      status: status as SpecStatus,
      supersededBy,
    });
  }
  const known = new Set(dirs);
  for (const e of entries) {
    if (e.supersededBy === '') continue;
    const where = `${SPECS_DIR}/${e.dir}/${e.file}`;
    if (e.supersededBy === e.dir) problems.push({ text: `${where}：「被取代」不能写自己。` });
    else if (!known.has(e.supersededBy))
      problems.push({ text: `${where}：「被取代」指的 specs/${e.supersededBy} 不是仓里的方案目录。` });
  }
  const byNumber = new Map<string, string[]>();
  for (const e of entries) {
    if (e.status === '被取代') continue;
    byNumber.set(e.number, [...(byNumber.get(e.number) ?? []), e.dir]);
  }
  for (const [number, same] of byNumber) {
    const shared = SHARED_NUMBERS[number] ?? [];
    if (same.length > 1 && !same.every((d) => shared.includes(d))) {
      problems.push({
        text: `${SPECS_DIR}/：编号 ${number} 有 ${same.length} 个目录都没标「被取代」（${same.join('、')}）。新方案换个编号；真是后来的推翻了先前的，在先前那份头部标「被取代」。`,
      });
    }
  }
  return { entries, attachmentsOnly, problems };
}

/** 存量回填用：按单的开关给状态。issue 是 undefined = 对不上单（没这张单、是 PR、读不到）。 */
export function backfillStatus(issue: { state: string } | undefined): SpecStatus {
  if (issue === undefined) return '未复核';
  if (issue.state === 'closed') return '做完';
  if (issue.state === 'open') return '在做';
  return '未复核';
}

/**
 * 存量回填用：在主文件头部加「- 状态：」一行，正文一字不动（只新增行）。已经有状态的原样返回 undefined。
 * 有 `# 标题` 加在标题下面（标题下一行不是空行就前后各补一个空行），没有标题加在第一行前面。
 */
export function withStatusLine(text: string, status: SpecStatus): string | undefined {
  if (headerValue(headerLines(text), '状态') !== undefined) return undefined;
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const line = `- 状态：${status}`;
  if (headerStart(lines) === 0) return [line, '', ...lines].join(nl);
  const added = lines[1] === '' ? ['', line] : ['', line, ''];
  return [lines[0] ?? '', ...added, ...lines.slice(1)].join(nl);
}

function cell(s: string): string {
  return s.replaceAll('|', '\\|');
}

function link(dir: string, file?: string): string {
  return `[${cell(dir)}](<${file === undefined ? `${dir}/` : `${dir}/${file}`}>)`;
}

function table(rows: readonly SpecEntry[]): string[] {
  const out = ['| 目录 | 标题 | 状态 | 被谁取代 |', '|---|---|---|---|'];
  for (const e of rows) {
    out.push(
      `| ${link(e.dir, e.file)} | ${cell(e.title)} | ${e.status} | ${e.supersededBy === '' ? '—' : link(e.supersededBy)} |`,
    );
  }
  return out;
}

function byNumberThenDir(a: { number: string; dir: string }, b: { number: string; dir: string }): number {
  return Number(a.number) - Number(b.number) || byCodePoint(a.dir, b.dir);
}

/** 整份索引文件的内容（同一批目录两次调用逐字相同）。 */
export function renderSpecsIndex(
  entries: readonly SpecEntry[],
  attachmentsOnly: readonly string[] = [],
): string {
  const sorted = [...entries].sort(byNumberThenDir);
  const active = sorted.filter((e) => ACTIVE.includes(e.status));
  const history = sorted.filter((e) => !ACTIVE.includes(e.status));
  const attachments = attachmentsOnly
    .map((dir) => ({ dir, number: DIR_NAME.exec(dir)?.[1] ?? '0' }))
    .sort(byNumberThenDir);
  return `${[
    '# 方案索引',
    '',
    `<!-- 自动生成，别手改：改各目录主文件头部的「状态」「被取代」，再跑 ${SPECS_GENERATE_COMMAND} -->`,
    '',
    '要写方案才写，一单一目录 `specs/<编号>-<短名>/`；正文写下就不改，头部的状态行可以改。本页由各目录主文件的头部生成，新方案写好头部后跑 `pnpm specs:index`，`pnpm check` 和 `conventions` 的测试会核对本页和头部一致（`packages/conventions/src/specs-index.ts`）。',
    '',
    '主文件：目录里有 `需求.md` 取它，没有取 `方案.md`，都没有取按文件名排第一份 md。头部写在 `# 标题` 下面：`- 状态：在做 | 做完 | 被取代 | 未复核`；被后来的方案推翻时状态改「被取代」，另加 `- 被取代：specs/<目录>`。',
    '',
    '「未复核」是加状态那次对不上单、没人核过的，读的时候先看单。',
    '',
    '## 还在管事',
    '',
    ...table(active),
    '',
    '## 历史',
    '',
    '做完或被取代的。目录不搬。',
    '',
    ...table(history),
    ...(attachments.length === 0
      ? []
      : [
          '',
          '## 只有附件的目录',
          '',
          '没有 md，不标状态。',
          '',
          ...attachments.map((a) => `- ${link(a.dir)}`),
        ]),
  ].join('\n')}\n`;
}

/** 核对：头部有问题就报问题；没问题再比生成结果和仓里文件。空数组 = 一致。 */
export function checkSpecsIndex(repo: RepoView): SpecsProblem[] {
  const { entries, attachmentsOnly, problems } = readSpecs(repo);
  if (problems.length > 0) return problems;
  const have = repo.read(SPECS_INDEX_PATH);
  if (have === undefined) {
    return [
      { text: `没查成：读不到 ${SPECS_INDEX_PATH}。跑 ${SPECS_GENERATE_COMMAND} 生成。`, notQueried: true },
    ];
  }
  if (have !== renderSpecsIndex(entries, attachmentsOnly)) {
    return [
      {
        text: `${SPECS_INDEX_PATH} 和各目录主文件头部生成的不一致（别手改它）。跑 ${SPECS_GENERATE_COMMAND} 重新生成并提交。`,
      },
    ];
  }
  return [];
}

/** 生成：头部有问题返回 problems、不给文本。 */
export function generateSpecsIndex(repo: RepoView): { text?: string; problems: SpecsProblem[] } {
  const { entries, attachmentsOnly, problems } = readSpecs(repo);
  if (problems.length > 0) return { problems };
  return { text: renderSpecsIndex(entries, attachmentsOnly), problems: [] };
}
