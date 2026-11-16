// 创始人引导一条一张 GitHub 单（#4054）：贴「创始人引导」标签，正文只用意思。
// 原话写进本机 ~/.fleet-dao/private/directive-quotes/（不进公开单、不进仓、不进 quotes:flush 会删的待传目录）。
// 不写 docs/directives/、不开 PR、不再 POST /api/nodes/notes。同一句同一分钟重跑是重放（created:false）。
// 旧账本里还开着的引导用 migrateOpenDirectives 逐条开单，正文写「原单：#原号」。账本读口只给这一次导出。
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atDate,
  checkIssueOpen,
  DirectiveRefused,
  DirectiveUnchecked,
  directiveIssueDraft,
  openIssueNumbers,
} from './directives.ts';
import type { Gh, GhResult } from './issue-new.ts';
import { noteIdempotencyKey } from './ledger-note.ts';
import { type InboxDeps, type LedgerDirective, type LedgerHandoff, ledgerSync } from './ledger-read.ts';
import { type DirectiveKind, ownerOf } from './progress.ts';

export const DIRECTIVE_LABEL = '创始人引导';
const LIST_LIMIT = 200;

export interface DirectiveToRecord {
  /** 原话（对外仓这里已经是意思，见 private-quotes.ts） */
  text: string;
  /** 他说话的时刻，北京时间 YYYY-MM-DD HH:mm +0800 */
  at: string;
  atDate: Date;
  owner: string;
  source: string;
}

export interface DirectiveLedgerDeps {
  gh: Gh;
  /** 本仓 owner/name；列单时 --repo 用它 */
  repo: string;
  /** 没给 --issue 时开一张单，返回单号（入口用 issueNew；测试给假的） */
  newIssue?: (draft: { title: string; body: string }) => Promise<number>;
  /** 原话和重放索引写在这个家目录下；不给就用本机家目录 */
  home?: string;
  ref?: string;
}

export interface OpenDirectiveIssue {
  number: number;
  title: string;
  body: string;
  createdAt: string;
}

interface QuoteIndexEntry {
  issue: number;
  quoteId: string;
}

const detail = (r: GhResult) =>
  (r.stderr.trim() || r.stdout.trim() || '（没说）').replace(/\s+/g, ' ').slice(0, 300);
const markerFor = (key: string) => `<!-- fleet:directive ${key} -->`;
const homeOf = (deps: DirectiveLedgerDeps) => deps.home ?? homedir();

const HIDDEN = '（没有可公开的意思，原话只在本机私有处）';

/** 意思里整句抄着原话就换成这句，不把原话写进公开单。hideWhenSame：旧账本里意思和原话是同一句时也不公开。 */
export function safePublicMeaning(meaning: string, quote: string, hideWhenSame = false): string {
  const m = meaning.trim();
  const q = quote.trim();
  if (!m) return HIDDEN;
  if (q.length >= 6 && m.includes(q) && (hideWhenSame || m !== q)) return HIDDEN;
  return m;
}

export function meaningOfDirectiveIssue(i: { title: string; body: string }): string {
  const line = /^.*意思：(.+)$/m.exec(i.body)?.[1]?.trim();
  if (line) return line;
  return i.title.replace(/^创始人引导：/, '').trim();
}

/** 周汇总要的形状：没有原话。挂的单就是这张带标签的单。说话时刻认正文里的「创始人 <时刻> 的引导」，认不出就空着，汇总改用开单时刻。 */
export function directiveIssueToDigest(i: OpenDirectiveIssue): LedgerDirective {
  const spoken = /^创始人 (.+?) 的引导/m.exec(i.body)?.[1]?.trim() ?? '';
  return {
    id: i.number,
    at: i.createdAt,
    issue: i.number,
    text: '',
    meaning: meaningOfDirectiveIssue(i),
    category: 'ai',
    owner: ownerOf(i.body),
    spokenAt: spoken && atDate(spoken) ? spoken : '',
  };
}

function parseListed(raw: unknown): OpenDirectiveIssue {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  if (
    typeof o.number !== 'number' ||
    typeof o.title !== 'string' ||
    typeof o.body !== 'string' ||
    typeof o.createdAt !== 'string'
  )
    throw new DirectiveUnchecked('gh 列引导单：有一项没有 number、title、body 或 createdAt。');
  return { number: o.number, title: o.title, body: o.body, createdAt: o.createdAt };
}

