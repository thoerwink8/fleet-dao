// 「提需求」页第二版的假数据（版面评审用，不连后端）。
// 场景：合伙人 fxc188 想让 daihuo 工作台设置页的几个密钥一次填好；创始人 cxy 插话、拍板。
import type { LayoutTone } from '../layout/tone';

export type Who = 'cxy' | 'fxc188' | 'ai';
export type Human = Exclude<Who, 'ai'>;
export type Scene = 'discuss' | 'pending' | 'closed';
/** 一条需求的状态：讨论中 → 待拍板 → 已结案·做 / 已结案·不做；「再聊聊」退回讨论中。 */
export type Status = 'discussing' | 'pending' | 'do' | 'no';
export type GhState = 'working' | 'merged' | 'shipped';

export const PEOPLE: Record<Human, { name: string; role: string }> = {
  cxy: { name: 'cxy', role: '创始人' },
  fxc188: { name: 'fxc188', role: '合伙人' },
};

export const MODELS = ['指挥官默认：Sonnet 5.5', 'Opus 5.5', 'GPT 5.6'] as const;
export const REPOS = ['adfx-studio/daihuo-workbench', 'thoerwink8/fleet-dao'] as const;

export interface StatusView {
  tone: LayoutTone;
  label: string;
}

export function statusView(s: Status, gh?: GhState, issue?: number): StatusView {
  if (s === 'discussing') return { tone: 'wait', label: '讨论中' };
  if (s === 'pending') return { tone: 'human', label: '待拍板' };
  if (s === 'no') return { tone: 'stop', label: '已结案·不做' };
  if (gh === 'merged') return { tone: 'done', label: '已结案·做 · 已合并' };
  if (gh === 'shipped') return { tone: 'done', label: '已结案·做 · 已上线' };
  return { tone: 'run', label: '已结案·做 · 在做' };
}

export interface Req {
  no: number;
  title: string;
  repo: string;
  initiator: Human;
  participants: Human[];
  status: Status;
  gh?: GhState | undefined;
  issue?: number | undefined;
  pr?: number | undefined;
  updated: string;
  /** 下一步轮到谁，例如「等 cxy 拍板」。 */
  waiting: string | null;
  /** 正等着当前这个人。 */
  mineFor?: Human | undefined;
  /** 「接着这条提」开出来的，挂在哪条下面。 */
  parent?: number | undefined;
}

export function reqList(scene: Scene): Req[] {
  const cur: Req = {
    no: 42,
    title: '设置页的几个密钥一次填好',
    repo: 'daihuo-workbench',
    initiator: 'fxc188',
    participants: ['fxc188', 'cxy'],
    status: scene === 'discuss' ? 'discussing' : scene === 'pending' ? 'pending' : 'do',
    gh: scene === 'closed' ? 'working' : undefined,
    issue: scene === 'closed' ? 12 : undefined,
    pr: scene === 'closed' ? 34 : undefined,
    updated: '刚刚',
    waiting: scene === 'discuss' ? '指挥官（被 @）' : scene === 'pending' ? '等 cxy 拍板' : '引擎问你',
    mineFor: scene === 'discuss' ? undefined : 'cxy',
  };
  const rest: Req[] = [
    {
      no: 41,
      title: '额度页按账号池折叠',
      repo: 'fleet-dao',
      initiator: 'fxc188',
      participants: ['fxc188'],
      status: 'do',
      gh: 'working',
      issue: 27,
      pr: 31,
      updated: '40 分钟前',
      waiting: '引擎问你',
      mineFor: 'fxc188',
    },
    {
      no: 40,
      title: '任务列表加按仓筛选',
      repo: 'fleet-dao',
      initiator: 'cxy',
      participants: ['cxy', 'fxc188'],
      status: 'discussing',
      updated: '昨天 18:05',
      waiting: '等 fxc188 回话',
      mineFor: 'fxc188',
    },
    {
      no: 36,
      title: '导出任务清单成表格',
      repo: 'fleet-dao',
      initiator: 'fxc188',
      participants: ['fxc188', 'cxy'],
      status: 'pending',
      updated: '昨天 21:10',
      waiting: '等 cxy 拍板',
      mineFor: 'cxy',
    },
    {
      no: 33,
      title: '装新机器时的清单页',
      repo: 'daihuo-workbench',
      initiator: 'fxc188',
      participants: ['fxc188', 'cxy'],
      status: 'pending',
      updated: '昨天 16:20',
      waiting: '等 cxy 拍板',
      mineFor: 'cxy',
    },
    {
      no: 35,
      title: '飞瓜被挤下线时给个提醒',
      repo: 'daihuo-workbench',
      initiator: 'fxc188',
      participants: ['fxc188', 'cxy'],
      status: 'do',
      gh: 'merged',
      issue: 19,
      pr: 22,
      updated: '昨天 21:40',
      waiting: null,
    },
    {
      no: 31,
      title: '首页改版',
      repo: 'daihuo-workbench',
      initiator: 'cxy',
      participants: ['cxy'],
      status: 'do',
      gh: 'shipped',
      issue: 8,
      pr: 9,
      updated: '10-11',
      waiting: null,
    },
    {
      no: 30,
      title: '暗色主题再调一档对比度',
      repo: 'fleet-dao',
      initiator: 'cxy',
      participants: ['cxy'],
      status: 'no',
      updated: '10-09',
      waiting: null,
    },
  ];
  // 脚本里没有别人在等 cxy 的第三件：讨论中那一幕给 cxy 补一条
  const list = [cur, ...rest];
  if (scene === 'closed') {
    list.splice(1, 0, {
      no: 44,
      title: '一次填好的表里加上抖音',
      repo: 'daihuo-workbench',
      initiator: 'cxy',
      participants: ['cxy'],
      status: 'discussing',
      updated: '5 分钟前',
      waiting: '指挥官在问',
      parent: 42,
    });
  }
  return list;
}

