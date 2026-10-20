// 每天补齐已收口版本的 CHANGELOG（#3110）。先读齐所有缺版和发布历史，再开一个 PR；任何一版没查成就不写。

import type { MilestoneDetail, PlanIssue } from '@fleet-dao/conventions';
import {
  addDays,
  type ChangelogVersion,
  hasChangelogVersion,
  milestoneVersion,
  writeChangelogVersion,
} from '@fleet-dao/conventions';
import type { ScheduleResult } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import type { ScheduleRunLog } from './github-reconcile.ts';

export const CHANGELOG_JOB = {
  id: 'changelog',
  name: '补齐版本更新日志',
  schedule: '每天 06:30（北京时间）',
  expectEveryMinutes: 2 * 24 * 60,
} as const;
export interface OpenChangelogPrInput {
  version: number;
  versions: number[];
  baseCommit: string;
  content: string;
  title: string;
  body: string;
}
export interface ChangelogGitHub {
  readHead(): Promise<{ commit: string; text: string }>;
  /** 分页读全已关闭的里程碑；读取失败抛错，不能返回空列表代替。 */
  milestones(): Promise<MilestoneDetail[]>;
  milestoneIssues(number: number): Promise<PlanIssue[]>;
  openPr(input: OpenChangelogPrInput): Promise<{ number: number; url: string }>;
}
export interface ChangelogJobDeps {
  github: ChangelogGitHub;
  /** release.sh 写的 /srv/fleet-dao-releases/.history 全文；缺文件、读不到必须抛。 */
  history(): Promise<string>;
  runs: ScheduleRunLog;
  now(): Date;
  log(level: 'info' | 'error', message: string, fields?: Record<string, unknown>): void;
}

/** 和 release-card 的同一份事件语义：只有 release/rollback/auto-rollback 真切版本，unhealthy/recovered 不算。 */
export function changelogReleases(history: string): { sha: string; date: string }[] {
  const out: { sha: string; date: string }[] = [];
  for (const raw of history.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [at, sha, event, extra, ...rest] = line.split(/\s+/);
    if (
      !at ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(at) ||
      Number.isNaN(Date.parse(at)) ||
      new Date(at).toISOString().replace('.000Z', 'Z') !== at ||
      !sha ||
      !/^[a-f0-9]{40}$/.test(sha) ||
      !event ||
      !['release', 'rollback', 'auto-rollback', 'unhealthy', 'recovered'].includes(event) ||
      // 旧 release writer 用 auto 标记自动发布；它是 release 的元数据，不是新事件。
      (extra !== undefined && extra !== 'unmerged' && !(event === 'release' && extra === 'auto')) ||
      rest.length > 0
    )
      throw new Error('法国发布历史有认不出的行');
    if (event === 'unhealthy' || event === 'recovered') continue;
    out.push({ sha, date: new Date(Date.parse(at) + 8 * 3_600_000).toISOString().slice(0, 10) });
  }
  return out;
}

function period(m: MilestoneDetail): Pick<ChangelogVersion, 'start' | 'end' | 'cutHead'> {
  const block = /<!--\s*fleet:cut\s*-->([\s\S]*?)<!--\s*\/fleet:cut\s*-->/.exec(m.description)?.[1];
  if (!block || block.includes('收口中')) throw new Error(`「${m.title}」缺少已完成的收口记录`);
  const head = /^- 收口时主线头：([a-f0-9]{40})\s*$/m.exec(block)?.[1];
  if (!head) throw new Error(`「${m.title}」收口时主线头没查成`);
  const end = m.dueOn?.slice(0, 10);
  if (!end || !/^\d{4}-\d{2}-\d{2}$/.test(end) || Number.isNaN(Date.parse(end)))
    throw new Error(`「${m.title}」到期日没查成`);
  // 版本从到期日前六天开始，时间盒一周（决定0100）；跨年同样按日历算，不用关单时刻冒充版本边界。
  return { start: addDays(end, -6), end, cutHead: head };
}

async function refresh(deps: ChangelogJobDeps): Promise<ScheduleResult> {
  const head = await deps.github.readHead();
  if (!/^[a-f0-9]{40}$/.test(head.commit)) throw new Error('CHANGELOG 的主线头认不出');
  // scanned 数的是逐条核过适用性的已关里程碑，不是筛选后需要补日志的版本。
  const milestones = (await deps.github.milestones()).filter((m) => m.state === 'closed');
  if (!milestones.length)
    return { outcome: 'unscanned', why: '已读全里程碑列表，没有已关闭的里程碑可核对更新日志' };
  const scanned = milestones.length;
  const versions = milestones
    .flatMap((m) => {
      const version = milestoneVersion(m.title);
      return version !== undefined && version >= 4 ? [{ m, version }] : [];
    })
    .sort((a, b) => a.version - b.version);
  if (new Set(versions.map((v) => v.version)).size !== versions.length) throw new Error('已关版本号重复');
  const missing = versions.filter((v) => !hasChangelogVersion(head.text, v.version));
  if (!missing.length) return { outcome: 'ok', scanned, found: 0 };
  const released = changelogReleases(await deps.history());
  let content = head.text;
  for (const { m, version } of missing) {
    const range = period(m);
    const issues = await deps.github.milestoneIssues(m.number);
    if (issues.some((i) => i.state === 'open')) throw new Error(`「${m.title}」仍有开着的单，收口事实没核清`);
    content = writeChangelogVersion(content, {
      version,
      ...range,
      issues,
      deliveries: {
        state: 'ok',
        commits: released.filter((r) => r.date >= range.start && r.date <= range.end).map((r) => r.sha),
      },
    });
  }
  const newest = missing.at(-1);
  if (!newest) throw new Error('缺版列表意外为空');
  const numbers = missing.map((v) => v.version);
  const pr = await deps.github.openPr({
    version: newest.version,
    versions: numbers,
    baseCommit: head.commit,
    content,
    title: `补齐 ${numbers.map((v) => `v${v}`).join('、')} 的更新日志`,
    body: '**做了什么**：按已完成单和法国发布历史补齐主线缺少的版本节；排期事实仍在里程碑。\n\n**需求**：无：每天补齐已收口版本的 CHANGELOG，机制见 #3110\n',
  });
  deps.log('info', `更新日志 PR #${pr.number}`, { url: pr.url, versions: numbers });
  return { outcome: 'ok', scanned, found: missing.length };
}

export async function runChangelogJob(deps: ChangelogJobDeps): Promise<ScheduleResult> {
  const id = await deps.runs.start(CHANGELOG_JOB.id, deps.now());
  let result: ScheduleResult;
  try {
    result = await refresh(deps);
  } catch (error) {
    result = { outcome: 'failed', why: `没查成：${errMessage(error)}` };
  }
  await deps.runs.finish(id, result, deps.now());
  if (result.outcome !== 'ok' && result.outcome !== 'unscanned') {
    deps.log('error', '版本更新日志没查成', { runId: id, ...result });
    throw new Error('why' in result ? result.why : '版本更新日志没查成');
  }
  return result;
}