/** 这个标签下的单。读不到、认不出、多到没列全都报没查成，不当成没有。 */
export async function listDirectiveIssues(
  gh: Gh,
  repo: string,
  state: 'open' | 'all',
): Promise<OpenDirectiveIssue[]> {
  const r = await gh([
    'issue',
    'list',
    '--repo',
    repo,
    '--label',
    DIRECTIVE_LABEL,
    '--state',
    state,
    '--json',
    'number,title,body,createdAt',
    '--limit',
    String(LIST_LIMIT),
  ]);
  if (r.code !== 0) throw new DirectiveUnchecked(`gh 列「${DIRECTIVE_LABEL}」的单没成：${detail(r)}。`);
  let list: unknown;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    throw new DirectiveUnchecked(`gh 列「${DIRECTIVE_LABEL}」的单：输出不是 JSON。`);
  }
  if (!Array.isArray(list)) throw new DirectiveUnchecked('gh 列引导单：读回来的不是列表。');
  if (list.length >= LIST_LIMIT)
    throw new DirectiveUnchecked(`「${DIRECTIVE_LABEL}」的单多到 ${LIST_LIMIT} 张以上，没列全。`);
  return list.map(parseListed);
}

function quoteRoot(home: string): string {
  let path = home;
  for (const part of ['.fleet-dao', 'private', 'directive-quotes']) {
    path = join(path, part);
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new DirectiveUnchecked('私有原话目录不安全，没记。');
    if (part !== '.fleet-dao') chmodSync(path, 0o700);
  }
  return path;
}

function indexPath(home: string): string {
  return join(quoteRoot(home), 'index.json');
}

function readIndex(home: string): Record<string, QuoteIndexEntry> {
  const p = indexPath(home);
  if (!existsSync(p)) return {};
  let j: unknown;
  try {
    j = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    throw new DirectiveUnchecked('本机引导索引读不了，不敢再开一张单。');
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j))
    throw new DirectiveUnchecked('本机引导索引认不出，不敢再开一张单。');
  const out: Record<string, QuoteIndexEntry> = {};
  for (const [k, v] of Object.entries(j)) {
    const issue = (v as { issue?: unknown } | null)?.issue;
    const quoteId = (v as { quoteId?: unknown } | null)?.quoteId;
    if (typeof issue !== 'number' || (quoteId !== undefined && typeof quoteId !== 'string'))
      throw new DirectiveUnchecked('本机引导索引有一项认不出，不敢再开一张单。');
    out[k] = { issue, quoteId: typeof quoteId === 'string' ? quoteId : '' };
  }
  return out;
}

function writeIndex(home: string, index: Record<string, QuoteIndexEntry>): void {
  const p = indexPath(home);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(index), { mode: 0o600 });
  renameSync(tmp, p);
}

function saveDirectiveQuote(
  home: string,
  quote: { id: string; text: string; at: string; owner: string; meaning: string; issue: number },
): void {
  const file = join(quoteRoot(home), `${quote.id}.json`);
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(quote));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function ensureLabel(gh: Gh, repo: string, n: number): Promise<void> {
  const created = await gh([
    'label',
    'create',
    DIRECTIVE_LABEL,
    '--repo',
    repo,
    '--color',
    '5319E7',
    '--description',
    '创始人引导，一条一张单，正文只写意思',
    '--force',
  ]);
  if (created.code !== 0)
    throw new DirectiveUnchecked(`「${DIRECTIVE_LABEL}」标签没建上：${detail(created)}。`);
  const edit = await gh(['issue', 'edit', String(n), '--repo', repo, '--add-label', DIRECTIVE_LABEL]);
  if (edit.code !== 0)
    throw new DirectiveUnchecked(`单 #${n} 没贴上「${DIRECTIVE_LABEL}」：${detail(edit)}。`);
}

