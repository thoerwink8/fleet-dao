// 「提需求」页的假数据（版面评审用，不连后端）。场景：合伙人 fxc188 想让 daihuo 工作台设置页的几个密钥一次填好。
import type { LayoutTone } from '../layout/tone';

export type Scene = 'a' | 'b' | 'c';

export type ConvStatus = 'chatting' | 'ready' | 'working' | 'merged' | 'shipped' | 'dropped';

export const STATUS_VIEW: Record<ConvStatus, { tone: LayoutTone; label: (n?: number) => string }> = {
  chatting: { tone: 'wait', label: () => '聊着' },
  ready: { tone: 'human', label: () => '可以开单' },
  working: { tone: 'run', label: (n) => `已开 #${n} 在做` },
  merged: { tone: 'done', label: () => '已合并' },
  shipped: { tone: 'done', label: () => '已上线' },
  dropped: { tone: 'stop', label: () => '放下了' },
};

export interface Conv {
  id: string;
  title: string;
  repo: string;
  status: ConvStatus;
  issue?: number;
  updated: string;
}

export const REPOS = ['adfx-studio/daihuo-workbench', 'thoerwink8/fleet-dao'] as const;

/** 左栏的列表。第一条是当前这段对话，状态随场景变。 */
export function convList(scene: Scene): Conv[] {
  const current: Conv =
    scene === 'a'
      ? {
          id: 'c1',
          title: '设置页的几个密钥一次填好',
          repo: 'daihuo-workbench',
          status: 'chatting',
          updated: '刚刚',
        }
      : scene === 'b'
        ? {
            id: 'c1',
            title: '设置页的几个密钥一次填好',
            repo: 'daihuo-workbench',
            status: 'ready',
            updated: '刚刚',
          }
        : {
            id: 'c1',
            title: '设置页的几个密钥一次填好',
            repo: 'daihuo-workbench',
            status: 'working',
            issue: 12,
            updated: '2 分钟前',
          };
  return [
    current,
    {
      id: 'c2',
      title: '额度页按账号池折叠',
      repo: 'fleet-dao',
      status: 'working',
      issue: 27,
      updated: '40 分钟前',
    },
    {
      id: 'c3',
      title: '飞瓜被挤下线时给个提醒',
      repo: 'daihuo-workbench',
      status: 'merged',
      issue: 19,
      updated: '昨天 21:40',
    },
    { id: 'c4', title: '任务列表加按仓筛选', repo: 'fleet-dao', status: 'chatting', updated: '昨天 18:05' },
    { id: 'c5', title: '首页改版', repo: 'daihuo-workbench', status: 'shipped', issue: 8, updated: '10-11' },
    { id: 'c6', title: '暗色主题再调一档对比度', repo: 'fleet-dao', status: 'dropped', updated: '10-09' },
  ];
}

export interface Option {
  label: string;
  /** 点了之后指挥官的下一句（脚本回复用）。 */
  hint?: string;
}

export type Msg =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'ai'; id: string; text: string }
  | { kind: 'ask'; id: string; question: string; options: Option[]; answered?: string }
  | { kind: 'patch'; id: string; text: string; field: DraftField }
  | { kind: 'suggest'; id: string; field: DraftField; text: string; state?: 'taken' | 'skipped' }
  | { kind: 'sys'; id: string; text: string };

export type DraftField = 'title' | 'scene' | 'quote' | 'modules' | 'want' | 'done' | 'not';

export interface Quote {
  who: string;
  channel: '飞书' | '网页';
  at: string;
  text: string;
}

export interface Draft {
  /** 草稿版本号，每改一次加 1；点「确定」确定的就是这一版。 */
  version: number;
  title: string;
  category: '需求' | '缺陷' | '杂项';
  size: string;
  scene: string;
  quotes: Quote[];
  modules: string[];
  want: string;
  done: string[];
  not: string;
}

const QUOTE_1 = '设置页那几个密钥能不能一起填？现在方舟、火山语音、抖音各填一次，每次都要点保存，太烦了。';
const QUOTE_2 = '就是我装新机器的时候，从旧机器抄过来的那几项，一张表一次填完。';
const Q1: Quote = { who: 'fxc188', channel: '飞书', at: '16:12', text: QUOTE_1 };
const Q2: Quote = { who: 'fxc188', channel: '网页', at: '16:31', text: QUOTE_2 };

export function draftOf(scene: Scene): Draft {
  const base: Draft = {
    version: 7,
    title: '设置页：同一次抄来的几个密钥一张表一次填好',
    category: '需求',
    size: '中',
    scene:
      '合伙人 fxc188 在新机器上装工作台，要把旧机器的方舟、火山语音等几项密钥抄过来。现在设置页每项一张卡、各点一次保存，抄一遍要来回十几次。',
    quotes: [Q1, Q2],
    modules: ['web/src/pages/Settings.tsx', 'server/internal/api/secrets.go'],
    want: '设置页多一张「一次填好」的表：每行一个密钥，填完点一次保存；已有的只显示尾 4 位，不填就不改。',
    done: [],
    not: '',
  };
  if (scene === 'a')
    return {
      ...base,
      version: 3,
      quotes: [Q1],
      want: '设置页多一张「一次填好」的表：每行一个密钥，填完点一次保存。',
      not: '',
    };
  return {
    ...base,
    done: [
      '设置页出现「一次填好」表，列出方舟、火山语音、抖音三类密钥，每行一个输入框',
      '只填其中两行点保存，没填的那行库里的值不变；换过的每行在历史里多一条',
      '保存失败的行在行内写明原因，成功的行不回滚',
    ],
    not: '不动飞瓜账号密码（它只放本地 .env.local）；不做从旧机器自动导入。',
  };
}

