// 「怎么算做完」里要 diff 外证据的条目（决定 0093）：冷验收只看 diff、测试输出和单子，看不到截图、线上、现场、审计结果、
// 日志、飞书收到没有。这种验收条引擎永远验不过，白跑一轮再被拒（冷验收拒单抽样 15 条里 5 条是这一类）。
// 判据只有这一份，三处共用：`pnpm issue:new` 和驾驶舱开单（checkIssueBody：交给引擎的单拒开、本机做的单只提示）、
// 引擎拉单（jobs/intake.ts：不拉、在单上留一句为什么）。
//
// 怎么判（宁可漏，不往错里拦）：
// - 硬词：一出现就是 diff 外证据（截图、录屏、飞书收到、现场、人工确认、创始人确认……）。
// - 诊断型（#3591）：要核实原场景卡在哪、定位某次超时的真实阶段——证据在那一次 CI 运行里，写了测试锚点也拦。
// - 软词：线上、生产、法国机器上、真机、去看日志、上线后、部署后、监控上……同一条里写了测试锚点（测试、单测、断言、
//   用例、test、vitest、playwright、e2e、diff）就算看得见（「单测断言日志里打出 X」是测试输出），不拦。
// - 不算：手机上、看板上（界面描述，diff 里有样式和组件）；光写「审计」（审计某段代码、某份清单本身就是改动，
//   只有「审计结果/报告/通过」才是外证据，#3374 就是被这个词误挡的）；
//   「保留现场」「现场凭据」「现场交还」「现场顺序」「现场状态/记录/数据/快照/工作树」「破坏现场」（代码保存、交还状态的行为，#3343、#3247 被它误挡；「现场验收/证据/核验」仍拦）；「只记日志」「写日志」（代码行为）；「飞书网关收到消息后…」（描述代码）。
//   钉在 test/off-diff-acceptance.test.ts，拿真单子里的写法校过（本仓近 300 张单）。
import { createHash } from 'node:crypto';
import { LOCAL_LABEL } from './labels.ts';

/** 一条命中的验收条：原文和认出的词。 */
export interface OffDiffItem {
  item: string;
  words: string[];
}

