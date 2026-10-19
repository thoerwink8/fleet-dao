import { progressSessionId } from '../progress-session.ts';
// 进度和创始人引导的入口：pnpm progress note / progress directive / progress read。
// 引导记在仓里 docs/directives/（../directives.ts），进度流水和驾驶舱来的引导收件箱在置顶单 #1055（../progress.ts）。
// 引导办没办完看它挂的单（文件里「单：#N」）：开着就是没办完、关了就是办完；不再有认领、标已处理（#2727）。
// 退出码 0 = 成了；1 = 拒绝（参数不对、挂的单不是开着的、取不到原话要手填）；2 = 没查成、没写成（含 gh 读不到单）。
// `read --pending` 给开会话钩子用：只列没办完的引导，一条一行
// （编号<TAB>第一行<TAB>原话压成一行<TAB>主人<TAB>记下的时刻 ISO<TAB>挂的单号，没挂单的空）；
// 读的是本地 origin/main 加 gh 读开着的单，加 #1055 收件箱最近 30 天；没有就输出空、退出码 0。
// 主人＝本会话的血缘：CLAUDE_CODE_SESSION_ID 所属的 Mirasim 会话目录名（agents/hooks/founder-inbox.mjs 的 lineageOf）。
// `directive --from-inbox <评论号>`：把驾驶舱答案收件箱（#1055）里的一条搬进仓（挂单同 directive），原评论改成已迁。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  checkIssueOpen,
  DirectiveRefused,
  directiveFromComment,
  directiveIssueDraft,
  formatDirective,
  type Git,
  type LineageInfo,
  listPaths,
  listPending,
  MAIN,
  mergeLogs,
  proposeFile,
  readPromptLog,
  recordDirective,
  resolveDirective,
} from '../directives.ts';
import { gitRunner } from '../git-runner.ts';
import { ghRunner, issueNew } from '../issue-new.ts';
import { flushPrivateQuotes, privatizeDirective, publicMeaning } from '../private-quotes.ts';
import {
  inboxPending,
  markMigrated,
  PENDING_TAG,
  PROGRESS_ISSUE,
  PROGRESS_USAGE,
  ProgressRefused,
  ProgressUnchecked,
  progressNote,
  readInboxComment,
  recentComments,
  textOf,
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
const deps = { git, gh, newIssue };
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

/** 收件箱里的一条搬进仓（挂 issue 这张单，没给就开一张），再把原评论改成「已迁」 */
async function importFromInbox(
  id: number,
  issue: number | undefined,
  meaning: string | undefined,
): Promise<{ url: string; issue: number }> {
  const c = await readInboxComment(id, { gh });
  const original = directiveFromComment({ ...c, text: textOf(c) }, issue ?? 1);
  const safe = await privateRecord(
    { ...original, atDate: new Date(original.at.replace(' ', 'T').replace(' +0800', ':00+08:00')) },
    meaning,
  );
  let n = issue;
  if (n !== undefined) await checkIssueOpen(gh, n);
  else
    n = await newIssue(
      directiveIssueDraft({
        text: safe.text,
        at: safe.at,
        source: `#${PROGRESS_ISSUE} 评论 ${id}`,
      }),
    );
  const d = { ...safe, issue: n };
  const url = await proposeFile(deps, {
    id: d.id,
    path: d.path,
    content: formatDirective(d),
    title: `搬创始人引导 ${d.id} 进仓（从 #${PROGRESS_ISSUE}，挂单 #${n}）`,
    did: `搬到 ${d.path}，挂单 #${n}，从 #${PROGRESS_ISSUE} 收件箱`,
  });
  await markMigrated(
    external ? { ...c, head: PENDING_TAG + safe.at, body: PENDING_TAG + safe.at + '\n\n' + safe.text } : c,
    `${d.path}（${url}）`,
    { gh },
  );
  return { url, issue: n };
}

/** 没办完的：仓里主线上挂的单还开着的（旧文件按状态行），加收件箱里还没搬进仓的 */
async function pendingRows(): Promise<
  Array<{ id: string; head: string; text: string; owner: string; created: string; issue: string }>
> {
  const repo = await listPending(git, gh, MAIN);
  const known = new Set((await listPaths(git, MAIN)).map((p) => p.replace(/^.*\//, '').replace(/\.md$/, '')));
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
  for (const c of await inboxPending({ gh })) {
    if (known.has(String(c.id))) continue;
    rows.push({
      id: String(c.id),
      head: c.head,
      text: textOf(c),
      owner: c.owner,
      created: c.createdAt,
      issue: '',
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
      meaning: { type: 'string' },
      stdin: { type: 'boolean' },
    },
  });
  const issueArg = (): number | undefined => {
    if (values.issue === undefined) return undefined;
    const m = /^#?([1-9]\d*)$/.exec(values.issue.trim());
    if (!m?.[1]) throw new ProgressRefused(`--issue ${values.issue} 不对，要单号（如 2727）。`);
    return Number(m[1]);
  };
  if (cmd === 'directive' && external) {
    publicMeaning(values.meaning);
    if (positionals.length)
      throw new DirectiveRefused('对外仓原话只从 prompt-log 或 --stdin 读取，不接受命令行正文。');
  }
  if (cmd === 'quotes:flush') {
    const result = await flushPrivateQuotes(homedir(), privateApi);
    console.log('私有原话补传：成功 ' + result.sent + '，未传成 ' + result.remaining + '（内容不回显）。');
    if (result.remaining) process.exitCode = 2;
  } else if (cmd === 'note') {
    const c = await progressNote(positionals.join(' '), { gh });
    console.log(`贴到 #${PROGRESS_ISSUE} 了：${c.url}`);
  } else if (cmd === 'directive' && values['from-inbox'] !== undefined) {
    const cid = Number(values['from-inbox']);
    if (!Number.isInteger(cid) || cid <= 0)
      throw new ProgressRefused(`--from-inbox ${values['from-inbox']} 不对，要收件箱评论号。`);
    const r = await importFromInbox(cid, issueArg(), values.meaning);
    console.log(`搬进仓了（评论 ${cid}，挂单 #${r.issue}），PR 已挂自动合并：${r.url}`);
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
    const made = await recordDirective(safe, deps, issueArg());
    console.log(
      `记下创始人引导 ${made.id}（挂单 #${made.issue}，主：${safe.owner}，时间 ${safe.at}，来源 ${safe.source}）：${made.path}，PR 已挂自动合并 ${made.url}\n` +
        `${external ? '意思' : '原话'}：${safe.text.replace(/\s+/g, ' ').slice(0, 200)}\n办完就是把单 #${made.issue} 关掉：干活的 PR 写 Closes #${made.issue}（合并自动关），这个文件不用再改。`,
    );
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
        `\n没办完的创始人引导 ${rows.length} 条（docs/directives 挂的单还开着，和 #${PROGRESS_ISSUE} 收件箱）：`,
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
    external && process.argv[2] === 'directive' && !(e instanceof DirectiveRefused)
      ? '对外仓引导没记成；私有原话已存的保留待传，内容不回显。'
      : e instanceof Error
        ? e.message
        : String(e),
  );
  process.exitCode = e instanceof ProgressRefused || e instanceof DirectiveRefused ? 1 : 2;
}
