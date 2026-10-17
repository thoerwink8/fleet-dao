// GitHub 没有跨 issue 的事务：批量创建先暂贴本机做，失败关闭整批，恢复记录留在 _tmp。
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { checkIssueBody, type Gh, issueBodyTooLong } from './issue-new.ts';
import { isKindLabel, LOCAL_LABEL, MOTHER_LABEL } from './labels.ts';
import { readManifest, withManifest } from './mother-manifest.ts';

export interface BatchIssue {
  title: string;
  body: string;
  kind: string;
}
export interface BatchSpec {
  mother: BatchIssue;
  subs: BatchIssue[];
  local?: boolean;
}
interface Created {
  number: number;
  id: number;
  url: string;
}
interface Journal {
  version: 1;
  id: string;
  status: 'building' | 'complete' | 'rolled_back';
  issues: Created[];
  uncertain: boolean;
}
export interface BatchResult {
  mother: { number: number; url: string };
  subs: { number: number; url: string }[];
  journal: string;
}
interface Deps {
  gh: Gh;
  cwd: string;
  journal?: string;
}
const endpoint = 'repos/{owner}/{repo}/issues';
const marker = (id: string) => `<!-- fleet:issue-batch:${id}:`;
const save = (path: string, journal: Journal) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.next`, `${JSON.stringify(journal, null, 2)}\n`);
  renameSync(`${path}.next`, path);
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** CLI 和编排层共用的全批预检；任何一张不合法时还没有 GitHub 写入。 */
export function validateBatch(spec: BatchSpec): void {
  if (!spec?.mother || !Array.isArray(spec.subs) || spec.subs.length === 0)
    throw new Error('批量输入需要 mother 和非空 subs 列表。');
  if (spec.local !== undefined && typeof spec.local !== 'boolean') throw new Error('local 要是布尔值。');
  for (const [index, issue] of [spec.mother, ...spec.subs].entries()) {
    if (!issue || typeof issue.title !== 'string' || !issue.title.trim())
      throw new Error(`第 ${index} 张缺 title。`);
    if (typeof issue.body !== 'string' || !isKindLabel(issue.kind))
      throw new Error(`第 ${index} 张需要 body 和 kind（需求/缺陷/杂项）。`);
    const check = checkIssueBody(issue.body, { local: spec.local === true });
    if (!check.ok) throw new Error(`第 ${index} 张：${check.why}`);
    const long = issueBodyTooLong(
      `${issue.body}\n\nparent: #999999999999999\n${marker(randomUUID())}mother -->`,
    );
    if (long) throw new Error(long);
    if (/^\s*parent\s*:/im.test(issue.body) || issue.body.includes('<!-- fleet:issue-batch:'))
      throw new Error(`第 ${index} 张已有 parent 或批量标记，不能覆盖已有关系。`);
  }
}

async function api(deps: Deps, args: string[]): Promise<unknown> {
  const r = await deps.gh(args);
  if (r.code !== 0) throw new Error(`GitHub 退出码 ${r.code}：${r.stderr.trim() || r.stdout.trim()}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error('GitHub 回包不是 JSON。');
  }
}
function created(raw: unknown): Created {
  const r = raw as Record<string, unknown> | null;
  if (
    !r ||
    !Number.isSafeInteger(r.number) ||
    Number(r.number) <= 0 ||
    !Number.isSafeInteger(r.id) ||
    Number(r.id) <= 0 ||
    typeof r.html_url !== 'string' ||
    !r.html_url.endsWith(`/issues/${r.number}`)
  )
    throw new Error('创建回包的 number/id/html_url 认不出。');
  return { number: Number(r.number), id: Number(r.id), url: r.html_url };
}

/** 直接分页读，不用有索引延迟的搜索：创建超时也可能已经在 GitHub 落单。 */
async function discover(journal: Journal, deps: Deps): Promise<void> {
  const pages = await api(deps, ['api', `${endpoint}?state=all&per_page=100`, '--paginate', '--slurp']);
  if (!Array.isArray(pages) || pages.length === 0 || !pages.every(Array.isArray))
    throw new Error('批量恢复列表不是非空分页数组。');
  for (const raw of pages.flat()) {
    if (raw?.body === null) continue;
    if (!raw || typeof raw.body !== 'string') throw new Error('批量恢复列表缺 body，不能确认有没有残留。');
    const exactMarker = new RegExp(`^<!-- fleet:issue-batch:${journal.id}:(?:mother|sub) -->\\r?$`, 'm');
    if (!exactMarker.test(raw.body)) continue;
    const item = created(raw);
    if (!journal.issues.some((i) => i.number === item.number)) journal.issues.push(item);
  }
  journal.uncertain = false;
}

async function rollback(path: string, journal: Journal, deps: Deps): Promise<void> {
  const errors: string[] = [];
  if (journal.uncertain) {
    try {
      await discover(journal, deps);
      save(path, journal);
    } catch (e) {
      errors.push(`创建结果没核清：${message(e)}`);
    }
  }
  for (const issue of [...journal.issues].reverse()) {
    try {
      const back = await api(deps, [
        'api',
        '-X',
        'PATCH',
        `${endpoint}/${issue.number}`,
        '-f',
        'state=closed',
        '-f',
        'state_reason=not_planned',
      ]);
      if ((back as { state?: unknown } | null)?.state !== 'closed') throw new Error('回包没有确认 closed');
    } catch (e) {
      errors.push(`#${issue.number} 没撤销：${message(e)}`);
    }
  }
  if (errors.length) {
    save(path, journal);
    throw new Error(`${errors.join('；')}。恢复命令：pnpm issue:batch --recover "${path}"`);
  }
  journal.status = 'rolled_back';
  save(path, journal);
}

