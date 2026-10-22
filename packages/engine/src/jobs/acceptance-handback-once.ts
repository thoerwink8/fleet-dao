// 一次性迁移（#3630，决定 0113 第二片）：库里还开着的旧验收责任（acceptance_duties，#3591 起不再写新行）交回原单。
// 对每条还开着的：在原单上留一条说明（哪个 PR、哪个头、哪几条原验收项）→ 给单贴「本机做」→ 把这一行标成已交回
// （settled_* 三列写「handback:#3630」和留言链接，不删行、不改别的列）。三步按这个顺序，前一步没成就不做后一步，
// 下次重跑接着做：留言按 key 幂等（同一条责任只留一次），贴标签幂等，已经交回的行不再列出，所以不会重复留言。
// 默认只读（列出会交回哪些）；--apply 才写。退出码：0 做完了（或只读列完）；1 有没做成的（逐条写原因）；2 参数不对，不连库。

import type { AcceptanceDutyRow } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';

export const ACCEPTANCE_HANDBACK_ONCE_USAGE =
  '用法：fleet-api acceptance-handback-once [--apply]（一次性把还开着的旧验收责任交回原单：默认只读，列出会交回哪些；加 --apply 才在原单留言、贴「本机做」、把行标成已交回。可重复跑，已交回的不再留言）';

export const HANDBACK_BY = 'handback:#3630';

export type HandbackDuty = Pick<
  AcceptanceDutyRow,
  'id' | 'generation' | 'repo' | 'issueNumber' | 'prNumber' | 'head' | 'items'
>;

export interface AcceptanceHandbackDeps {
  /** db 的 listOpenAcceptanceDuties。读不成照抛：一行都不动。 */
  openDuties(): Promise<HandbackDuty[]>;
  /** 在原单留言（幂等，按 key 认）。 */
  comment(input: { repo: string; issueNumber: number; key: string; body: string }): Promise<{ url: string }>;
  /** 给原单贴「本机做」（幂等）。 */
  label(input: { repo: string; issueNumber: number }): Promise<void>;
  /** db 的 handBackAcceptanceDuty。 */
  markHandedBack(
    input: { id: number; generation: number; by: string; evidence: string },
    at: Date,
  ): Promise<'handed_back' | 'already'>;
  now(): Date;
  out(line: string): void;
  err(line: string): void;
}

const commentKey = (d: HandbackDuty) => `acceptance-handback:3630:${d.id}`;

const whereOf = (d: HandbackDuty) =>
  d.prNumber === 0 ? '协调验收责任（没有 PR）' : `PR #${d.prNumber}（头 ${d.head}）`;

/** 原单上的那条说明：哪个 PR、哪个头、哪几条原验收项，交给谁、单子怎么关。 */
export function handbackBody(d: HandbackDuty): string {
  return [
    `这张单还挂着一条旧的「验收责任」：${whereOf(d)}，冷验收当时判「不归我验」、转给人验的原验收项：`,
    '',
    ...d.items.map((item) => `- ${item}`),
    '',
    '决定 0113 起这层验收责任账不再维护（#3630），这条一次性交回本机：单子已贴「本机做」，本机或指挥官照上面几条贴证据后照常关单。' +
      `库里那一行（责任 ${d.id}，第 ${d.generation} 代）记成「已交回」，不删。`,
  ].join('\n');
}

export async function runAcceptanceHandbackOnce(
  args: readonly string[],
  deps: AcceptanceHandbackDeps,
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    deps.out(ACCEPTANCE_HANDBACK_ONCE_USAGE);
    return 0;
  }
  const unknown = args.filter((a) => a !== '--apply');
  if (unknown.length > 0) {
    deps.err(`参数不对（${unknown.join(' ')}）。${ACCEPTANCE_HANDBACK_ONCE_USAGE}`);
    return 2;
  }
  const apply = args.includes('--apply');
  let duties: HandbackDuty[];
  try {
    duties = await deps.openDuties();
  } catch (error) {
    deps.err(`还开着的验收责任没读成，一行都没动：${errMessage(error)}`);
    return 1;
  }
  if (duties.length === 0) {
    deps.out('没有还开着的验收责任，没有要交回的。');
    return 0;
  }
  if (!apply) {
    for (const d of duties)
      deps.out(
        `会交回：${d.repo}#${d.issueNumber} 责任 ${d.id}（${whereOf(d)}，${d.items.length} 条原验收项）`,
      );
    deps.out(`共 ${duties.length} 条；只读，没写。加 --apply 才留言、贴标签、标成已交回。`);
    return 0;
  }
  let done = 0;
  const failed: string[] = [];
  for (const d of duties) {
    const ref = `${d.repo}#${d.issueNumber} 责任 ${d.id}`;
    let url: string;
    try {
      ({ url } = await deps.comment({
        repo: d.repo,
        issueNumber: d.issueNumber,
        key: commentKey(d),
        body: handbackBody(d),
      }));
    } catch (error) {
      failed.push(`${ref}：留言没留成，没贴标签、行没改：${errMessage(error)}`);
      continue;
    }
    try {
      await deps.label({ repo: d.repo, issueNumber: d.issueNumber });
    } catch (error) {
      failed.push(`${ref}：留了言（${url}），「本机做」没贴成，行没改：${errMessage(error)}`);
      continue;
    }
    try {
      const outcome = await deps.markHandedBack(
        {
          id: d.id,
          generation: d.generation,
          by: HANDBACK_BY,
          evidence: `交回原单 ${d.repo}#${d.issueNumber}，贴「本机做」（决定 0113 第二片）：${url}`,
        },
        deps.now(),
      );
      done += 1;
      deps.out(`${outcome === 'handed_back' ? '已交回' : '早已结清'}：${ref}（${url}）`);
    } catch (error) {
      failed.push(`${ref}：留了言、贴了「本机做」，行没标成已交回：${errMessage(error)}`);
    }
  }
  for (const why of failed) deps.err(why);
  deps.out(
    `交回 ${done} 条，没做成 ${failed.length} 条${failed.length ? '（重跑接着做，不重复留言）' : ''}。`,
  );
  return failed.length ? 1 : 0;
}
