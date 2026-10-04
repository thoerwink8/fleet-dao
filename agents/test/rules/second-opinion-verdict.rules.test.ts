// 钉住第二意见「挡不挡由脚本判」的规矩（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json）。
// 创始人 2026-10-03 晚拍「1+2+3」的第 2 条（决定记录 0016）：审的人只管现实里会出的事，轮数上限做进脚本。
// 起因 #701：同一个头第一次判「必须改」、第二次判「通过」，每一轮都能想出一种更偏的绕过写法，一个 PR 审了 10 次；
// 「最多 2 轮」只写在文档里、脚本不管（#617 做过按头数数轮，20 分钟后被 #609 带着旧文件整段盖掉，没人发现）。
// 下面钉的是脚本的判法本身（agents/skills/discuss/scripts/second-opinion.mjs 的 parseReview / judgeReview）：改了任何一条就是改规矩。
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Item {
  text: string;
  reality: '现实' | '构造';
  category: '碰安全' | '改数据库' | '其他';
  unlabeled: boolean;
}
interface Claimed {
  pass: boolean;
  blocking: number;
}
interface Judged {
  pass: boolean;
  round: number;
  blocking: Item[];
  deferred: Item[];
  constructed: Item[];
  minor: string[];
  claimed: Claimed | null;
}
type Parsed =
  | { ok: true; mustFix: unknown[]; minor: string[]; claimed: Claimed; body: string }
  | { ok: false; why: string };
interface Lib {
  STRICT_ROUNDS: number;
  ALWAYS_BLOCK: string[];
  labelsOf(text: string): { reality: string | null; category: string | null };
  parseReview(text: string): Parsed;
  judgeReview(parsed: Parsed, round: number | undefined): Judged;
  statusText(j: Judged, afterMerge?: boolean): { state: string; description: string };
  judgementLines(
    j: Judged,
    o?: { afterMerge?: boolean; mergeCommit?: string | null; roundNote?: string },
  ): string[];
  priorRounds(bodies: string[]): number;
  prComment(o: { judged: Judged; head: string; model: string; body: string; afterMerge?: boolean }): string;
  reviewPrompt(
    pr: number,
    info: {
      head: string;
      baseRefName: string;
      title: string;
      body: string;
      files: { path: string }[];
      merged?: boolean;
      mergeCommit?: string | null;
    },
    ui: boolean,
    fast: boolean,
  ): string;
}

const so = (await import(
  pathToFileURL(fileURLToPath(new URL('../../skills/discuss/scripts/second-opinion.mjs', import.meta.url)))
    .href
)) as Lib;

/** 审的人交回的一份：必须改几条、结论怎么写、小毛病几条 */
function review(mustFix: string[], conclusion = `必须改 ${mustFix.length} 条`, minor: string[] = []): string {
  return [
    '## 必须改',
    ...(mustFix.length > 0 ? mustFix.map((l) => `- ${l}`) : ['无']),
    '## 小毛病',
    ...(minor.length > 0 ? minor.map((l) => `- ${l}`) : ['无']),
    `结论：${conclusion}`,
  ].join('\n');
}

function judge(text: string, round?: number): Judged {
  const parsed = so.parseReview(text);
  if (!parsed.ok) throw new Error(parsed.why);
  return so.judgeReview(parsed, round);
}

const REAL_SAFE = '【现实】【碰安全】`a.ts:1` 令牌会打进日志';
const REAL_DB = '【现实】【改数据库】`m.sql:3` DROP 了已有的列';
const REAL_OTHER = '【现实】【其他】`b.ts:9` 读不到配置回了空对象';
const MADE_UP = '【构造】【碰安全】`c.ts:2` 把键名写成带引号的 YAML 就绕过去了';
const BARE = '`d.ts:4` 没带标签的一条';