/** 失败或进程中断后只清理本批产物，不再创建新单；成功的批次不可误撤销。 */
export async function recoverIssueBatch(path: string, deps: Deps): Promise<void> {
  const journal = JSON.parse(readFileSync(path, 'utf8')) as Journal;
  if (
    journal.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(journal.id) ||
    !['building', 'complete', 'rolled_back'].includes(journal.status) ||
    !Array.isArray(journal.issues) ||
    typeof journal.uncertain !== 'boolean'
  )
    throw new Error('恢复记录认不出，未操作 GitHub。');
  for (const i of journal.issues) created({ ...i, html_url: i.url });
  if (journal.status === 'complete') throw new Error('这一批已完成，不能用恢复命令撤销。');
  if (journal.status === 'rolled_back') return;
  journal.uncertain = true;
  await rollback(path, journal, deps);
}

/** 全部建好才返回；失败取消整批，取消失败明确报残留号及恢复命令。 */
export async function issueBatchNew(spec: BatchSpec, deps: Deps): Promise<BatchResult> {
  validateBatch(spec);
  const journal: Journal = { version: 1, id: randomUUID(), status: 'building', issues: [], uncertain: false };
  const path = resolve(deps.cwd, deps.journal ?? `_tmp/issue-batch/${journal.id}.json`);
  // 不覆盖还没处理的批次记录。
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(journal), { flag: 'wx' });
  const input = `${path}.input.json`;
  try {
    let mother: Created | undefined;
    for (const [index, issue] of [spec.mother, ...spec.subs].entries()) {
      const body = `${marker(journal.id)}${index === 0 ? 'mother' : 'sub'} -->\n${index === 0 ? '' : `parent: #${mother?.number}\n`}\n${issue.body.trimEnd()}\n`;
      writeFileSync(
        input,
        JSON.stringify({
          title: issue.title,
          body,
          labels: [issue.kind, LOCAL_LABEL, ...(index === 0 ? [MOTHER_LABEL] : [])],
        }),
      );
      journal.uncertain = true;
      save(path, journal);
      const item = created(await api(deps, ['api', '-X', 'POST', endpoint, '--input', input]));
      journal.issues.push(item);
      journal.uncertain = false;
      save(path, journal);
      if (index === 0) mother = item;
      else {
        const link = await deps.gh([
          'api',
          '-X',
          'POST',
          `${endpoint}/${mother?.number}/sub_issues`,
          '-F',
          `sub_issue_id=${item.id}`,
        ]);
        if (link.code !== 0) throw new Error(`#${item.number} 挂母单失败：${link.stderr || link.stdout}`);
      }
    }
    if (!mother) throw new Error('没有创建母单。');
    const current = (await api(deps, ['api', `${endpoint}/${mother.number}`])) as { body?: unknown };
    if (typeof current?.body !== 'string') throw new Error('母单正文读不到，清单没有写入。');
    const numbers = journal.issues
      .slice(1)
      .map((i) => i.number)
      .sort((a, b) => a - b);
    const motherBody = withManifest(current.body, numbers);
    writeFileSync(input, JSON.stringify({ body: motherBody }));
    const patched = (await api(deps, [
      'api',
      '-X',
      'PATCH',
      `${endpoint}/${mother.number}`,
      '--input',
      input,
    ])) as { body?: unknown };
    const manifest = typeof patched?.body === 'string' ? readManifest(patched.body) : undefined;
    if (
      patched.body !== motherBody ||
      manifest?.kind !== 'valid' ||
      manifest.children.join() !== numbers.join()
    )
      throw new Error('母单清单写入回包与全部子单不一致。');
    if (!spec.local) {
      for (const i of journal.issues) {
        const edit = await deps.gh(['issue', 'edit', String(i.number), '--remove-label', LOCAL_LABEL]);
        if (edit.code !== 0) throw new Error(`#${i.number} 撤暂存标签失败：${edit.stderr || edit.stdout}`);
      }
    }
    journal.status = 'complete';
    save(path, journal);
    return { mother, subs: journal.issues.slice(1), journal: path };
  } catch (e) {
    try {
      await rollback(path, journal, deps);
    } catch (cleanup) {
      throw new Error(`批量创建失败：${message(e)}；${message(cleanup)}`);
    }
    throw new Error(
      `批量创建失败：${message(e)}；本批 ${journal.issues.length} 张已关闭为 not_planned，没有开着的半批。`,
    );
  } finally {
    rmSync(input, { force: true });
  }
}
