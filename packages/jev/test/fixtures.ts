// 测试用的题：删掉没人调的题库之前，jev.test、store.test 等是拿它们当「两三个选项、效果各不同」的现成样题用的。
// 它们不在生产题库里（生产题库只有 bank.ts 的三道题），只给测试造各种效果、证据组合；接入点随便挂一个已有的。
import { DEFAULT_CONFIDENCE_LINE } from '../src/policy.ts';
import { defineQuestion } from '../src/questions.ts';

const REQUEST = { key: 'request', label: '需求原文（标题、正文、评论）', required: true } as const;

export const TRIAGE_KIND = defineQuestion({
  id: 'triage-kind',
  site: 'issue-kind',
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
  site: 'issue-kind',
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
  site: 'issue-kind',
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
  site: 'issue-kind',
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
  site: 'issue-kind',
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

export const DELIVERY_MET = defineQuestion({
  id: 'delivery-met',
  site: 'issue-kind',
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

export const FEISHU_INTENT = defineQuestion({
  id: 'feishu-intent',
  site: 'issue-kind',
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

export const TRIAGE_QUESTIONS = [TRIAGE_KIND, TRIAGE_UI, TRIAGE_CLARITY, TRIAGE_GATE] as const;