describe('规矩：第二意见只管现实里会出的事，挡不挡由脚本判（2026-10-03「1+2+3」第 2 条）', () => {
  it('两个标签都认得出：【现实】/【构造】、【碰安全】/【改数据库】/【其他】；方括号、并写、没标都认', () => {
    expect(so.labelsOf(REAL_SAFE)).toEqual({ reality: '现实', category: '碰安全' });
    expect(so.labelsOf(MADE_UP)).toEqual({ reality: '构造', category: '碰安全' });
    expect(so.labelsOf('[现实·改数据库] x')).toEqual({ reality: '现实', category: '改数据库' });
    expect(so.labelsOf('【其他】【构造】x')).toEqual({ reality: '构造', category: '其他' });
    expect(so.labelsOf(BARE)).toEqual({ reality: null, category: null });
    // 两样都标了取更严的
    expect(so.labelsOf('【现实】【构造】【其他】【碰安全】x')).toEqual({
      reality: '现实',
      category: '碰安全',
    });
  });

  it('第 1 轮：【现实】的必须改三类都挡；状态写 failure、写清是哪几条', () => {
    const j = judge(review([REAL_SAFE, REAL_DB, REAL_OTHER]), 1);
    expect(j.pass).toBe(false);
    expect(j.blocking.map((f) => f.category)).toEqual(['碰安全', '改数据库', '其他']);
    expect(j.deferred).toEqual([]);
    const s = so.statusText(j);
    expect(s.state).toBe('failure');
    expect(s.description).toContain('第 1 轮：必须改 3 条');
    expect(s.description).toContain('【现实】【其他】1');
  });

  it('【故意造出的失败】没带标签的必须改：第 1、2 轮照挡（按【现实】【其他】算），第 3 轮起转合并后', () => {
    for (const round of [1, 2]) {
      const j = judge(review([BARE]), round);
      expect(j.pass, `第 ${round} 轮`).toBe(false);
      expect(j.blocking[0]).toMatchObject({ reality: '现实', category: '其他', unlabeled: true });
      expect(so.judgementLines(j).join('\n')).toContain('没带全标签，按【现实】【其他】算');
    }
    const third = judge(review([BARE]), 3);
    expect(third.pass).toBe(true);
    expect(third.deferred).toHaveLength(1);
  });

  it('【构造】的一律不挡：第 1 轮、第 3 轮都算小毛病那一类，评论里写明「构造出来的」', () => {
    for (const round of [1, 3]) {
      const j = judge(review([MADE_UP]), round);
      expect(j.pass, `第 ${round} 轮`).toBe(true);
      expect(j.blocking).toEqual([]);
      expect(j.constructed).toHaveLength(1);
      expect(so.statusText(j)).toEqual({
        state: 'success',
        description: `第二意见通过（第 ${round} 轮；1 条构造的不挡）`,
      });
      expect(so.judgementLines(j).join('\n')).toContain('构造出来的 1 条算小毛病');
    }
  });

  it('第 3 轮起：【现实】【其他】转合并后处理、不挡；【现实】【碰安全】【现实】【改数据库】照挡', () => {
    const other = judge(review([REAL_OTHER]), 3);
    expect(other.pass).toBe(true);
    expect(other.deferred).toHaveLength(1);
    expect(so.statusText(other).description).toBe('第二意见通过（第 3 轮；1 条转合并后处理）');
    expect(so.judgementLines(other).join('\n')).toContain('转合并后处理 1 条');
    expect(judge(review([REAL_SAFE]), 3).pass).toBe(false);
    expect(judge(review([REAL_DB]), 3).pass).toBe(false);
    // 第 7 轮也一样：没有「再审几轮就放行」这回事
    expect(judge(review([REAL_SAFE]), 7).pass).toBe(false);
    // 混着：只有碰安全的那条挡，其他的那条转合并后
    const mixed = judge(review([REAL_OTHER, REAL_SAFE]), 3);
    expect(mixed.pass).toBe(false);
    expect(mixed.blocking.map((f) => f.category)).toEqual(['碰安全']);
    expect(mixed.deferred.map((f) => f.category)).toEqual(['其他']);
  });

  it('第 2 轮还是严的：三类都挡；轮数认不出按第 1 轮算', () => {
    expect(judge(review([REAL_OTHER]), 2).pass).toBe(false);
    expect(judge(review([REAL_OTHER]), undefined).round).toBe(1);
    expect(judge(review([REAL_OTHER]), Number.NaN).pass).toBe(false);
    expect(so.STRICT_ROUNDS).toBe(2);
    expect(so.ALWAYS_BLOCK).toEqual(['碰安全', '改数据库']);
  });

  it('【故意造出的失败】审的人结论写「通过」却列了【现实】必须改：脚本照样判 failure，评论里点出来', () => {
    const j = judge(review([REAL_OTHER], '通过'), 1);
    expect(j.pass).toBe(false);
    expect(j.claimed).toEqual({ pass: true, blocking: 0 });
    expect(so.statusText(j).state).toBe('failure');
    expect(so.judgementLines(j).join('\n')).toContain(
      '审的人结论写「通过」，但「必须改」里有 1 条要挡的：照样挡',
    );
  });

  it('审的人结论写「必须改」、按规矩一条都不挡（第 3 轮全是其他）：通过，评论里写明', () => {
    const j = judge(review([REAL_OTHER], '必须改 1 条'), 3);
    expect(j.pass).toBe(true);
    expect(so.judgementLines(j).join('\n')).toContain(
      '审的人结论写「必须改 1 条」，按上面的规矩一条都不挡：通过',
    );
  });

  it('【故意造出的失败】结果格式认不出：没有「必须改」段、最后一行不是结论、结论说必须改却一条读不出——都不出判定', () => {
    const noSection = so.parseReview('看起来没问题。\n结论：通过');
    expect(noSection.ok).toBe(false);
    if (!noSection.ok) expect(noSection.why).toContain('没有「## 必须改」这一段');
    const unfinished = so.parseReview('## 必须改\n- 【现实】【其他】x\n还在写');
    expect(unfinished.ok).toBe(false);
    if (!unfinished.ok) expect(unfinished.why).toContain('最后一行不是');
    const empty = so.parseReview('## 必须改\n无\n结论：必须改 2 条');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.why).toContain('一条也读不出');
    expect(so.parseReview('').ok).toBe(false);
  });

  it('「必须改」写「无」、写了小毛病：通过，小毛病不挡', () => {
    const j = judge(review([], '通过', ['`e.ts:1` 变量名拼错']), 1);
    expect(j.pass).toBe(true);
    expect(j.minor).toEqual(['`e.ts:1` 变量名拼错']);
    expect(so.statusText(j)).toEqual({ state: 'success', description: '第二意见通过（第 1 轮）' });
  });

  it('一条写了好几行、标签在第二行；题面里抄的输出格式在前、真答案在后：都按真答案算', () => {
    const multi = [
      '## 必须改',
      '- `a.ts:1` 问题',
      '  【现实】【碰安全】说明在这一行',
      '结论：必须改 1 条',
    ].join('\n');
    expect(judge(multi, 1).blocking[0]).toMatchObject({
      reality: '现实',
      category: '碰安全',
      unlabeled: false,
    });
    const echoed = [
      '题面要求的格式：',
      '## 必须改',
      '- 【现实】【碰安全】`文件:行` 问题',
      '',
      '我的答案：',
      review([MADE_UP]),
    ].join('\n');
    const j = judge(echoed, 1);
    expect(j.pass).toBe(true);
    expect(j.constructed).toHaveLength(1);
  });

  it('轮数：数脚本贴过的结论评论（第二意见、合并后补审都算，老格式也认），不管头变没变；别的评论不算', () => {
    const parsed = so.parseReview(review([REAL_OTHER]));
    if (!parsed.ok) throw new Error(parsed.why);
    const posted = (head: string) =>
      so.prComment({ judged: so.judgeReview(parsed, 1), head, model: 'gpt-6-luna', body: parsed.body });
    expect(so.priorRounds([])).toBe(0);
    expect(so.priorRounds([posted('aaaaaaa1'), posted('aaaaaaa1'), posted('bbbbbbb2'), '别的评论'])).toBe(3);
    expect(
      so.priorRounds([
        '**第二意见 第 1 轮**（gpt-6-luna，经 Mirasim；审的头 b9bb7ad）：必须改 1 条\n\n## 必须改',
        '**合并后补审 第 1 轮**（m；审的头 abcdef1）：通过',
        '**合并后补审：已处理**——补审没过的问题由 #9 处理。',
      ]),
    ).toBe(2);
    // 评论第一行就是 priorRounds 认的那种格式（改了 prComment 的第一行，轮数就数不出来了）
    expect(posted('abcdef1234')).toMatch(
      /^\*\*第二意见 第 1 轮\*\*（gpt-6-luna；审的头 abcdef1）：必须改 1 条\n/,
    );
  });

  it('题面：要审的人给每条必须改标两个标签，构造出来的不报必须改', () => {
    const prompt = so.reviewPrompt(
      5,
      { head: 'abc', baseRefName: 'main', title: 't', body: '', files: [] },
      false,
      true,
    );
    for (const word of ['【现实】', '【构造】', '【碰安全】', '【改数据库】', '【其他】'])
      expect(prompt).toContain(word);
    expect(prompt).toContain('不要为「要人故意构造才出现」的情况报必须改');
    expect(prompt).toContain('结论：必须改 N 条');
  });

  it('合并后补审没过：状态和评论都写明开修复 PR 或 revert 合并提交', () => {
    const j = judge(review([REAL_SAFE]), 1);
    expect(so.statusText(j, true)).toEqual({
      state: 'failure',
      description: '合并后补审没过第 1 轮：必须改 1 条，开修复 PR 或 revert（【现实】【碰安全】1）',
    });
    const lines = so.judgementLines(j, { afterMerge: true, mergeCommit: 'ad8f8d1aa063' }).join('\n');
    expect(lines).toContain('合并后补审没过');
    expect(lines).toContain('git revert ad8f8d1');
    expect(lines).toContain('--after-merge-resolve');
  });
});
