// 验证结论的边界表：交回的认不出、审错了头、漏答多答一律退回并说明原因，不当成过了。
// decideVerdict、verificationLines 和它们的测试 #901 审查时只有测试在用，随 Fusion 的 Lead 验收一起删了。
import { describe, expect, it } from 'vitest';
import { checkReport, criterionKey } from '../src/verdict.ts';

const HEAD = 'abc1234def';
const criteria = ['过期的验证码登录不了', '有一条故意造出失败的测试'];
const allDone = {
  head: HEAD,
  results: criteria.map((criterion) => ({ criterion, answer: 'done', evidence: 'auth.test.ts 第 40 行' })),
  findings: [] as unknown[],
};

describe('交回的这一份本身对不对（会话端口读结论文件时先挡一道）', () => {
  it('对的：原样交回解析好的', () => {
    const got = checkReport(allDone, criteria, HEAD);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.report.results).toHaveLength(2);
  });

  it.each([
    ['认不出', { head: HEAD }, /认不出/],
    ['审的不是送检的头', { ...allDone, head: 'abc1234' }, /不是送检的头/],
    [
      '一条没带证据',
      { ...allDone, results: [{ ...allDone.results[0], evidence: ' ' }, allDone.results[1]] },
      /认不出/,
    ],
    [
      '答了清单外的',
      {
        ...allDone,
        results: [...allDone.results, { criterion: '别的', answer: 'done', evidence: 'x' }],
      },
      /清单外/,
    ],
  ])('【失败】%s', (_name, report, why) => {
    const got = checkReport(report, criteria, HEAD);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.why).toMatch(why);
  });

  it('【失败】没有「怎么算做完」也不算对（不拿空清单放过去）', () => {
    const got = checkReport({ head: HEAD, results: [], findings: [] }, [], HEAD);
    expect(got.ok).toBe(false);
  });
});

describe('「怎么算做完」按规范化后的文字对，对上了往下传清单原文（#246 验收撞上的）', () => {
  // #246 需求文档「怎么算做完」的前两条原文。第二条带反引号，验证模型连着 3 次交回的都去掉了反引号，逐字比判成清单外、整轮重跑
  const PLAIN =
    'store-ports 出一个只读的「这个阶段现在是不是全熔断」判法：和 choose 同一套熔断判定、同一份路由事实；不写库、不报警。';
  const TICKED =
    '`packages/engine/src/jobs/alert-sweep.ts` 加一条规则：这个阶段有不在熔断的候选路由了就撤，正文开头写「已撤：<阶段>有路由不熔断了」，处理人记 `engine:hourly-reconcile`；还全熔断就原样留着；读不了记这一轮没查全，不撤。';
  const C246 = [PLAIN, TICKED];
  /** 模型交回的那份：只差反引号。 */
  const UNTICKED = TICKED.replaceAll('`', '');
  const EVIDENCE = 'alert-sweep.ts 第 30 行';
  const res = (criterion: string, answer = 'done') => ({ criterion, answer, evidence: EVIDENCE });
  const rep = (...results: ReturnType<typeof res>[]) => ({ head: HEAD, results, findings: [] as unknown[] });

  it('#246：只差反引号的认得，往下传的是清单原文，不是模型去掉反引号的那份', () => {
    expect(checkReport(rep(res(PLAIN), res(UNTICKED)), C246, HEAD)).toEqual({
      ok: true,
      report: rep(res(PLAIN), res(TICKED)),
    });
  });

  it('【失败】真不一样的一条照旧判「答了清单外的一条」，报错写的是那一条（只差反引号的那条不算）', () => {
    const other = TICKED.replace('加一条规则', '加两条规则');
    expect(checkReport(rep(res(UNTICKED), res(other)), C246, HEAD)).toEqual({
      ok: false,
      why: `答了清单外的一条：「${other}」（criterion 要照清单原文逐字抄）`,
    });
  });

  it('【失败】规范化后两条撞成同一条 → 判重复，写清是哪条、交回的两种写法', () => {
    expect(checkReport(rep(res(PLAIN), res(TICKED), res(UNTICKED)), C246, HEAD)).toEqual({
      ok: false,
      why: `同一条答了两遍：「${TICKED}」（交回的写法：「${TICKED}」、「${UNTICKED}」）`,
    });
  });

  it('【失败】只差格式的答了、另一条漏了 → 照旧判没答，写清单原文', () => {
    const got = checkReport(rep(res(UNTICKED)), C246, HEAD);
    expect(got).toEqual({ ok: false, why: `没答：「${PLAIN}」` });
  });

  it('【失败】清单里本来就有两条只差格式：逐字抄的各认各的；改了格式、两条都对得上的不替它挑，判作废', () => {
    const twins = ['`a.ts` 加一条规则', 'a.ts 加一条规则'];
    expect(checkReport(rep(res('a.ts 加一条规则'), res('`a.ts` 加一条规则')), twins, HEAD).ok).toBe(true);
    expect(checkReport(rep(res('**a.ts** 加一条规则'), res('a.ts 加一条规则')), twins, HEAD)).toEqual({
      ok: false,
      why: '这一条对得上清单里不止一条：「**a.ts** 加一条规则」（「`a.ts` 加一条规则」、「a.ts 加一条规则」），criterion 要照清单原文逐字抄',
    });
  });
});

describe('criterionKey：只抹不改意思的格式差别', () => {
  const ch = (code: number) => String.fromCharCode(code);
  it.each([
    ['反引号', '`a.ts` 加一条规则', 'a.ts 加一条规则'],
    ['加粗、斜体', '**必须**有一条 *故意* 造出失败的测试', '必须有一条故意造出失败的测试'],
    ['词边上的下划线（斜体）', '_必须_ 有测试', '必须有测试'],
    ['全角括号、冒号、逗号换成半角，后面跟了空格', '字段（`a`，`b`）：`c`', '字段 (a, b): c'],
    ['弯引号、直角引号', '正文开头写「已撤」', '正文开头写“已撤”'],
    ['中英文之间空不空', '处理人记 `engine:hourly-reconcile` 就行', '处理人记engine:hourly-reconcile就行'],
    ['空白和换行', 'a  b\n\tc', 'a b c'],
    ['句末的「。」「；」', '读不了就不撤。', '读不了就不撤；'],
    ['句末的「。」和「.」', '读不了就不撤。', '读不了就不撤.'],
    ['开头抄进来的序号', '2. 读不了就不撤', '读不了就不撤'],
    ['全角字母数字、全角空格', `ＰＲ${ch(0x3000)}正文写档位１`, 'PR 正文写档位1'],
    ['零宽字符', `读不了就不撤${ch(0x200b)}`, '读不了就不撤'],
  ])('认得：%s', (_name, a, b) => {
    expect(criterionKey(a)).toBe(criterionKey(b));
  });

  it.each([
    ['字不一样', '加一条规则', '加两条规则'],
    ['大小写', '`PR` 正文写档位', '`pr` 正文写档位'],
    ['snake_case 中间的下划线', '`wrong_output` 判作废', '`wrongoutput` 判作废'],
    ['「、」和「，」', '撤、留', '撤，留'],
    ['连字符和破折号', '`a-b`', '`a—b`'],
    ['英文词之间的空格', '`ls -la`', '`ls-la`'],
    ['单引号和双引号', "`echo '$HOME'`", '`echo "$HOME"`'],
    ['删除线', '~~不做~~ 旧接口', '不做旧接口'],
    ['句中的「。」和「.」', 'a。b', 'a.b'],
  ])('不收：%s', (_name, a, b) => {
    expect(criterionKey(a)).not.toBe(criterionKey(b));
  });
});
