// brief-drafter：模型把需求写成任务书草稿，判分用 agents/skills/commander/scripts/check-brief.mjs（带 --quote 核对原话原样保留）。

import { join } from 'node:path';
import { fileExists, readText, runCheckBrief } from '../grade-util.ts';
import type { EvalCase, GradeContext, Verdict } from '../types.ts';

const DRAFT = '_tmp/briefs/draft.md';

const PREAMBLE =
  '这是能力演练题，不是真任务：不开单、不开 PR。需求在当前目录的 `scenario.md` 里。把它写成任务书草稿，写到 `_tmp/briefs/draft.md`，别处不写。\n' +
  '本目录里没有 check-brief.mjs，也没有那些源文件，路径照 `scenario.md` 里给的写，不要去核实。\n\n';

const RULES =
  '任务书的硬规矩：\n' +
  '1. 四节齐，标题固定：`## 场景`、`## 原话`、`## 已知的模块`、`## 怎么算做完`。\n' +
  '2. 「原话」一节原样照抄创始人的话，一个字不改。\n' +
  '3. 「已知的模块」每行是 `- ` 加一个反引号括起来的路径，反引号外不写别的；同一张单的路径限在同一个模块里（`packages/<包名>` 算一个模块），不跨模块；不超过 50 个。\n' +
  '4. 正文任何地方不提 `agents/`、`.github/workflows/`。「怎么算做完」写成 diff 里看得见的条目（改了哪个文件的什么行为、加了哪条测试），' +
  '这一节里不出现「grep」「CI 绿」「截图」这几个词。\n' +
  '5. 范围写死，一个 PR 做得完；这一单只做 `scenario.md` 里说明的那一部分。\n\n' +
  '做完后在最终回答里写一行：草稿路径。';

function gradeDraft(quote: string) {
  return async (ctx: GradeContext): Promise<Verdict> => {
    if (!fileExists(ctx.workDir, DRAFT)) return { pass: false, reason: `没有写出 ${DRAFT}` };
    readText(ctx.workDir, DRAFT);
    const r = runCheckBrief(join(ctx.workDir, DRAFT), quote);
    const last = r.output.split('\n').filter(Boolean).slice(-4).join(' | ');
    return r.pass
      ? { pass: true, reason: `check-brief 是 PASS：${last}` }
      : { pass: false, reason: `check-brief 判 FAIL：${last}` };
  };
}

const BADGE_QUOTE =
  '驾驶舱项目页上，没连上的项目现在是一片空白，我看不出是没连上还是没数据。没连上的显示一个灰色的「未连接」徽章。';
const SPLIT_QUOTE = '任务列表接口要能按状态筛选，筛完要有截图给我看。';

export const BRIEF_CASES: EvalCase[] = [
  {
    id: 'brief-drafter/project-badge',
    scenario: 'brief-drafter',
    name: 'project-badge',
    agent: 'fleet-brief-drafter',
    prompt: `${PREAMBLE}${RULES}`,
    source: { kind: 'fixture' },
    planted:
      '一份单模块（packages/web）的需求，原话要原样保留（含「」引号内的句子）。check-brief.mjs 带 --quote 判：四节齐、路径都在 packages/web、验收条没有 grep、CI 绿、截图。',
    why: '规矩全列在题面里，按条做就过；Haiku 的本职，栽法多半是原话改了字、路径行里带说明文字、或把测试文件写成别的模块。',
    grade: gradeDraft(BADGE_QUOTE),
  },
  {
    id: 'brief-drafter/split-by-module',
    scenario: 'brief-drafter',
    name: 'split-by-module',
    agent: 'fleet-brief-drafter',
    prompt: `${PREAMBLE}${RULES}`,
    source: { kind: 'fixture' },
    planted:
      '需求背景里同时提到 api 和 web 两个模块，但说明只做接口这一半：路径只能列 packages/api 下的；创始人原话里有「截图」二字，原话要照抄，但验收条里不能出现「截图」。',
    why: '两个陷阱：不要把背景里的 web 页面路径也列进来（跨模块）、原话里的「截图」要保留在原话栏而不写进验收条。Haiku 可能顺着创始人的话把截图写进验收条。',
    grade: gradeDraft(SPLIT_QUOTE),
  },
];
