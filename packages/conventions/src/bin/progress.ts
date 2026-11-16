import { progressSessionId } from '../progress-session.ts';
// 进度和创始人引导的入口：pnpm progress note / progress directive / progress directive-export / progress directive-digest / progress read。
// 引导一条一张带「创始人引导」标签的 GitHub 单（../directive-ledger.ts，#4054），正文只用意思，原话在本机私有处；
// 不写 docs/directives/、不开分支、不开 PR、不再写法国账本。docs/directives/ 里已有的文件留作档案（../directives.ts 照读）。
// 进度流水只贴置顶单 #1055（../progress.ts），不写账本。--from-inbox 已删。
// 引导办没办完看这张单：开着就是没办完、关了就是办完；不再有认领、标已处理（#2727）。
// `directive-digest` 读这个标签下的单，生成那一周的意思汇总（不带原话）。
// `directive-export` 是账本读口仅剩的用途：把旧账本里还开着的引导逐条开成这种单，正文写原单号。
// 退出码 0 = 成了；1 = 拒绝（参数不对、挂的单不是开着的、取不到原话要手填）；2 = 没查成、没写成（含 gh 读不到单）。
// `read --pending`：只列没办完的引导，一条一行
// （编号<TAB>第一行<TAB>意思压成一行<TAB>主人<TAB>记下的时刻 ISO<TAB>挂的单号）；
// 读的是「创始人引导」标签下开着的单，加本地 origin/main 上旧档案里挂的单还开着的；不请求账本。
// 没有就输出空、退出码 0；gh 读不到退出码 2。
// 主人＝本会话的血缘：CLAUDE_CODE_SESSION_ID 所属的 Mirasim 会话目录名（agents/hooks/founder-inbox.mjs 的 lineageOf）。
// `directive` 必须带 `--kind ai|product|task|once|ops|discuss`（决定 0111、0117），判类放在读 prompt-log、fetch、调 gh 之前；
// 非 ai 不写文件、不开单、退出 0 并说去处。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { digestPath, isoWeekOf, renderDigest } from '../directive-digest.ts';
import {
  directiveIssueToDigest,
  ledgerPending,
  listDirectiveIssues,
  meaningOfDirectiveIssue,
  migrateOpenDirectives,
  recordDirectiveToLedger,
} from '../directive-ledger.ts';
import {
  DirectiveRefused,
  type Git,
  type LineageInfo,
  listPending,
  MAIN,
  mergeLogs,
  readPromptLog,
  resolveDirective,
} from '../directives.ts';
import { gitRunner } from '../git-runner.ts';
import { resolveRepo } from '../github-api.ts';
import { ghRunner, issueNew } from '../issue-new.ts';
import { inboxStatePath, liveLedgerEventsGet } from '../ledger-read.ts';
import { flushPrivateQuotes, privatizeDirective, publicMeaning } from '../private-quotes.ts';
import {
  type DirectiveKind,
  isDirectiveKind,
  KIND_JUDGE,
  kindDestination,
  ownerOf,
  PENDING_TAG,
  PROGRESS_ISSUE,
  PROGRESS_USAGE,
  ProgressRefused,
  ProgressUnchecked,
  progressNote,
  recentComments,
  stamp,
} from '../progress.ts';
import { franceSshHost, sshFleetApi } from '../project-world.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const gh = ghRunner(root);
const git: Git = gitRunner(root);

interface Hooks {
  lineageOf(o: { home: string; sessionId: unknown }): LineageInfo;
  sentByFounder(o: {
    home: string;
    only: string;
  }):
    | { absent: true }
    | { absent: false; entries: Array<{ at: number; text: string; sessionId: string | null }> };
}
/** 钩子家的脚本，按路径动态加载（同步专用检出里也是这样排的） */
const hooks = async (): Promise<Hooks> =>
  (await import(pathToFileURL(join(root, 'agents', 'hooks', 'founder-inbox.mjs')).href)) as Hooks;
const sessionId = (): string | null => progressSessionId(process.env);
async function myLineage(): Promise<LineageInfo> {
  return (await hooks()).lineageOf({ home: homedir(), sessionId: sessionId() });
}
const promptLogDir = () => process.env.FLEET_PROMPT_LOG_DIR || join(homedir(), '.fleet-dao', 'prompt-log');