/** 查重结果：found 有相似的；failed 没查成（写原因，不写「没有重复」）。 */
export type DupState =
  | { kind: 'found'; issue: number; title: string; reason: string }
  | { kind: 'failed'; reason: string };

export const DUPLICATE = {
  issue: 9,
  title: '设置页：密钥分组显示，换密钥留历史',
  reason: '都动设置页的密钥表；#9 已做了分组和历史，没做批量填写',
};

export const AI_INTRO =
  '你好，fxc188。我是指挥官，会先读一遍 **daihuo-workbench** 的代码，再一次问你一个问题，把单子写到工程师能接得住。你只管说大白话。';

export function messagesOf(scene: Scene): Msg[] {
  const head: Msg[] = [
    { kind: 'ai', id: 'm0', text: AI_INTRO },
    { kind: 'user', id: 'm1', text: QUOTE_1 },
    {
      kind: 'ai',
      id: 'm2',
      text: '我看了 `web/src/pages/Settings.tsx`：现在「方舟」「火山语音」「抖音」各是一张卡，每张卡一个保存钮，密钥存在 `secrets_history` 表里。\n\n你说的「几个」，是这三张卡，还是别的？',
    },
    { kind: 'user', id: 'm3', text: '就是这几张卡的密钥。' },
    { kind: 'patch', id: 'm4', text: '草稿里补了：场景、已知的模块', field: 'modules' },
  ];
  if (scene === 'a') {
    return [
      ...head,
      {
        kind: 'ask',
        id: 'm5',
        question: '填完之后点一次保存，其中一行失败了（比如 Key 格式不对），其余几行要怎么办？',
        options: [
          { label: '成功的先存，失败的行里标出原因' },
          { label: '整批不存，全部改对再存' },
          { label: '先让我预览一遍再存' },
        ],
      },
    ];
  }
  const mid: Msg[] = [
    ...head,
    {
      kind: 'ask',
      id: 'm5',
      question: '填完之后点一次保存，其中一行失败了，其余几行要怎么办？',
      options: [],
      answered: '成功的先存，失败的行里标出原因',
    },
    { kind: 'user', id: 'm6', text: '成功的先存，失败的行里标出原因。' },
    {
      kind: 'ai',
      id: 'm7',
      text: '好，那「怎么算做完」我这样写：\n\n- 出现「一次填好」表\n- 只填两行，另一行的值不变\n- 失败的行内写明原因\n\n还有一点：你提到「从旧机器抄过来」，要不要顺带做自动导入？',
    },
    { kind: 'user', id: 'm8', text: '不用，先手动填。' },
    { kind: 'patch', id: 'm9', text: '草稿里补了：怎么算做完第 2 条、不做什么', field: 'done' },
    {
      kind: 'ai',
      id: 'm10',
      text: '四节都齐了。右边看一眼，没问题就点「确定，开单」。有一张 **#9** 看着相近，你判断是不是一回事。',
    },
  ];
  if (scene === 'b') {
    return [
      ...mid,
      {
        kind: 'suggest',
        id: 'sg1',
        field: 'want',
        text: '「要什么」建议加一句：已有的密钥只显示尾 4 位，不填就不改。',
      },
    ];
  }
  return [...mid, { kind: 'sys', id: 'm11', text: '已开成 #12' }];
}

export interface Step {
  label: string;
  at: string;
  state: 'done' | 'now' | 'todo';
  note?: string;
}

export const TIMELINE: Step[] = [
  { label: '已开成 #12', at: '22:41', state: 'done', note: '作者是引擎机器人，正文末尾记了提出人 fxc188' },
  { label: '创始人点头', at: '22:43', state: 'done', note: '合伙人的单头两周要先放行' },
  { label: '引擎接单', at: '22:44', state: 'done' },
  { label: '动手中', at: '22:46', state: 'now', note: '第 1 轮，正在改 Settings.tsx' },
  { label: '开 PR #34', at: '', state: 'todo' },
  { label: '已合并', at: '', state: 'todo' },
  { label: '已上线', at: '', state: 'todo' },
];

export const ENGINE_ASK = {
  id: 'q1',
  at: '22:47',
  comment: '#12 评论 3',
  text: '改的时候发现：「抖音」那张卡的密钥现在不存在 `secrets_history`，是写在 `.env.local` 里的。一次填好的表里要不要包含它？',
  options: ['不含，抖音保持原样', '含，一并改成存库里'],
};