/** 一出现就要 diff 外证据的写法。 */
const HARD: readonly RegExp[] = [
  /截图|截屏|录屏|录像|屏幕快照|screenshot/i,
  /飞书(?:上|里|群里)?(?:收到|看到|弹出)|(?:收到|看到)[^\n。；;]{0,8}飞书(?:消息|通知|报警|推送|卡片)/,
  /(?<!保留|保全|保护|还原|清理|恢复|丢失|破坏|污染|留在|留下)现场(?!保留|保全|保护|凭据|交还|顺序|清理|状态|记录|数据|文件|目录|快照|恢复|还原|工作树|上下文|原样|不动)/,
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

/**
 * 诊断型（#3591）：要的是「原场景当时卡在哪」——那一次 CI 运行里的阶段、等待、根因，不在 diff 里，测试输出也只有这一次的。
 * 写了「diff 与测试输出能核实」也照拦（#3414、#3450、#3413 在冷验收里反复被拒，理由都是核实不了原场景卡在哪）。
 * 只认「核实/定位/明确……原场景/原用例/首次失败/首红……卡在/等待/阶段/原因」这一串、「定位……的真实阶段/原因」、
 * 「完整 CI 的 N 秒超时」；光写「卡在哪一步」（界面显示）、「保留原失败原因」（代码行为）不算。
 */
const DIAGNOSTIC: readonly RegExp[] = [
  /(?:核实|定位|查明|查清|弄清|明确|确认)[^\n。；;]{0,12}(?:原场景|原用例|首次失败|首红)[^\n。；;]{0,16}?(?:卡在|等待|阶段|原因)/,
  /定位[^\n。；;]{0,30}(?:真实|实际)(?:阶段|原因|根因)/,
  /完整\s*CI[^\n。；;]{0,24}\d+\s*(?:秒|毫秒|ms|s)[^\n。；;]{0,4}超时/i,
];

/**
 * 诊断型单的标题（#3597，验收条部分是上面的 DIAGNOSTIC，#3595）：「定位……在完整 CI 的原 N 秒超时」一类——要的是某一次 CI 运行里
 * 实际卡在哪，证据在那次运行的日志里，引擎的冷验收看不到，派给引擎只会白跑几轮再被拒。这种单判成本机做，不派引擎。
 * 只认以「定位 / 查明 / 查清 / 弄清 / 核实」开头、后面带「原 N 秒超时」或「在完整 CI 的 N 秒超时」的标题（N 可以是汉字数字）；
 * 「修复……超时」「把……改成在限定时间内跑完」这类是改代码的单，不算。真标题钉在 test/off-diff-acceptance.test.ts（#3413、#3414、#3450）。
 */
const DIAGNOSTIC_TITLE =
  /^\s*(?:定位|查明|查清|弄清|核实)[^\n]{0,80}?(?:原|在完整\s*CI[^\n]{0,8}?)[0-9零一二三四五六七八九十百千]+\s*(?:秒|毫秒|ms|s)\s*超时/i;

export function isDiagnosticTitle(title: string): boolean {
  return DIAGNOSTIC_TITLE.test(title);
}

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

/**
 * 收尾验收条（#3629）：「检查全绿」「CI 全绿」「PR 合进主线」「合并」。这类条由合并闸自己证明——PR 能合进主线，
 * 就说明必过检查全绿了——冷验收不核、不转人，合并后关单视为已满足（#3594：PR 早已合入、检查全 success，
 * 冷验收却把这条当「要完整 CI 全绿及平台现场证据」转人，单子留着不关，还有会话为 deploy job 反复取证）。
 * 只认整条都由这几种说法组成（以逗号、顿号、分号、句号、「和」「并且」「以及」切开，每段都得是）；
 * 同一条里夹了别的要求（「完整 CI 通过，不改 3249 的预算」）不算，照常判。
 */
const MERGE_GATE_PARTS: readonly RegExp[] = [
  /^(?:所有|全部|必过|全套)?(?:完整)?(?:检查|ci|check|pnpmcheck|必过检查)(?:都|全部)?(?:全绿|全部通过|通过|变绿|绿了?)$/i,
  /^(?:本)?pr(?:#?\d+)?(?:已|可以|能)?(?:合进|合入|合并进|合并入|合并到|合到|并入|合并)(?:到|进|入)?(?:主线|main|master)?$/i,
  /^(?:已)?合并(?:进|入|到)?(?:主线|main|master)?$/i,
  /^合并闸(?:通过|放行)?$/,
];

export function isMergeGateItem(item: string): boolean {
  const flat = item.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/[\s`*_]/g, '');
  const parts = flat
    .split(/[，,、；;。.]|并且|以及|和/)
    .map((x) => x.trim())
    .filter((x) => x !== '');
  return parts.length > 0 && parts.every((part) => MERGE_GATE_PARTS.some((re) => re.test(part)));
}

/** 一条验收条里认出的 diff 外证据的词；没有回空数组。收尾条（isMergeGateItem）交合并闸，不算。 */
export function offDiffWords(item: string): string[] {
  if (isMergeGateItem(item)) return [];
  const words: string[] = [];
  for (const re of [...HARD, ...DIAGNOSTIC]) {
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
  '冷验收只看 diff、测试输出和单子，看不到截图、线上、现场、审计结果、日志、读库、读回、评论、恢复连接、健康检查读回、飞书收到没有、原场景当时卡在哪：改成 diff 或测试输出里看得见的写法' +
  '（哪个测试文件里哪条用例断言了什么、哪个文件里改成了什么、命令跑出什么）；要人去现场看的，单子留给本机做。';

/** 已经在跑的单被续上（人工继续、task.redo、commander.redo）的三个入口。 */
export type OffDiffHoldAction = 'continue' | 'task.redo' | 'commander.redo';

const HOLD_ACTION_WORDS: Record<OffDiffHoldAction, string> = {
  continue: '人工继续',
  'task.redo': 'task.redo 重做',
  'commander.redo': '指挥官重做',
};

/** 续单前的判决：命中了就不再续，改交回本机。 */
export interface OffDiffHold {
  hits: OffDiffItem[];
  /** 一句话原因（拒绝信息、操作记录、日志）。 */
  why: string;
  /** 留在单上的话。 */
  comment: string;
  /** 留言的幂等键：同样的命中条目同一个键。 */
  key: string;
}

/**
 * 已经在跑的单被续上之前先过一遍判据（#3602）：#3595 只在拉单时挡诊断型 / diff 外验收条，在跑的单被人工「继续」、task.redo、
 * commander.redo 照样续上空转（10-20～10-22 诊断单第一轮 0/25 做成）。命中就不续，调用方改贴「本机做」并留这句 comment。
 * 入参是一条一条的验收条（api 用 criteriaOf(rawRequest).ok，引擎同）；没命中回 null，普通单不受影响。
 */
export function offDiffHoldOf(items: readonly string[], action: OffDiffHoldAction): OffDiffHold | null {
  const hits = offDiffItems(items);
  if (hits.length === 0) return null;
  const words = hits.flatMap((h) => h.words);
  const digest = createHash('sha256').update(describeOffDiff(hits)).digest('hex').slice(0, 12);
  return {
    hits,
    why: `「怎么算做完」要 diff 外证据（${words.join('、')}），${HOLD_ACTION_WORDS[action]}只会再空转一轮：不续，已交回本机做`,
    comment: [
      `${HOLD_ACTION_WORDS[action]}被拦下了：这张单的「怎么算做完」里有条目要 diff 外的证据，引擎做不出来，冷验收也验不过，续上只会再空转一轮（命中的是哪一条见下方）：`,
      '',
      describeOffDiff(hits),
      '',
      OFF_DIFF_REWRITE,
      '',
      `已贴「${LOCAL_LABEL}」交回本机做；改成 diff 里看得见的写法后，摘掉「${LOCAL_LABEL}」才会重新被引擎拉。`,
    ].join('\n'),
    key: `off-diff-hold:${action}:${digest}`,
  };
}
