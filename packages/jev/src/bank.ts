// 题库留三道：错误分流、停滞预判、issue 归类。引擎现在只问 issue 归类；前两道留给 jev 自己的测试和样题，引擎不再登记、不再问。
// 别的接入点没人调，题就不留（见 docs/design.md 第十一节）。
// 选项的效果只许收紧（见 effects.ts）。每道题至少一个 none 选项；拿不准、没判出来、只记不拦时一律当它不存在，照 whenUnsure 走。
import { DEFAULT_CONFIDENCE_LINE } from './policy.ts';
import { defineQuestion, type QuestionDef } from './questions.ts';

export const ERROR_NEXT = defineQuestion({
  id: 'error-next',
  site: 'error-route',
  title: '认不出的报错怎么办',
  instructions: '这一步出错了，规则认不出这条报错。只看报错原文本身，下一步该怎么办？',
  options: [
    {
      id: 'retry',
      label: '重试',
      criteria: '暂时性的：网络抖动、超时、上游 5xx 或过载、资源一时被占，原样再来一次可能就好',
      effect: 'none',
      does: '照兜底梯先有界重试',
    },
    {
      id: 'swap_route',
      label: '换路由',
      criteria: '这条线路的问题：限流、额度用完、账号或登录失效、渠道连不上，换一条路由再试',
      effect: 'reroute',
      does: '只给这个任务换一条路由；不停账号池（停池要有额度读数佐证）',
    },
    {
      id: 'swap_model',
      label: '换模型',
      criteria: '这个模型的问题：模型不存在或已下架、不支持要用的能力、输出格式一直不对，换一个模型',
      effect: 'reroute',
      does: '给这个任务换一个模型',
    },
    {
      id: 'park',
      label: '挂起',
      criteria: '重试、换路都没用：配置缺失、权限不够、代码或测试本身有错、要人来决定',
      effect: 'stop',
      does: '挂起并报警，交帅位诊断',
    },
  ],
  evidence: [
    { key: 'step', label: '出错的步骤', required: true },
    { key: 'code', label: '错误码', required: false },
    { key: 'message', label: '报错原文', required: true },
  ],
  whenUnsure: '按兜底梯：有界重试 → 换路由 → 换模型 → 挂起并报警',
  confidenceLine: DEFAULT_CONFIDENCE_LINE,
  askWhen: '结构化错误码和已知文本都认不出时才问',
});

export const STALL_STATE = defineQuestion({
  id: 'stall-state',
  site: 'stall-check',
  title: '没动静的会话在干嘛',
  instructions: '这个会话有一阵子没有新动静了。看它最近的过程记录，它现在是什么状态？',
  options: [
    {
      id: 'waiting',
      label: '在等',
      criteria: '有东西在跑或在等回音：长测试或构建还没跑完、在等提问的回答、在等外部服务，等下去会有结果',
      effect: 'none',
      does: '照「沉默就催」先提醒',
    },
    {
      id: 'looping',
      label: '在绕圈',
      criteria: '同一个命令、同一处改动反复失败又重来，一直没有进展',
      effect: 'stop',
      does: '停下这个会话，带进度摘要重开，或交帅位',
    },
    {
      id: 'dead',
      label: '已经停了',
      criteria: '最后一步之后没有任何在跑的东西，也没在等回答；进程挂住了或卡在一个不会来的输入上',
      effect: 'stop',
      does: '收掉会话重开',
    },
  ],
  evidence: [
    { key: 'task', label: '会话在做什么', required: true },
    { key: 'recent', label: '最近的过程记录（按时间顺序）', required: true },
    { key: 'plan', label: '会话的步骤清单', required: false },
  ],
  whenUnsure: '照「沉默就催」：先提醒会话，再没动静标停滞交帅位',
  confidenceLine: DEFAULT_CONFIDENCE_LINE,
  askWhen: '代码算出会话沉默超过阈值之后才问（沉默多久由代码算，不交给它）',
});

/**
 * 单子进门自动打标（#448）：新开的 GitHub issue 没有类别标签，问 Jev 是哪一类，只贴不摘（人摘掉就不再碰，
 * 判法在 @fleet-dao/conventions 的 issue-groom.ts）。三个选项和 `packages/conventions` 的 KIND_LABELS 一一对应
 * （需求→feature、缺陷→bug、杂项→chore）；改了名字两边要一起改（issue-groom.ts 不重复这份判据）。
 * 「缺陷」标 flag：多一句日报里能挑出来看（新开的缺陷值得多看一眼），其余不改流程；三个选项目前都不接「拦」，
 * 效果字段只是记着以后转真拦时该怎么走，调用方现在只看 option 和 confidence，不看 act。
 */
export const ISSUE_KIND = defineQuestion({
  id: 'issue-kind',
  site: 'issue-kind',
  title: '这张 issue 是哪一类',
  instructions: '这张 GitHub issue 属于哪一类？',
  options: [
    {
      id: 'feature',
      label: '需求',
      criteria: '要新做的东西，或者给现有的东西加能力、改流程',
      effect: 'none',
      does: '贴「需求」标签',
    },
    {
      id: 'bug',
      label: '缺陷',
      criteria: '现有的东西不对、坏了、和预期不符，要修',
      effect: 'flag',
      does: '贴「缺陷」标签，日报里也提一句',
    },
    {
      id: 'chore',
      label: '杂项',
      criteria: '文档、整理、依赖升级、删减机制这类不改变外部行为的维护性工作',
      effect: 'none',
      does: '贴「杂项」标签',
    },
  ],
  evidence: [{ key: 'issue', label: 'issue 原文（标题、正文）', required: true }],
  whenUnsure: '不贴类别标签，留给人手动贴，记进日报',
  confidenceLine: DEFAULT_CONFIDENCE_LINE,
  askWhen: '新开（或重新打开）的 issue 没有类别标签，且类别标签没被人摘过时才问；每小时补扫一遍漏的',
});

/** 全部题目，引擎起来时登记进库。 */
export const BANK = [ERROR_NEXT, STALL_STATE, ISSUE_KIND] as const satisfies readonly QuestionDef[];

export type BankQuestion = (typeof BANK)[number];
export type QuestionId = BankQuestion['id'];