export type DraftField = 'title' | 'scene' | 'quote' | 'modules' | 'want' | 'done' | 'not';

export interface Option {
  label: string;
}

export type Msg =
  | { kind: 'say'; id: string; who: Who; at: string; text: string }
  | { kind: 'ask'; id: string; at: string; question: string; options: Option[]; answered?: string }
  | { kind: 'patch'; id: string; text: string; field: DraftField }
  | { kind: 'suggest'; id: string; field: DraftField; text: string; state?: 'taken' | 'skipped' }
  | { kind: 'sys'; id: string; at?: string; text: string }
  | { kind: 'divider'; id: string; text: string };

export interface Quote {
  who: Human;
  channel: '手机' | '网页';
  at: string;
  text: string;
}

export interface Draft {
  /** 草稿版本号，每改一次加 1；拍板拍的就是这一版。 */
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

const T1 = '设置页那几个密钥能不能一起填？现在方舟、火山语音、抖音各填一次，每次都要点保存，太烦了。';
const T3 = '就是这几张卡的密钥。';
const T6 = '我补一句：抖音那张卡的密钥现在好像不在库里，是写在 .env.local 的，别漏了。';
const T7 = '@指挥官 抖音这块你看下代码，是不是真这样？';

export function draftOf(): Draft {
  return {
    version: 7,
    title: '设置页：同一次抄来的几个密钥一张表一次填好',
    category: '需求',
    size: '中',
    scene:
      '合伙人 fxc188 在新机器上装工作台，要把旧机器的方舟、火山语音等几项密钥抄过来。现在设置页每项一张卡、各点一次保存，抄一遍要来回十几次。',
    quotes: [
      { who: 'fxc188', channel: '手机', at: '16:12', text: T1 },
      { who: 'fxc188', channel: '网页', at: '16:14', text: T3 },
      { who: 'cxy', channel: '网页', at: '16:31', text: T6 },
      { who: 'fxc188', channel: '网页', at: '16:33', text: T7 },
    ],
    modules: ['web/src/pages/Settings.tsx', 'server/internal/api/secrets.go'],
    want: '设置页多一张「一次填好」的表：每行一个密钥，填完点一次保存；已有的只显示尾 4 位，不填就不改。',
    done: [
      '设置页出现「一次填好」表，列出方舟、火山语音两类密钥，每行一个输入框',
      '只填其中一行点保存，没填的那行库里的值不变；换过的每行在历史里多一条',
      '保存失败的行在行内写明原因，成功的行不回滚',
    ],
    not: '本次不含抖音（它的密钥在 .env.local，不在库里）；不做从旧机器自动导入。',
  };
}

export type DupState =
  | { kind: 'found'; issue: number; title: string; reason: string }
  | { kind: 'failed'; reason: string };

export const DUPLICATE = {
  issue: 9,
  title: '设置页：密钥分组显示，换密钥留历史',
  reason: '都动设置页密钥表；#9 没做批量填写',
};

export function messagesOf(scene: Scene): Msg[] {
  const base: Msg[] = [
    { kind: 'say', id: 'm1', who: 'fxc188', at: '16:12', text: T1 },
    {
      kind: 'say',
      id: 'm2',
      who: 'ai',
      at: '16:12',
      text: '我看了 `web/src/pages/Settings.tsx`：现在「方舟」「火山语音」「抖音」各是一张卡，每张卡一个保存钮，密钥存在 `secrets_history` 表里。\n\n你说的「几个」，是这三张卡，还是别的？',
    },
    { kind: 'say', id: 'm3', who: 'fxc188', at: '16:14', text: T3 },
    { kind: 'patch', id: 'm4', text: '草稿里补了：场景、已知的模块', field: 'modules' },
    {
      kind: 'ask',
      id: 'm5',
      at: '16:15',
      question: '填完之后点一次保存，其中一行失败了，其余几行要怎么办？',
      options: [],
      answered: '成功的先存，失败的行里标出原因',
    },
    { kind: 'say', id: 'm6', who: 'fxc188', at: '16:16', text: '成功的先存，失败的行里标出原因。' },
    { kind: 'say', id: 'm7', who: 'cxy', at: '16:31', text: T6 },
    { kind: 'say', id: 'm8', who: 'fxc188', at: '16:33', text: T7 },
    {
      kind: 'say',
      id: 'm9',
      who: 'ai',
      at: '16:33',
      text: '@fxc188 看了 `server/internal/api/secrets.go`：cxy 说得对，抖音的 cookie 在 `.env.local`，不在库里。我先把它写进草稿的「不做什么」，你们看行不行。',
    },
    { kind: 'patch', id: 'm10', text: '草稿里补了：怎么算做完第 2 条、不做什么', field: 'done' },
  ];
  if (scene === 'discuss') {
    return [
      ...base,
      {
        kind: 'sys',
        id: 'm11',
        text: '两个人都说过话了：指挥官只在被 @指挥官 或点「让指挥官接着问」时才说话',
      },
      { kind: 'say', id: 'm12', who: 'cxy', at: '16:36', text: '行，抖音先不做。@指挥官 再想想有没有漏的？' },
    ];
  }
  const submitted: Msg[] = [
    ...base,
    { kind: 'say', id: 'm12', who: 'cxy', at: '16:36', text: '行，抖音先不做。' },
    { kind: 'sys', id: 'm13', at: '22:30', text: 'fxc188 提交给 cxy 拍板（第 7 版草稿）' },
  ];
  if (scene === 'pending') return submitted;
  return [...submitted, { kind: 'sys', id: 'm14', at: '22:41', text: 'cxy 同意做，开成 #12（第 7 版）' }];
}

export interface Step {
  label: string;
  at: string;
  state: 'done' | 'now' | 'todo';
  note?: string;
}

export const TIMELINE: Step[] = [
  {
    label: '已开成 #12',
    at: '22:41',
    state: 'done',
    note: '作者是引擎机器人，正文末尾记了提出人 fxc188、拍板人 cxy',
  },
  { label: '引擎接单', at: '22:43', state: 'done' },
  { label: '动手中', at: '22:46', state: 'done', note: '2 轮，改了 Settings.tsx 和 secrets.go' },
  { label: '开 PR #34', at: '22:52', state: 'done' },
  { label: '已合并', at: '', state: 'now', note: '等 CI 跑完' },
  { label: '已上线', at: '', state: 'todo' },
];

export const ENGINE_ASK = {
  id: 'q1',
  at: '22:47',
  comment: '#12 评论 3',
  text: '改的时候发现：设置页「火山语音」那张卡有个「测试连接」钮。一次填好的表里，每行要不要也带上？',
  options: ['要，每行一个', '不要，保持只填不测'],
};