/** 没给 --issue 时顺手开的单：杂项、当前版本、本机做。查询轴记 engine / process（引导是流水线自己的流程账）。 */
async function newIssue(draft: { title: string; body: string }): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'progress-issue-'));
  try {
    const bodyFile = join(dir, 'issue.md');
    writeFileSync(bodyFile, draft.body, 'utf8');
    const r = await issueNew(
      [
        '--kind',
        '杂项',
        '--domain',
        'engine',
        '--nature',
        'process',
        '--milestone',
        '当前',
        '--title',
        draft.title,
        '--body-file',
        bodyFile,
        '--local',
      ],
      { gh, cwd: root },
    );
    console.log(`开了单 #${r.number}（${r.milestone}）：${r.url}`);
    return r.number;
  } catch (e) {
    throw new ProgressUnchecked(`开单没成：${e instanceof Error ? e.message : String(e)}。引导没记。`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const privateApi = sshFleetApi(() => franceSshHost(), 'ssh', 30_000);
const callingRoot = process.env.INIT_CWD || process.cwd();
const kindHooks = await import(pathToFileURL(join(root, 'agents/hooks/repo-kind.mjs')).href);
const external = kindHooks.repoKind(callingRoot) === 'external';
async function privateRecord<T extends { text: string; atDate: Date; owner: string }>(
  r: T,
  meaning: string | undefined,
) {
  if (!external) return r;
  const remoteResult = await gitRunner(callingRoot)(['config', '--get', 'remote.origin.url']);
  const saved = await privatizeDirective(r, {
    home: homedir(),
    machine: hostname(),
    lineage: r.owner === '无主' ? (sessionId() ?? 'unknown:no-session-id') : r.owner,
    remote: remoteResult.code === 0 ? remoteResult.stdout.trim() : null,
    meaning,
    api: privateApi,
  });
  if (saved.remaining)
    console.error('私有原话没传成：已留本机私有待传目录，稍后 pnpm progress quotes:flush。');
  return saved.directive;
}

/** 本仓 owner/name；认不出就是没查成，不退回别的仓 */
function ledgerRepo(): string {
  const repo = resolveRepo(process.env, root).repo;
  if (!repo) throw new ProgressUnchecked('认不出本仓 owner/name，没法列引导单。');
  return repo;
}
const ledgerGet = liveLedgerEventsGet();
/** 只给 directive-export：状态文件 ~/.fleet-dao/ledger-inbox.json，增量读旧账本 */
const inboxDeps = { get: ledgerGet, stateFile: inboxStatePath() };

/** 开引导单要的接线：本仓、顺手开单、原话写在这个家目录下 */
function directiveLedgerDeps() {
  return { gh, repo: ledgerRepo(), newIssue, ref: sessionId() ?? hostname(), home: homedir() };
}

/** --meaning：自用仓也必给（单在公开仓，只用意思）；对外仓的由 privateRecord 先换成意思 */
const meaningOf = (safeText: string, meaning: string | undefined): string => {
  if (external) return safeText;
  if (!meaning?.trim())
    throw new DirectiveRefused(
      '记引导必须给 --meaning "不带原话的意思"（单在公开仓，原话只存本机私有处）。没记。',
    );
  return meaning.trim();
};

/** 没办完的：「创始人引导」标签下开着的单，加旧档案（主线上 docs/directives）挂的单还开着的。不读账本。 */
async function pendingRows(): Promise<
  Array<{ id: string; head: string; text: string; owner: string; created: string; issue: string }>
> {
  const labeled = await listDirectiveIssues(gh, ledgerRepo(), 'open');
  const repo = await listPending(git, gh, MAIN);
  const rows = repo.map((d) => ({
    id: d.id,
    head: `${PENDING_TAG}${d.at}`,
    text: d.text,
    owner: d.owner,
    created: (() => {
      const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/.exec(d.at);
      return m ? new Date(`${m[1]}T${m[2]}:00+08:00`).toISOString() : '';
    })(),
    issue: d.issue === undefined ? '' : `#${d.issue}`,
  }));
  const seen = new Set(rows.map((r) => r.issue));
  for (const i of labeled) {
    const issue = `#${i.number}`;
    if (seen.has(issue)) continue;
    const when = new Date(i.createdAt);
    rows.push({
      id: String(i.number),
      head: `${PENDING_TAG}${Number.isNaN(when.getTime()) ? '' : stamp(when)}`,
      text: meaningOfDirectiveIssue(i),
      owner: ownerOf(i.body),
      created: i.createdAt,
      issue,
    });
  }
  return rows;
}

try {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      at: { type: 'string' },
      owner: { type: 'string' },
      limit: { type: 'string' },
      pending: { type: 'boolean' },
      issue: { type: 'string' },
      'from-inbox': { type: 'string' },
      kind: { type: 'string' },
      meaning: { type: 'string' },
      stdin: { type: 'boolean' },
      week: { type: 'string' },
      write: { type: 'boolean' },
    },
  });
  const issueArg = (): number | undefined => {
    if (values.issue === undefined) return undefined;
    const m = /^#?([1-9]\d*)$/.exec(values.issue.trim());
    if (!m?.[1]) throw new ProgressRefused(`--issue ${values.issue} 不对，要单号（如 2727）。`);
    return Number(m[1]);
  };
  // 先判类再动手：放在读 prompt-log、fetch、调 gh 之前（决定 0111）。类别由 AI 自报，代码不猜（决定 0013）。
  let kind: DirectiveKind | undefined;
  if (cmd === 'directive') {
    if (!isDirectiveKind(values.kind))
      throw new ProgressRefused(
        `${values.kind === undefined ? '没带 --kind' : `--kind ${values.kind} 认不出`}（要 ai|product|task|once|ops|discuss 之一），引导没记。\n${KIND_JUDGE}`,
      );
    kind = values.kind;
  }
  if (values['from-inbox'] !== undefined) {
    throw new ProgressRefused(
      '--from-inbox 已关掉，不再写账本。没办完的引导看「创始人引导」标签下开着的单（pnpm progress read --pending）。',
    );
  }
  if (cmd === 'directive' && kind === 'ai' && external) {
    publicMeaning(values.meaning);
    if (positionals.length)
      throw new DirectiveRefused('对外仓原话只从 prompt-log 或 --stdin 读取，不接受命令行正文。');
  } else if (cmd === 'directive' && kind === 'ai') {
    meaningOf('', values.meaning); // 自用仓也要意思：先查，别等读完 prompt-log 才发现缺
  }
  if (cmd === 'directive' && kind !== undefined && kind !== 'ai') {
    // 不该记引导的类别：不写文件、不开单，退出 0 并说去处。
    const where = kindDestination(kind, external);
    console.log(`判成 ${kind}，不进创始人引导，没写文件。记在：${where}。`);
  } else if (cmd === 'quotes:flush') {
    const result = await flushPrivateQuotes(homedir(), privateApi);
    console.log('私有原话补传：成功 ' + result.sent + '，未传成 ' + result.remaining + '（内容不回显）。');
    if (result.remaining) process.exitCode = 2;
  } else if (cmd === 'note') {
    const noteText = positionals.join(' ');
    const c = await progressNote(noteText, { gh });
    console.log(`贴到 #${PROGRESS_ISSUE} 了：${c.url}`);
  } else if (cmd === 'directive') {
    let text = positionals.join(' ');
    if (values.stdin) {
      if (text) throw new DirectiveRefused('--stdin 不和命令行正文一起用。');
      text = '';
      for await (const chunk of process.stdin) text += chunk;
    }
    const line = await myLineage();
    const sent =
      line.status === 'found'
        ? (await hooks()).sentByFounder({ home: homedir(), only: line.dir })
        : { absent: true as const };
    const fallbackId = line.status === 'found' ? (line.sessionIds[0] ?? null) : null;
    const mirasim =
      'entries' in sent
        ? sent.entries.map((e) => ({
            at: new Date(e.at),
            sessionId: e.sessionId ?? fallbackId,
            prompt: e.text,
            source: 'Mirasim 会话记录',
          }))
        : [];
    const r = resolveDirective(
      { text: text || undefined, at: values.at, owner: values.owner, preserveText: external },
      line,
      mergeLogs(readPromptLog(promptLogDir(), new Date()), mirasim),
      sessionId(),
    );
    const safe = await privateRecord(r, values.meaning);
    const said = meaningOf(safe.text, values.meaning);
    if (!external && r.text.trim().length >= 6 && said.trim() === r.text.trim()) {
      throw new DirectiveRefused('意思和原话是同一句。单在公开仓，改成转述再记。没记。');
    }
    const made = await recordDirectiveToLedger(
      safe,
      { meaning: said, category: 'ai' },
      directiveLedgerDeps(),
      issueArg(),
    );
    console.log(
      `记下创始人引导（单 #${made.issue}${made.created ? '' : '，同一句已记过、这次是重放'}，主：${safe.owner}，时间 ${safe.at}，来源 ${safe.source}），没写文件、没开 PR。\n` +
        `意思：${said.replace(/\s+/g, ' ').slice(0, 200)}\n办完就是把单 #${made.issue} 关掉：干活的 PR 写 Closes #${made.issue}（合并自动关）。\n${KIND_JUDGE}`,
    );
  } else if (cmd === 'directive-export') {
    const ledger = await ledgerPending(ledgerRepo(), { inbox: inboxDeps, gh });
    const result = await migrateOpenDirectives(ledger.directives, directiveLedgerDeps());
    console.log(
      `旧账本里还开着的引导：新开 ${result.opened.length} 张，已有单 ${result.already.length} 张。`,
    );
    for (const o of result.opened) console.log(`账本行 ${o.ledgerId} 原单 #${o.from} → #${o.issue}`);
  } else if (cmd === 'directive-digest') {
    const week = values.week ?? isoWeekOf(new Date());
    const issues = await listDirectiveIssues(gh, ledgerRepo(), 'all');
    const text = renderDigest(week, issues.map(directiveIssueToDigest));
    if (values.write) {
      const file = join(root, digestPath(week));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text, 'utf8');
      console.log(`写了 ${digestPath(week)}（只有意思，没有原话）；用普通 PR 提交。`);
    } else {
      process.stdout.write(text);
    }
  } else if (cmd === 'read') {
    const limit = values.limit === undefined ? 10 : Number(values.limit);
    if (!Number.isInteger(limit) || limit < 0)
      throw new ProgressRefused(`--limit ${values.limit} 不对，要非负整数。`);
    if (!values.pending) await git(['fetch', '-q', 'origin', 'main']);
    const rows = await pendingRows();
    if (values.pending) {
      for (const r of rows)
        console.log(
          `${r.id}\t${r.head}\t${r.text.replace(/\s+/g, ' ')}\t${r.owner}\t${r.created}\t${r.issue}`,
        );
    } else {
      const recent = await recentComments(limit, { gh });
      console.log(`#${PROGRESS_ISSUE} 最近 ${recent.length} 条（旧到新）：`);
      for (const c of recent) console.log(`\n[${c.id}] ${c.body.trim()}`);
      console.log(
        `\n没办完的创始人引导 ${rows.length} 条（「创始人引导」标签下开着的单，和 docs/directives 旧档案挂的单还开着的）：`,
      );
      for (const r of rows)
        console.log(
          `\n[${r.id}]（${r.head.replace(/^【[^】]*】/, '')}，主：${r.owner}${r.issue ? `，单 ${r.issue}` : ''}）${r.text}`,
        );
    }
  } else {
    throw new ProgressRefused(PROGRESS_USAGE);
  }
} catch (e) {
  console.error(
    external &&
      process.argv[2] === 'directive' &&
      !(e instanceof DirectiveRefused) &&
      !(e instanceof ProgressRefused)
      ? '对外仓引导没记成；私有原话已存的保留待传，内容不回显。'
      : e instanceof Error
        ? e.message
        : String(e),
  );
  process.exitCode = e instanceof ProgressRefused || e instanceof DirectiveRefused ? 1 : 2;
}
