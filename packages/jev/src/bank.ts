// 题库：设计文档第十一节的九个接入点。分诊要判的四件事各成一题（一道题只问一件事，四题同一次问）；其余每个接入点一题。
// 选项的效果只许收紧（见 effects.ts）。每道题至少一个 none 选项；拿不准、没判出来、只记不拦时一律当它不存在，照 whenUnsure 走。
// 考题（真实样本 + 标准答案）在 packages/jev/exams/<接入点>.json。改题面或选项之后，旧的判断记录不再算进准确率。
import { DEFAULT_CONFIDENCE_LINE } from './policy.ts';
import { defineQuestion, type QuestionDef, type SiteId } from './questions.ts';

const REQUEST = { key: 'request', label: '需求原文（标题、正文、评论）', required: true } as const;

export const TRIAGE_KIND = defineQuestion({
  id: 'triage-kind',
  site: 'triage',
  title: '哪类活',
  instructions: '这条需求要 AI 做的是哪一类活？',
  options: [
    {
      id: 'code',
      label: '写码',
      criteria: '改代码、配置、脚本或文档，AI 在代码仓的工作副本里就能做完',
      effect: 'none',
      does: '照常按写码派',
    },
    {
      id: 'research',
      label: '调研',
      criteria: '要的是调研结论、方案对比或数据分析，产物是一份文档或结论，不要求改仓里的代码',
      effect: 'reroute',
      does: '改派到调研阶段',
    },
    {
      id: 'manual',
      label: '要人亲手做',
      criteria:
        '关键的一步得由人亲手做：登录某个后台点按钮、付款或签约、联系外部的人、在真机或线下操作，AI 在工作副本里做不了',
      effect: 'stop',
      does: '不派 AI，交给提出人，写明哪一步要他亲手做',
    },
  ],
  evidence: [REQUEST],
  whenUnsure: '按写码派；分诊会话或方案里另有判断的，以它们为准',
  confidenceLine: DEFAULT_CONFIDENCE_LINE,
});

export const TRIAGE_UI = defineQuestion({
  id: 'triage-ui',
  site: 'triage',
  title: '改不改界面',
  instructions: '做这条需求要不要改用户看得见的界面？',
  options: [
    {
      id: 'ui',
      label: '要改界面',
      criteria: '要改网页或页面的布局、样式、组件、交互，或者飞书卡片、驾驶舱的显示样子',
      effect: 'reroute',
      does: '按 UI 阶段派（GPT 族不接）',
    },
    {
      id: 'no_ui',
      label: '不改界面',
      criteria: '只改后端、脚本、数据、配置、接口或文档，用户看到的界面不变',
      effect: 'none',
      does: '照方案标的阶段类型派',
    },
  ],
  evidence: [REQUEST],
  whenUnsure: '按方案给子任务标的阶段类型：标了 ui 的才按 UI 派',
  confidenceLine: DEFAULT_CONFIDENCE_LINE,
});

export const TRIAGE_CLARITY = defineQuestion({
  id: 'triage-clarity',
  site: 'triage',
  title: '清不清楚',
  instructions: '如果现在就照这条需求开工，最先会卡在哪？',
  options: [
    {
      id: 'clear',
      label: '说清楚了',
      criteria: '要做什么说清楚了：AI 能照原话写出需求文档，拿不准的小细节可以先按常理假设',
      effect: 'none',
      does: '照常开工',
    },
    {
      id: 'goal',
      label: '要做什么说不清',
      criteria: '目标、范围或要改的对象含糊，按常理也猜不出，不问清楚就可能做成别的东西',
      effect: 'stop',
      does: '先在任务里追问：到底要做的是什么',
    },
    {
      id: 'decision',
      label: '有决定没拍',
      criteria: '有一个只有提出人能拍的决定还没拍：几个方案选哪个、要不要做、能花多少钱，AI 不该替他定',
      effect: 'stop',
      does: '先在任务里追问那个决定',
    },
  ],
  evidence: [REQUEST],
  whenUnsure: '按分诊会话自己的判断：它说清楚就开工；它也没判出来，就按默认理解开工并写明假设',
  confidenceLine: DEFAULT_CONFIDENCE_LINE,
});

export const TRIAGE_GATE = defineQuestion({
  id: 'triage-gate',
  site: 'triage',
  title: '碰不碰人闸',
  instructions: '做完这条需求，会不会要做只有人能点头的事？',
  options: [
    {
      id: 'none',
      label: '都不碰',
      criteria: '只改代码、文档或配置，不对外发布、不花钱、不删数据',
      effect: 'none',
      does: '照常走',
    },
    {
      id: 'release',
      label: '对外发布',
      criteria: '要发版、上线给用户用、对外公开发布或公告',
      effect: 'stop',
      does: '活照常干，合并前停下等人点头',
    },
    {
      id: 'money',
      label: '花钱',
      criteria: '要新买或升级订阅、用按量付费的服务、买域名或机器，会让账单多出一笔',
      effect: 'stop',
      does: '活照常干，花钱那一步之前停下等人点头',
    },
    {
      id: 'delete',
      label: '删数据',
      criteria: '要删掉数据库里的数据、用户数据、备份或历史记录',
      effect: 'stop',
      does: '活照常干，删数据那一步之前停下等人点头',
    },
  ],
  evidence: [REQUEST],
  whenUnsure: '按引擎的人闸：合并前照改动内容判要不要人点头',
  confidenceLine: DEFAULT_CONFIDENCE_LINE,
});

