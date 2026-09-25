// 阶段收口（#67）：pnpm milestone:close-check P1。关一个里程碑之前，列出里面还开着的 issue 和 PR；
// 每张要么做完关掉，要么挪到后面的里程碑并在单上写明原因。还有开着的就退出码 1，不许关。
// 里程碑找不到、GitHub 读不到、读回来认不出：退出码 2（没查成），不当成「里面是空的」。
import type { GitHubReader, MilestoneInfo } from './github-api.ts';
import { milestonePhase } from './labels.ts';

export const MILESTONE_USAGE = '用法：pnpm milestone:close-check P1（或里程碑全名，如「P1 核心闭环」）';

export interface CloseCheck {
  /** 0 = 里面没有开着的，可以关；1 = 还有开着的；2 = 没查成。 */
  code: 0 | 1 | 2;
  lines: string[];
}

export async function milestoneCloseCheck(argv: readonly string[], gh: GitHubReader): Promise<CloseCheck> {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  const want = args.join(' ').trim();
  if (!want || args.some((a) => a.startsWith('-'))) {
    return { code: 2, lines: [`没查成：没说是哪个里程碑。${MILESTONE_USAGE}`] };
  }
  let milestones: MilestoneInfo[];
  try {
    milestones = await gh.milestones();
  } catch (e) {
    return { code: 2, lines: [`没查成：读不到里程碑（${message(e)}）。`] };
  }
  const exact = milestones.filter((m) => m.title === want);
  const phase = /^P\d+$/.test(want) ? Number(want.slice(1)) : undefined;
  const matches =
    exact.length || phase === undefined ? exact : milestones.filter((m) => milestonePhase(m.title) === phase);
  const [ms, ...more] = matches;
  if (ms === undefined) {
    const all = milestones.map((m) => m.title).join('、') || '（一个也没有）';
    return { code: 2, lines: [`没查成：没有叫「${want}」的里程碑，有的是 ${all}。`] };
  }
  if (more.length) {
    return {
      code: 2,
      lines: [`没查成：「${want}」对上了好几个里程碑（${matches.map((m) => m.title).join('、')}）：写全名。`],
    };
  }

  let items: Awaited<ReturnType<GitHubReader['openInMilestone']>>;
  try {
    items = await gh.openInMilestone(ms.number);
  } catch (e) {
    return { code: 2, lines: [`没查成：读不到「${ms.title}」里开着的单（${message(e)}）。`] };
  }
  const closedNote = ms.state === 'closed' ? '（这个里程碑已经关了）' : '';
  if (items.length === 0) {
    return { code: 0, lines: [`「${ms.title}」里没有开着的 issue 和 PR，可以关${closedNote}。`] };
  }
  const sorted = [...items].sort((a, b) => a.number - b.number);
  const issues = sorted.filter((i) => !i.isPr).length;
  const prs = sorted.length - issues;
  return {
    code: 1,
    lines: [
      `「${ms.title}」里还有 ${sorted.length} 张开着（issue ${issues} 张、PR ${prs} 个）${closedNote}，没处置完不许关。每张要么做完关掉，要么挪到后面的里程碑并在单上写明原因：`,
      ...sorted.map(
        (i) =>
          `  #${i.number}  ${i.isPr ? 'PR   ' : 'issue'}  ${i.labels.length ? `[${i.labels.join(',')}] ` : ''}${i.title}`,
      ),
    ],
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