/** 正文里缺主人标记或重放记号就补在末尾；都在就不动。挂已有单、以及上次没补完的重跑用。 */
async function appendMark(gh: Gh, repo: string, n: number, owner: string, key: string): Promise<void> {
  const mark = markerFor(key);
  const ownerLine = `〔主：${owner}〕`;
  const viewed = await gh(['issue', 'view', String(n), '--repo', repo, '--json', 'body', '--jq', '.body']);
  if (viewed.code !== 0) throw new DirectiveUnchecked(`gh 读单 #${n} 的正文没成：${detail(viewed)}。`);
  const body = viewed.stdout.replace(/\r\n/g, '\n');
  const missing = [body.includes(ownerLine) ? '' : ownerLine, body.includes(mark) ? '' : mark].filter(
    Boolean,
  );
  if (missing.length === 0) return;
  const next = `${body.replace(/\s*$/, '')}\n\n${missing.join('\n')}\n`;
  const dir = mkdtempSync(join(tmpdir(), 'directive-body-'));
  const file = join(dir, 'body.md');
  try {
    writeFileSync(file, next, 'utf8');
    const edit = await gh(['issue', 'edit', String(n), '--repo', repo, '--body-file', file]);
    if (edit.code !== 0) throw new DirectiveUnchecked(`单 #${n} 的正文没补上主人标记：${detail(edit)}。`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 账本里没办完的引导，只给 `pnpm progress directive-export`：增量读账本，再看挂的单开着没有。
 * 开会话和 `read --pending` 不再走这里。
 */
export async function ledgerPending(
  repo: string,
  deps: { inbox: InboxDeps; gh: Gh },
): Promise<{ handoffs: LedgerHandoff[]; directives: LedgerDirective[] }> {
  const synced = await ledgerSync(repo, deps.inbox);
  if (synced.directives.length === 0) return { handoffs: synced.handoffs, directives: [] };
  const open = await openIssueNumbers(deps.gh);
  return { handoffs: synced.handoffs, directives: synced.directives.filter((d) => open.has(d.issue)) };
}

/**
 * 记一条创始人引导。返回挂的单、是不是新开的（同一句同一分钟重跑 created:false）。
 * id 与 issue 都是这张单的号（不再有账本行编号）。
 */
export async function recordDirectiveToLedger(
  r: DirectiveToRecord,
  meta: { meaning: string; category: DirectiveKind; priorIssue?: number },
  deps: DirectiveLedgerDeps,
  issue?: number,
): Promise<{ id: number; issue: number; created: boolean }> {
  if (!meta.meaning.trim())
    throw new DirectiveRefused(
      '记引导必须给 --meaning "不带原话的意思"（单在公开仓，只用意思，原话只存本机私有处）。没记。',
    );
  const meaning = safePublicMeaning(meta.meaning, r.text);
  if (meaning === HIDDEN)
    throw new DirectiveRefused('意思里整句抄着原话，或意思是空的。单在公开仓，改成转述再记。没记。');
  const home = homeOf(deps);
  const key = noteIdempotencyKey('directive', r.text, r.atDate);
  const index = readIndex(home);
  const known = index[key];
  if (known) {
    await ensureLabel(deps.gh, deps.repo, known.issue);
    // 上次开了单、索引写上了，但标签或主人标记没补完：补完再当重放，不再开第二张。
    if (!known.quoteId) await appendMark(deps.gh, deps.repo, known.issue, r.owner, key);
    if (!known.quoteId) {
      const quoteId = randomUUID();
      saveDirectiveQuote(home, {
        id: quoteId,
        text: r.text,
        at: r.at,
        owner: r.owner,
        meaning,
        issue: known.issue,
      });
      index[key] = { issue: known.issue, quoteId };
      writeIndex(home, index);
    }
    return { id: known.issue, issue: known.issue, created: false };
  }
  const openLabeled = await listDirectiveIssues(deps.gh, deps.repo, 'open');
  const hit = openLabeled.find((i) => i.body.includes(markerFor(key)));
  if (hit) {
    await ensureLabel(deps.gh, deps.repo, hit.number);
    const quoteId = randomUUID();
    saveDirectiveQuote(home, {
      id: quoteId,
      text: r.text,
      at: r.at,
      owner: r.owner,
      meaning,
      issue: hit.number,
    });
    index[key] = { issue: hit.number, quoteId };
    writeIndex(home, index);
    return { id: hit.number, issue: hit.number, created: false };
  }
  const draft = directiveIssueDraft({
    meaning,
    at: r.at,
    source: r.source,
    owner: r.owner,
    ...(meta.priorIssue !== undefined ? { priorIssue: meta.priorIssue } : {}),
    marker: key,
  });
  let n = issue;
  let opened = false;
  if (n !== undefined) await checkIssueOpen(deps.gh, n);
  else {
    if (!deps.newIssue) throw new DirectiveRefused('没给 --issue，也没法开单：没记。');
    n = await deps.newIssue(draft);
    opened = true;
  }
  index[key] = { issue: n, quoteId: '' };
  writeIndex(home, index);
  try {
    await ensureLabel(deps.gh, deps.repo, n);
    if (!opened) await appendMark(deps.gh, deps.repo, n, r.owner, key);
    const quoteId = randomUUID();
    saveDirectiveQuote(home, { id: quoteId, text: r.text, at: r.at, owner: r.owner, meaning, issue: n });
    index[key] = { issue: n, quoteId };
    writeIndex(home, index);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new DirectiveUnchecked(
      `${why}${opened ? `已顺手开了单 #${n}，重跑时带 --issue ${n}，别再开一张。` : ''}引导没记完。`,
    );
  }
  return { id: n, issue: n, created: true };
}

/**
 * 旧账本里还开着的引导逐条开一张带标签的单。正文写「原单：#原号」，不写原话。
 * 已经有这行原单号的、或本机索引里迁过的，不再开。
 */
export async function migrateOpenDirectives(
  rows: readonly LedgerDirective[],
  deps: DirectiveLedgerDeps,
): Promise<{ opened: { ledgerId: number; from: number; issue: number }[]; already: number[] }> {
  if (rows.length === 0) return { opened: [], already: [] };
  if (!deps.newIssue) throw new DirectiveRefused('没法开单：没迁。');
  const home = homeOf(deps);
  const index = readIndex(home);
  let existing = await listDirectiveIssues(deps.gh, deps.repo, 'open');
  const opened: { ledgerId: number; from: number; issue: number }[] = [];
  const already: number[] = [];
  for (const row of rows) {
    const key = `ledger:${row.id}`;
    const prior = new RegExp(`原单：#${row.issue}(?!\\d)`);
    const found = existing.find((i) => prior.test(i.body));
    const known = index[key];
    if (found || known) {
      const n = known?.issue ?? found?.number;
      if (n === undefined) throw new DirectiveUnchecked(`账本行 ${row.id} 对上了已有单，却没有单号。`);
      await ensureLabel(deps.gh, deps.repo, n);
      if (!known?.quoteId) {
        const quoteId = randomUUID();
        const owner = row.owner.trim() || '无主';
        saveDirectiveQuote(home, {
          id: quoteId,
          text: row.text,
          at: row.spokenAt || row.at,
          owner,
          meaning: safePublicMeaning(row.meaning, row.text, true),
          issue: n,
        });
        index[key] = { issue: n, quoteId };
        writeIndex(home, index);
      }
      already.push(row.issue);
      continue;
    }
    const meaning = safePublicMeaning(row.meaning, row.text, true);
    const owner = row.owner.trim() || '无主';
    const draft = directiveIssueDraft({
      meaning,
      at: row.spokenAt || row.at,
      source: `法国账本行 ${row.id}`,
      owner,
      priorIssue: row.issue,
      marker: key,
    });
    const q = row.text.trim();
    if (q.length >= 6 && (draft.body.includes(q) || draft.title.includes(q)))
      throw new DirectiveUnchecked(`账本行 ${row.id} 的公开草稿里出现了原话，没开单。`);
    const n = await deps.newIssue(draft);
    index[key] = { issue: n, quoteId: '' };
    writeIndex(home, index);
    try {
      await ensureLabel(deps.gh, deps.repo, n);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new DirectiveUnchecked(`${why}单 #${n} 已开（原单 #${row.issue}），重跑会补标签，不会再开一张。`);
    }
    const quoteId = randomUUID();
    saveDirectiveQuote(home, {
      id: quoteId,
      text: row.text,
      at: row.spokenAt || row.at,
      owner,
      meaning,
      issue: n,
    });
    index[key] = { issue: n, quoteId };
    writeIndex(home, index);
    opened.push({ ledgerId: row.id, from: row.issue, issue: n });
    existing = [...existing, { number: n, title: draft.title, body: draft.body, createdAt: row.at }];
  }
  return { opened, already };
}