export const DEDUPE_PAIR = defineQuestion({
  id: 'dedupe-pair',
  site: 'dedupe',
  title: '和在途的是不是一件事',
  instructions: '新需求和这条在途需求是什么关系？',
  options: [
    {
      id: 'same',
      label: '同一件事',
      criteria: '要的是同一个结果：做完其中一条，另一条就不用再做了',
      effect: 'stop',
      does: '不另开工，挂到在途那条上，请提出人确认',
    },
    {
      id: 'overlap',
      label: '会撞车',
      criteria: '不是同一件事，但要改同一块地方（同一个页面、模块或文件），同时做会互相冲突',
      effect: 'stop',
      does: '排队，等在途那条做完再开工',
    },
    {
      id: 'separate',
      label: '各做各的',
      criteria: '要的结果不同，改的地方也不同；只是话题相近也算这一类',
      effect: 'none',
      does: '照常开工',
    },
  ],
  evidence: [
    { key: 'new_request', label: '新需求原文', required: true },
    { key: 'existing', label: '在途需求（标题、原文、方案里写的会改哪些地方）', required: true },
  ],
  whenUnsure: '照常开工；撞不撞车由代码按方案里写的改动位置排队',
  confidenceLine: DEFAULT_CONFIDENCE_LINE,
  askWhen: '新需求进来时，对代码先筛出来的每一条同仓在途需求各问一次',
});

// 「怎么算做完」和「怎么做」是两回事（设计第七节：需求写前者，方案写后者）：只写了改法、没说做到什么样算完，算没写。
export const SPEC_DONE = defineQuestion({
  id: 'spec-done',
  site: 'spec-check',
  title: '做完标准能不能核对',
  instructions: '需求文档里写的「怎么算做完」，能不能逐条核对？',
  options: [
    {
      id: 'checkable',
      label: '能核对',
      criteria: '写了做到什么样算完，而且每一条都能用测试、命令或看得见的结果核对真假',
      effect: 'none',
      does: '照常开工',
    },
    {
      id: 'vague',
      label: '有口号',
      criteria:
        '写了做到什么样算完，但有的条目只是感觉或口号（「更好用」「更稳定」「体验流畅」），没法核对真假',
      effect: 'send_back',
      does: '退回写需求文档那一步，重写核对不了的那几条',
    },
    {
      id: 'missing',
      label: '没写',
      criteria: '没写做到什么样算完：只有现象、原因、要做什么或怎么改',
      effect: 'send_back',
      does: '退回写需求文档那一步，补上做完标准',
    },
  ],
  evidence: [
    { key: 'spec', label: '需求文档', required: true },
    { key: 'request', label: '提出人原话', required: false },
  ],
  whenUnsure: '按现有文档开工',
  confidenceLine: DEFAULT_CONFIDENCE_LINE,
});

export const DELIVERY_MET = defineQuestion({
  id: 'delivery-met',
  site: 'delivery-check',
  title: '交活做到了没有',
  instructions: '这次交的活，做到需求文档里的「做完标准」了吗？',
  options: [
    {
      id: 'met',
      label: '做到了',
      criteria: '每一条做完标准都能在改动或测试结果里找到对应',
      effect: 'none',
      does: '照常进验证',
    },
    {
      id: 'partial',
      label: '只做了一部分',
      criteria: '有的做完标准找不到对应的改动或测试',
      effect: 'send_back',
      does: '退回原会话，补齐没做到的那几条',
    },
    {
      id: 'off_target',
      label: '做偏了',
      criteria: '改动和做完标准对不上：改的是别的东西，或者只写了说明、没改该改的地方',
      effect: 'send_back',
      does: '退回原会话重做',
    },
  ],
  evidence: [
    { key: 'acceptance', label: '做完标准', required: true },
    { key: 'changes', label: '改动（改了哪些文件、提交说明）', required: true },
    { key: 'tests', label: '测试（跑了哪些、结果）', required: false },
    { key: 'summary', label: '会话交活时的自述', required: false },
  ],
  whenUnsure: '照常进验证：同步主线、跑 GitHub 测试、第二意见',
  confidenceLine: DEFAULT_CONFIDENCE_LINE,
  askWhen: '会话交活、代码的交付对账（改动和方案点名的地方对得上）通过之后',
});

