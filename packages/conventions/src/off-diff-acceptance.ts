// 「怎么算做完」里要 diff 外证据的条目（决定 0093）：冷验收只看 diff、测试输出和单子，看不到截图、线上、现场、审计结果、
// 日志、飞书收到没有。这种验收条引擎永远验不过，白跑一轮再被拒（冷验收拒单抽样 15 条里 5 条是这一类）。
// 判据只有这一份，三处共用：`pnpm issue:new` 和驾驶舱开单（checkIssueBody：交给引擎的单拒开、本机做的单只提示）、
// 引擎拉单（jobs/intake.ts：不拉、在单上留一句为什么）。
//
// 怎么判（宁可漏，不往错里拦）：
// - 硬词：一出现就是 diff 外证据（截图、录屏、飞书收到、现场、人工确认、创始人确认……）。
// - 软词：线上、生产、法国机器上、真机、去看日志、上线后、部署后、监控上……同一条里写了测试锚点（测试、单测、断言、
//   用例、test、vitest、playwright、e2e、diff）就算看得见（「单测断言日志里打出 X」是测试输出），不拦。
// - 不算：手机上、看板上（界面描述，diff 里有样式和组件）；光写「审计」（审计某段代码、某份清单本身就是改动，
//   只有「审计结果/报告/通过」才是外证据，#3374 就是被这个词误挡的）；「只记日志」「写日志」（代码行为）；「飞书网关收到消息后…」（描述代码）。
//   钉在 test/off-diff-acceptance.test.ts，拿真单子里的写法校过（本仓近 300 张单）。

/** 一条命中的验收条：原文和认出的词。 */
export interface OffDiffItem {
  item: string;
  words: string[];
}

/** 一出现就要 diff 外证据的写法。 */
const HARD: readonly RegExp[] = [
  /截图|截屏|录屏|录像|屏幕快照|screenshot/i,
  /飞书(?:上|里|群里)?(?:收到|看到|弹出)|(?:收到|看到)[^\n。；;]{0,8}飞书(?:消息|通知|报警|推送|卡片)/,
  /现场/,
  /人工(?:确认|核对|验证|验收|检查|点验)|肉眼|手工(?:点|确认|验证)/,
  /创始人[^\n。；;]{0,6}(?:确认|看过|验收)/,
  /审计(?:结果|报告|通过)/,
  /(?:读|读取|查询|查看|核对|对照|翻)[^\n。；;]{0,12}(?:数据库|生产库|线上库|法国库|库里|库中|DB)/i,
  /(?:在|从)[^\n。；;]{0,8}(?:数据库|生产库|线上库|法国库|库里|库中|DB)[^\n。；;]{0,8}(?:读|读取|查询|查看|核对|对照|翻)/i,
  /(?:读回|回读|读取回|读出来|读到)[^\n。；;]{0,20}(?:结果|状态|响应|数据|结论|值|内容|healthz|健康检查)/i,
  /(?:贴|写|留|发)[^\n。；;]{0,10}(?:评论|评论区|本单评论)|评论(?:区|里|中)[^\n。；;]{0,10}(?:贴|写|留|发)/,
  /(?:在|到|回)?本单[^\n。；;]{0,8}(?:注明|写明|留言|贴)/,
  /(?:恢复|重新建立|重连|重新连接|连回)[^\n。；;]{0,12}(?:SSH|连接|链路|会话)/i,
  /(?:healthz|健康检查|健康探针|健康状态)[^\n。；;]{0,24}(?:读回|返回|回到|变为|显示|不再|通过|为)/i,
  /(?:读回|回读|读取)[^\n。；;]{0,20}(?:healthz|健康检查|健康探针|健康状态)/i,
];

/** 本身多半要 diff 外证据、但同一条写了测试锚点就算看得见的写法。 */
const SOFT: readonly RegExp[] = [
  /线上|现网|生产环境|正式环境/,
  /法国(?:机器|服务器|VPS|那台|上)/i,
  /真机/,
  /(?:看|查|翻|贴|附|对照)[^\n。；;]{0,6}日志|日志(?:里|中|上)?(?:看到|看得到|显示|证明|为证)|证据是日志/,
  /(?:^|[（(、，,；;])日志(?:[、，,；;)）]|$)/,
  /(?:上线|部署|发版|发布)(?:后|之后|以后)/,
  /监控(?:上|里|面板)/,
];

/** 同一条里有这些就是测试输出或 diff 能看见的（软词不拦）。 */
const TEST_ANCHOR = /测试|单测|断言|用例|\btest\b|\.test\.|\.spec\.|vitest|playwright|e2e|diff/i;

/** 验收条：列表项各成一条；非列表的连续非空行合成一段；空行切开。 */
export function splitAcceptanceItems(text: string): string[] {
  const items: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const t = current.join('\n').trim();
    if (t) items.push(t);
    current = [];
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(raw)) {
      flush();
      current.push(raw.trim());
    } else if (raw.trim() === '') {
      flush();
    } else {
      current.push(raw.trim());
    }
  }
  flush();
  return items;
}

/** 一条验收条里认出的 diff 外证据的词；没有回空数组。 */
export function offDiffWords(item: string): string[] {
  const words: string[] = [];
  for (const re of HARD) {
    const m = re.exec(item);
    if (m) words.push(m[0]);
  }
  if (!TEST_ANCHOR.test(item)) {
    for (const re of SOFT) {
      const m = re.exec(item);
      if (m) words.push(m[0]);
    }
  }
  return words;
}

/** 逐条判：入参是一条一条的验收条（引擎交代里的 acceptance），回命中的那几条。 */
export function offDiffItems(items: readonly string[]): OffDiffItem[] {
  return items
    .map((item) => ({ item: item.trim(), words: offDiffWords(item) }))
    .filter((x) => x.item && x.words.length > 0);
}

/** 「怎么算做完」一节的原文（不含标题）→ 命中的条目。 */
export function offDiffAcceptanceItems(doneSectionBody: string): OffDiffItem[] {
  return offDiffItems(splitAcceptanceItems(doneSectionBody));
}

/** 命中的条目说成几行（开单拒绝、引擎留言共用）。 */
export function describeOffDiff(hits: readonly OffDiffItem[]): string {
  return hits
    .map((h) => `- ${h.item.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')}（认出：${h.words.join('、')}）`)
    .join('\n');
}

/** 怎么改写（开单拒绝、引擎留言共用）。 */
export const OFF_DIFF_REWRITE =
  '冷验收只看 diff、测试输出和单子，看不到截图、线上、现场、审计结果、日志、读库、读回、评论、恢复连接、健康检查读回、飞书收到没有：改成 diff 或测试输出里看得见的写法' +
  '（哪个测试文件里哪条用例断言了什么、哪个文件里改成了什么、命令跑出什么）；要人去现场看的，单子留给本机做。';