export const REVIEW_SEVERITY = defineQuestion({
  id: 'review-severity',
  site: 'review-grade',
  title: '审查意见挡不挡合并',
  instructions: '这条审查意见说的问题，是不是必须改完才能合并？',
  options: [
    {
      id: 'must_fix',
      label: '必须改',
      criteria: '不改就没做到做完标准、会出错、会丢数据或有安全问题',
      effect: 'send_back',
      does: '退回主会话，改完再合',
    },
    {
      id: 'minor',
      label: '小毛病',
      criteria: '命名、风格、注释、多余的代码这类，不影响对错，可以攒着以后一起改',
      effect: 'none',
      does: '照审查者标的级别走',
    },
  ],
  evidence: [
    { key: 'finding', label: '审查意见原文', required: true },
    { key: 'acceptance', label: '做完标准', required: false },
    { key: 'code', label: '意见指到的代码或改动', required: false },
  ],
  whenUnsure: '按审查者自己标的级别',
  confidenceLine: DEFAULT_CONFIDENCE_LINE,
  askWhen:
    '只问审查者标成「小毛病」的意见：Jev 只能把小毛病升成必须改，不能把必须改降成小毛病（那等于放行合并）',
});

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

export const FEISHU_INTENT = defineQuestion({
  id: 'feishu-intent',
  site: 'feishu-intent',
  title: '飞书这句话要干嘛',
  instructions: '创始人在飞书里对机器人说了这句话，要机器人做什么？',
  options: [
    {
      id: 'new_task',
      label: '开新任务',
      criteria: '要做新东西、改现有的东西或修问题，需要开一个任务',
      effect: 'reroute',
      does: '出「我理解为……」确认卡，点了确认才开任务',
    },
    {
      id: 'progress',
      label: '问进度',
      criteria: '问某个任务做到哪了、为什么卡住、今天干了什么、额度还剩多少、有什么要他拍板',
      effect: 'reroute',
      does: '回进度卡或盘面卡（只读）',
    },
    {
      id: 'answer',
      label: '回答追问',
      criteria: '在回答机器人之前问他的问题，或给刚才那个任务补充信息',
      effect: 'reroute',
      does: '记成那个问题的回答；人闸的点头只认卡片按钮，不认这里记下的话',
    },
    {
      id: 'command',
      label: '下指令',
      criteria: '要对在途的任务叫停、暂停、重试、换模型，或者批准、拒绝一件等他点头的事',
      effect: 'reroute',
      does: '出带按钮的确认卡，人点了才执行',
    },
    {
      id: 'chat',
      label: '闲聊',
      criteria: '打招呼、道谢、闲聊，不用做任何事',
      effect: 'none',
      does: '照网关原来的回法',
    },
  ],
  evidence: [
    { key: 'message', label: '消息原文', required: true, private: true },
    { key: 'replying_to', label: '他回复的是哪张卡片', required: false, private: true },
    { key: 'recent_tasks', label: '最近在途的任务', required: false },
  ],
  whenUnsure: '照飞书网关原来的判法；原来的判法也拿不准，就弹二选一卡片让发的人自己点',
  confidenceLine: DEFAULT_CONFIDENCE_LINE,
});

export const DIGEST_PICK = defineQuestion({
  id: 'digest-pick',
  site: 'daily-digest',
  title: '日报要不要请人看',
  instructions: '这件事要不要放进今天日报的「要你看」一节？',
  options: [
    {
      id: 'must_see',
      label: '要人看',
      criteria: '在等人拍板、卡住了没人接手、同一个问题反复出现，或者碰到发布、花钱、删数据',
      effect: 'flag',
      does: '放进日报「要你看」一节',
    },
    {
      id: 'fyi',
      label: '不用特意看',
      criteria: '正常推进中、已经自动处理好了，或者只是例行记录',
      effect: 'none',
      does: '照规则排',
    },
  ],
  evidence: [
    { key: 'item', label: '这件事（类型、标题、现在的状态、为什么进日报）', required: true },
    { key: 'history', label: '最近几次状态变化', required: false },
  ],
  whenUnsure: '按规则排：要人拍的在前，卡住报警其次，其余放附录',
  confidenceLine: DEFAULT_CONFIDENCE_LINE,
});

/** 全部题目，按接入点排好。 */
export const BANK = [
  TRIAGE_KIND,
  TRIAGE_UI,
  TRIAGE_CLARITY,
  TRIAGE_GATE,
  DEDUPE_PAIR,
  SPEC_DONE,
  DELIVERY_MET,
  REVIEW_SEVERITY,
  ERROR_NEXT,
  STALL_STATE,
  FEISHU_INTENT,
  DIGEST_PICK,
] as const satisfies readonly QuestionDef[];

export type BankQuestion = (typeof BANK)[number];
export type QuestionId = BankQuestion['id'];

/** 分诊四题共用一份证据，一次问完。 */
export const TRIAGE_QUESTIONS = [TRIAGE_KIND, TRIAGE_UI, TRIAGE_CLARITY, TRIAGE_GATE] as const;

export function questionsOfSite(site: SiteId): readonly QuestionDef[] {
  return BANK.filter((q) => q.site === site);
}

export function findQuestion(id: string): QuestionDef | undefined {
  return BANK.find((q) => q.id === id);
}
