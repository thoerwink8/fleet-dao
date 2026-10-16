// 假后端里的「提需求」（#2062 页面用；真接口是 #2049 的 packages/api/src/request-store-pg.ts）。
// 能不能做只按 shared 的 requestActions 判（和真后端同一份），返回按 shared 的契约校验，报错的 code 和白话照真后端。
// 种子覆盖页面要画的几种样子：等我拍板、有我没读的、只有自己说过话（能删）、别人说过话（不能删）、搁置 14 天以上、
// 结案开出单子（置顶）、「接着这条提」挂在原条下面、已归档、最近删除。
// 地址上加 ?mockRequests=unavailable 看「后端没接上需求表」；?mockAs=partner 换成合伙人的视角（拍板卡点不了）。
import {
  CreateRequestRequest,
  draftMissing,
  idleDays,
  MarkRequestReadResponse,
  purgeAt,
  type RequestAction,
  type RequestActionRequest,
  RequestActionRequest as RequestActionSchema,
  type RequestCard,
  type RequestCommander,
  RequestDetailResponse,
  type RequestDraft,
  type RequestDraftField,
  RequestIssueOpeningResponse,
  type RequestIssueRef,
  RequestListResponse,
  type RequestMessage,
  type RequestMessageKind,
  type RequestPerson,
  type RequestRow,
  type RequestStatus,
  type RequestWaiting,
  requestActions,
  SendRequestMessageRequest,
  UpdateRequestDraftRequest,
} from '@fleet-dao/shared';
import { ApiError, type FleetApi } from '../client';
import type {
  CreateRequestBody,
  RequestActionBody,
  RequestDetail,
  RequestList,
  RequestListQueryBody,
  SendRequestMessageBody,
  UpdateRequestDraftBody,
} from '../types';

interface MPerson extends RequestPerson {
  decides: boolean;
}

interface MReq {
  seq: number;
  repoId: string;
  initiatorId: string;
  status: RequestStatus;
  deciderId: string | null;
  draft: RequestDraft;
  draftVersion: number;
  humanEdited: RequestDraftField[];
  issueRefs: RequestIssueRef[];
  continuesSeq?: number;
  archivedAt: string | null;
  deletedAt: string | null;
  firstSubmittedAt: string | null;
  closedAt: string | null;
  closeReason?: string;
  createdAt: string;
  lastActivityAt: string;
  /** 这条需求选的指挥官模型；null = 用「提需求」用途的默认。 */
  modelId: string | null;
  /** 指挥官会话（C 片）：假后端里回话是当场回的，所以平时都是 idle；暂停原因、聊了几轮照真后端的口径给。 */
  chat: { state: 'idle' | 'queued' | 'running'; pausedWhy?: string; turns: number };
}

interface MMsg {
  id: number;
  seq: number;
  kind: RequestMessageKind;
  authorId?: string;
  channel?: 'web' | 'mobile';
  body: string;
  mentions: string[];
  draftPatch?: Record<string, unknown>;
  card?: RequestCard;
  githubCommentRef?: string;
  answerState?: 'pending' | 'written' | 'failed';
  answer?: { text: string; by?: string; at: string; error?: string };
  createdAt: string;
}

interface MState {
  pinnedAt: string | null;
  lastRead: number | null;
}

export interface MockRequestsOptions {
  now: () => number;
  me: { id: string; name: string };
  repos: readonly { id: string; slug: string }[];
  /** 换成合伙人看（拍板卡点不了、删不了别人的）。不给就看地址上的 ?mockAs=partner。 */
  as?: 'me' | 'partner';
  /** unavailable = 后端没接上需求表。不给就看地址上的 ?mockRequests=。 */
  mode?: 'ok' | 'unavailable';
  latency?: () => Promise<void>;
}

/** 这次假后端用谁的视角看需求：选项优先，没给看地址上的 ?mockAs=partner。外面（登录的人）也要跟着换。 */
export function mockRequestsAs(as: MockRequestsOptions['as']): 'me' | 'partner' {
  return as ?? (query('mockAs') === 'partner' ? 'partner' : 'me');
}

export interface MockRequests
  extends Pick<
    FleetApi,
    | 'requestIssueOpening'
    | 'answerEngineAsk'
    | 'nudgeCommander'
    | 'stopCommander'
    | 'setCommanderModel'
    | 'requestReview'
    | 'markReviewItem'
    | 'commanderStream'
  > {
  requests(query: RequestListQueryBody): Promise<RequestList>;
  request(seq: number): Promise<RequestDetail>;
  createRequest(body: CreateRequestBody): Promise<RequestDetail>;
  sendRequestMessage(seq: number, body: SendRequestMessageBody): Promise<RequestDetail>;
  updateRequestDraft(seq: number, body: UpdateRequestDraftBody): Promise<RequestDetail>;
  requestAction(seq: number, body: RequestActionBody): Promise<RequestDetail>;
  markRequestRead(seq: number, messageId: number): Promise<{ lastReadMessageId: number | null }>;
}

/** 合伙人：不能自己拍板，发起的要提交给创始人拍。编号是 uuid（@ 他时接口要 uuid）。 */
export const MOCK_PARTNER = { id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', name: 'fxc188' } as const;

const NOT_HERE = '这台后端没接上需求表（开发环境的内存版没有），提需求用不了';

function query(name: string): string | null {
  return typeof location === 'undefined' ? null : new URLSearchParams(location.search).get(name);
}

const ACTION_WORDS: Record<RequestActionRequest['action'], string> = {
  submit: '提交拍板',
  confirm: '确定开单',
  approve: '同意做',
  reject: '不做',
  rediscuss: '再聊聊',
  withdraw: '撤回到讨论中',
  reopen: '重开',
  drop: '放下',
  archive: '归档',
  unarchive: '取消归档',
  delete: '删除',
  restore: '恢复',
  pin: '置顶',
  unpin: '取消置顶',
  rename: '改名',
};

function preview(body: string): string {
  const one = body.replace(/\s+/g, ' ').trim();
  return one.length > 120 ? `${one.slice(0, 120)}…` : one;
}

export function createMockRequests(opts: MockRequestsOptions): MockRequests {
  const now = opts.now;
  const wait = opts.latency ?? (async () => undefined);
  const mode = opts.mode ?? (query('mockRequests') === 'unavailable' ? 'unavailable' : 'ok');
  const as = mockRequestsAs(opts.as);
  const ME: MPerson = { id: opts.me.id, name: opts.me.name, decides: true };
  const PARTNER: MPerson = { ...MOCK_PARTNER, decides: false };
  const people = new Map<string, MPerson>([
    [ME.id, ME],
    [PARTNER.id, PARTNER],
  ]);
  const viewerId = as === 'partner' ? PARTNER.id : ME.id;
  const repo0 = opts.repos[0] ?? { id: 'r-orbit', slug: 'acme/orbit' };
  const repo1 = opts.repos[1] ?? repo0;
  const ago = (min: number) => new Date(now() - min * 60_000).toISOString();

  const reqs: MReq[] = [];
  const msgs: MMsg[] = [];
  const states = new Map<string, MState>();
  let nextMsg = 1;
  let nextSeq = 47;

  const stateOf = (seq: number, userId: string): MState => {
    const key = `${seq}|${userId}`;
    let s = states.get(key);
    if (!s) {
      s = { pinnedAt: null, lastRead: null };
      states.set(key, s);
    }
    return s;
  };
  const say = (
    seq: number,
    kind: RequestMessageKind,
    min: number,
    body: string,
    authorId?: string,
    extra: Partial<MMsg> = {},
  ): MMsg => {
    const m: MMsg = {
      id: nextMsg++,
      seq,
      kind,
      body,
      mentions: [],
      createdAt: ago(min),
      ...(authorId ? { authorId, channel: 'web' as const } : {}),
      ...extra,
    };
    msgs.push(m);
    return m;
  };
  const base = (seq: number, initiatorId: string, title: string, min: number, repoId = repo0.id): MReq => ({
    seq,
    repoId,
    initiatorId,
    status: 'discussing',
    deciderId: null,
    draft: { title },
    draftVersion: 1,
    humanEdited: [],
    issueRefs: [],
    archivedAt: null,
    deletedAt: null,
    firstSubmittedAt: null,
    closedAt: null,
    createdAt: ago(min),
    lastActivityAt: ago(min),
    modelId: null,
    chat: { state: 'idle', turns: 0 },
  });
  const readAll = (seq: number, userId: string) => {
    const last = msgs.filter((m) => m.seq === seq).at(-1);
    stateOf(seq, userId).lastRead = last?.id ?? null;
  };

  // —— 种子 ——
  {
    // 41：合伙人发起、16 天没人说话（搁置）。我能「放下」，删不了（不是我发起的）。
    const r = base(41, PARTNER.id, '额度页按账号池折叠', 16 * 1440 + 30, repo0.id);
    r.draft = { ...r.draft, scene: '额度页一个池一张卡，几十张卡一屏看不完。' };
    reqs.push(r);
    say(41, 'human', 16 * 1440 + 30, '额度页能不能按账号池折起来？现在一屏翻不完。', PARTNER.id);
    say(
      41,
      'commander',
      16 * 1440 + 29,
      '我看了 `components/quota.tsx`：现在每个池一张卡。你要的是「同一个账号的几个池折成一组」，还是「额度用完的池折起来」？',
    );
    say(41, 'human', 16 * 1440 + 20, '同一个账号的折成一组。', PARTNER.id);
    r.chat.pausedWhy = '指挥官暂停了：引擎总开关关着（额度熔断），这句没接上';
    say(41, 'system', 16 * 1440 + 20, r.chat.pausedWhy, undefined, {
      card: { type: 'paused', why: '引擎总开关关着（额度熔断），这句没接上' },
    });
    readAll(41, ME.id);
    readAll(41, PARTNER.id);
  }
  {
    // 31：我发起、确定开单，开出 #12（开着）；我置顶了。
    const r = base(31, ME.id, '设置页的几个密钥一次填好', 3 * 1440, repo1.id);
    r.status = 'closed_do';
    r.deciderId = ME.id;
    r.closedAt = ago(2 * 1440);
    r.lastActivityAt = ago(2 * 1440);
    r.draftVersion = 7;
    r.humanEdited = ['done'];
    r.draft = {
      title: '设置页的几个密钥一次填好',
      kind: '需求',
      scene: '换新机器时要把旧机器的方舟、火山语音几项密钥抄过来；现在每项一张卡、各点一次保存。',
      modules: 'web/src/pages/Settings.tsx\nserver/internal/api/secrets.go',
      want: '设置页多一张「一次填好」的表：每行一个密钥，填完点一次保存；已有的只显示尾 4 位，不填就不改。',
      done: [
        '设置页出现「一次填好」表，列出方舟、火山语音两类密钥',
        '只填其中一行点保存，没填的那行库里的值不变',
        '保存失败的行在行内写明原因，成功的行不回滚',
      ],
      notDo: '本次不含抖音（它的密钥在 .env.local，不在库里）。',
      size: '中',
    };
    r.issueRefs = [{ repo: repo1.slug, number: 12, state: 'open', stateAt: ago(2 * 1440) }];
    reqs.push(r);
    say(
      31,
      'human',
      3 * 1440,
      '设置页那几个密钥能不能一起填？现在方舟、火山语音各填一次，每次都要点保存，太烦了。',
      ME.id,
    );
    say(
      31,
      'commander',
      3 * 1440 - 1,
      '我看了 `web/src/pages/Settings.tsx`：现在「方舟」「火山语音」「抖音」各是一张卡，每张一个保存钮。\n\n其中一行保存失败时，其余几行要怎么办？',
      undefined,
      { draftPatch: { scene: '…', modules: '…' } },
    );
    say(31, 'human', 3 * 1440 - 3, '成功的先存，失败的行里标出原因。', ME.id);
    say(
      31,
      'system',
      2 * 1440,
      `${ME.name} 确定开单（草稿第 7 版），已结案。开出 #12：https://github.com/${repo1.slug}/issues/12`,
    );
    say(31, 'system', 2 * 1440 - 30, '#12 已开单，引擎还没接');
    say(31, 'system', 1440, '#12 动手中 · 已合并 1/3 个子任务');
    readAll(31, ME.id);
    readAll(31, PARTNER.id);
    // 引擎在 #12 上问了一句：等我（发起人）回答
    say(
      31,
      'engine_ask',
      90,
      '「一次填好」表里，已有的密钥只显示尾 4 位。要是某一行的值是空的（库里本来就没有），这一行显示「未设置」还是干脆不列？',
      undefined,
      {
        githubCommentRef: `https://github.com/${repo1.slug}/issues/12#issuecomment-9001`,
        answerState: 'pending',
      },
    );
    stateOf(31, ME.id).pinnedAt = ago(2 * 1440);
  }
  {
    // 43：合伙人提交拍板，等我拍。
    const r = base(43, PARTNER.id, '导出任务清单成表格', 1440 + 120, repo0.id);
    r.status = 'pending_decision';
    r.deciderId = ME.id;
    r.firstSubmittedAt = ago(60);
    r.lastActivityAt = ago(60);
    r.draftVersion = 4;
    r.draft = {
      title: '导出任务清单成表格',
      kind: '需求',
      scene: '月底对账要把这个月做完的单子拉成一张表，现在只能一页页截图。',
      modules: 'packages/web/src/routes/tasks.tsx\npackages/api/src/views.ts',
      want: '任务列表右上角加「导出」，按当前筛选导出 CSV：单号、标题、仓、状态、花费、完成时间。',
      done: ['任务页有「导出」按钮，导出的 CSV 行数等于当前筛选下的条数', '花费一列和页面上的合计对得上'],
      size: '小',
    };
    reqs.push(r);
    say(43, 'human', 1440 + 120, '任务清单能不能导出成表格？月底对账用。', PARTNER.id);
    say(43, 'commander', 1440 + 119, '可以。导出的是「当前筛选下的」，还是「这个月全部」？', undefined, {
      draftPatch: { want: '…' },
    });
    say(43, 'human', 1440 + 100, '按当前筛选就行。', PARTNER.id);
    say(43, 'system', 60, `${PARTNER.name} 提交拍板（草稿第 4 版），等 ${ME.name} 拍`);
    readAll(43, PARTNER.id);
    stateOf(43, ME.id).lastRead = msgs.filter((m) => m.seq === 43)[2]?.id ?? null;
  }
  {
    // 45：合伙人发起、我也说过话（谁都删不了，只能「放下」）；有我没读的新消息。
    const r = base(45, PARTNER.id, '任务列表加按仓筛选', 300, repo0.id);
    r.lastActivityAt = ago(8);
    r.draftVersion = 3;
    r.draft = {
      title: '任务列表加按仓筛选',
      scene: '几个仓的单子混在一个列表里，想只看一个仓的。',
      modules: 'packages/web/src/routes/tasks.tsx',
      done: ['任务页顶上能选仓，选了只剩那个仓的单'],
    };
    reqs.push(r);
    say(45, 'human', 300, '任务列表能不能按仓筛？', PARTNER.id);
    say(45, 'commander', 299, '能。筛选放在顶上那一排（和状态筛选并排），还是放进搜索框旁边的下拉？');
    say(45, 'human', 120, '我补一句：顶栏已经有「当前项目」下拉了，能不能直接跟着它？', ME.id);
    say(45, 'human', 8, '跟着顶栏也行，但要能一键看全部。@指挥官 你看下顶栏那个下拉的代码？', PARTNER.id, {
      mentions: [],
    });
    readAll(45, PARTNER.id);
    stateOf(45, ME.id).lastRead = msgs.filter((m) => m.seq === 45)[2]?.id ?? null;
  }
  {
    // 44：我「接着 31 提」的，挂在 31 下面。
    const r = base(44, ME.id, '一次填好的表里加上抖音', 25, repo1.id);
    r.continuesSeq = 31;
    reqs.push(r);
    say(44, 'human', 25, '接着 31：抖音的密钥也想放进那张表里。', ME.id);
    say(
      44,
      'commander',
      24,
      '#12 还开着。抖音的密钥现在在 `.env.local`，要先挪进库里。你想这次一起挪，还是另开一张？',
    );
    r.modelId = 'claude-opus-5-5';
    say(44, 'system', 20, `${ME.name} 把这条需求的指挥官换成 Claude Opus 5.5`, undefined, {
      card: { type: 'model_switch', from: null, to: 'claude-opus-5-5' },
    });
    say(44, 'human', 18, '一起挪吧，场景我自己写了。', ME.id);
    r.draftVersion = 3;
    r.humanEdited = ['scene'];
    r.draft = { ...r.draft, scene: '抖音的密钥还在 .env.local，换机器时要单独抄一遍。' };
    say(44, 'commander', 17, '好。场景你改过，我不直接动，给一句建议：', undefined, {
      card: {
        type: 'suggest',
        field: 'scene',
        value:
          '抖音的密钥还在 .env.local，换机器时要单独抄；想挪进库里，和方舟、火山语音一起在「一次填好」表里填。',
      },
    });
    say(44, 'review', 15, '别家（GPT 5.6）看了第 3 版草稿，挑了 2 条：', undefined, {
      card: {
        type: 'review',
        draftVersion: 3,
        model: 'GPT 5.6',
        items: [
          { text: '没写挪的时候旧的 .env.local 那一项怎么办（删掉还是留着）。', verdict: null },
          { text: '「怎么算做完」还空着。', verdict: null },
        ],
      },
    });
    readAll(44, ME.id);
  }
  {
    // 46：我刚提的，只有我和指挥官说过话：能删。草稿还缺几栏，提交不了。
    const r = base(46, ME.id, '首页「要你拍的」按仓分组', 40, repo0.id);
    r.draft = {
      title: '首页「要你拍的」按仓分组',
      scene: '几个仓的「要你拍的」混在一起，看不出是哪个仓的。',
    };
    reqs.push(r);
    say(46, 'human', 40, '首页「要你拍的」能不能按仓分组？现在几个仓混在一起看不出是哪个仓的。', ME.id);
    say(
      46,
      'commander',
      39,
      '我看了 `components/home/decisions.tsx`：现在按时间排，几个仓混在一起。',
      undefined,
      {
        draftPatch: { scene: '…' },
        card: {
          type: 'question',
          question: '你要的是按仓分组（每组一个小标题），还是按仓筛（只看一个仓）？',
          options: ['按仓分组', '按仓筛', '两样都要'],
          allowOwn: true,
        },
      },
    );
    r.chat.turns = 1;
    readAll(46, ME.id);
  }
  {
    // 90：人说了三次，指挥官给出方案卡。草稿齐了，发起人能点「确认开单」。
    // 号避开 47：假后端新建从 47 起，剧本③「接着这条提」认的就是 47。
    const r = base(90, ME.id, '导出按钮按月出表', 2, repo0.id);
    r.draftVersion = 2;
    r.chat.turns = 3;
    r.draft = {
      title: '导出按钮按月出表',
      kind: '需求',
      scene: '财务月底要一张这个月的表，现在只能截图。',
      modules: 'packages/web/src/routes/tasks.tsx',
      want: '任务页加导出，按月出 CSV。',
      done: ['任务页有「导出」按钮，点了下载当月 CSV'],
      notDo: '不含改筛选。',
      size: '小',
    };
    reqs.push(r);
    say(90, 'human', 12, '任务页想按月导出。', ME.id);
    say(90, 'human', 8, '给财务，CSV 就行。', ME.id);
    say(90, 'human', 3, '这个月的，按完成时间。', ME.id);
    say(90, 'commander', 2, '方案齐了，看一下就能开单。', undefined, {
      card: {
        type: 'proposal',
        draftVersion: 2,
        summary:
          '标题：导出按钮按月出表\n场景：财务月底要一张这个月的表\n已知的模块：packages/web/src/routes/tasks.tsx\n要什么：任务页加导出，按月出 CSV\n怎么算做完：任务页有「导出」按钮，点了下载当月 CSV\n不做什么：不含改筛选\n规模建议：小\n要不要人拍：不用',
      },
    });
    readAll(90, ME.id);
  }
  {
    // 30：合伙人提、我拍了「不做」：马上归档。
    const r = base(30, PARTNER.id, '暗色主题再调一档对比度', 6 * 1440, repo0.id);
    r.status = 'closed_drop';
    r.deciderId = ME.id;
    r.firstSubmittedAt = ago(5 * 1440 + 60);
    r.closedAt = ago(5 * 1440);
    r.archivedAt = ago(5 * 1440);
    r.lastActivityAt = ago(5 * 1440);
    r.closeReason = '现在的对比度够用，先不动';
    reqs.push(r);
    say(30, 'human', 6 * 1440, '暗色主题的灰字有点看不清，能不能再调一档？', PARTNER.id);
    say(30, 'system', 5 * 1440 + 60, `${PARTNER.name} 提交拍板（草稿第 2 版），等 ${ME.name} 拍`);
    say(30, 'system', 5 * 1440, `${ME.name} 拍板：不做。理由：现在的对比度够用，先不动`);
    readAll(30, ME.id);
    readAll(30, PARTNER.id);
  }
  {
    // 29：已上线满 3 天，自动归档了。
    const r = base(29, ME.id, '首页改版', 12 * 1440, repo1.id);
    r.status = 'closed_do';
    r.deciderId = ME.id;
    r.closedAt = ago(11 * 1440);
    r.archivedAt = ago(4 * 1440);
    r.lastActivityAt = ago(11 * 1440);
    r.issueRefs = [{ repo: repo1.slug, number: 8, state: 'deployed', stateAt: ago(7 * 1440) }];
    reqs.push(r);
    say(29, 'human', 12 * 1440, '首页改一下：一屏看清要我拍的、在跑的、做完的。', ME.id);
    say(29, 'system', 11 * 1440, `${ME.name} 确定开单（草稿第 5 版），已结案`);
    readAll(29, ME.id);
  }
  {
    // 28：我删了，在「最近删除」里，还能恢复。
    const r = base(28, ME.id, '试试用语音提需求', 4 * 1440, repo0.id);
    r.deletedAt = ago(3 * 1440);
    reqs.push(r);
    say(28, 'human', 4 * 1440, '能不能直接说一段话，转成文字提需求？', ME.id);
    readAll(28, ME.id);
  }

  // —— 拼法（和真后端 request-store-pg.ts 同一个口径） ——

  const person = (id: string): RequestPerson => {
    const p = people.get(id);
    return p ? { id: p.id, name: p.name } : { id, name: '（已不在的用户）' };
  };
  const repoSlug = (id: string) =>
    opts.repos.find((r) => r.id === id)?.slug ?? (id === repo0.id ? repo0.slug : '（项目已移出驾驶舱）');
  const msgsOf = (seq: number) => msgs.filter((m) => m.seq === seq);
  const deciderAvailable = () => [...people.values()].some((p) => p.decides);
  const firstDecider = () => [...people.values()].find((p) => p.decides)?.id ?? null;

  function rowOf(r: MReq, viewer: string): RequestRow {
    const list = msgsOf(r.seq);
    const last = list.at(-1);
    const st = stateOf(r.seq, viewer);
    const unread = list.filter(
      (m) => (st.lastRead === null || m.id > st.lastRead) && m.authorId !== viewer,
    ).length;
    const ask = list.some((m) => m.kind === 'engine_ask' && m.answerState !== 'written');
    const waiting: RequestWaiting | null =
      r.status === 'pending_decision' && r.deciderId === viewer
        ? 'decide'
        : ask && r.initiatorId === viewer
          ? 'engine_ask'
          : unread > 0
            ? 'unread'
            : null;
    const speakers: string[] = [];
    for (const m of list) {
      if (m.kind === 'human' && m.authorId && m.authorId !== r.initiatorId && !speakers.includes(m.authorId))
        speakers.push(m.authorId);
    }
    const lastAuthor = last?.authorId ? people.get(last.authorId) : undefined;
    return {
      seq: r.seq,
      title: r.draft.title,
      status: r.status,
      repo: { id: r.repoId, slug: repoSlug(r.repoId) },
      initiator: person(r.initiatorId),
      participants: speakers.map(person),
      ...(last
        ? {
            lastMessage: {
              kind: last.kind,
              ...(lastAuthor ? { authorName: lastAuthor.name } : {}),
              preview: preview(last.body),
              at: last.createdAt,
            },
          }
        : {}),
      lastActivityAt: r.lastActivityAt,
      pinned: st.pinnedAt !== null,
      unread,
      waitingOnMe: waiting,
      idleDays: idleDays(r, new Date(now())),
      issueRefs: r.issueRefs,
      ...(r.continuesSeq !== undefined ? { continuesSeq: r.continuesSeq } : {}),
      ...(r.archivedAt ? { archivedAt: r.archivedAt } : {}),
      ...(r.deletedAt ? { deletedAt: r.deletedAt, purgeAt: purgeAt(r.deletedAt) } : {}),
    };
  }

  function actionsOf(r: MReq, viewer: string) {
    const v = people.get(viewer) ?? { id: viewer, decides: false };
    return requestActions(
      {
        status: r.status,
        initiatorId: r.initiatorId,
        deciderId: r.deciderId,
        initiatorDecides: people.get(r.initiatorId)?.decides ?? false,
        archived: r.archivedAt !== null,
        deletedAt: r.deletedAt,
        everSubmitted: r.firstSubmittedAt !== null,
        otherHumanSpoke: msgsOf(r.seq).some(
          (m) => m.kind === 'human' && m.authorId !== undefined && m.authorId !== r.initiatorId,
        ),
        draftMissing: draftMissing(r.draft),
        pinned: stateOf(r.seq, viewer).pinnedAt !== null,
        commanderRunning: r.chat.state !== 'idle',
        closeReason: r.closeReason ?? null,
      },
      { id: v.id, decidesRequests: v.decides },
      { now: new Date(now()), deciderAvailable: deciderAvailable() },
    );
  }

  function toMessage(m: MMsg): RequestMessage {
    return {
      id: m.id,
      kind: m.kind,
      ...(m.authorId ? { author: person(m.authorId) } : {}),
      ...(m.channel ? { channel: m.channel } : {}),
      body: m.body,
      mentions: m.mentions,
      ...(m.draftPatch ? { draftPatch: m.draftPatch } : {}),
      ...(m.card ? { card: m.card } : {}),
      ...(m.githubCommentRef ? { githubCommentRef: m.githubCommentRef } : {}),
      ...(m.answerState ? { answerState: m.answerState } : {}),
      ...(m.answer
        ? {
            answer: {
              text: m.answer.text,
              ...(m.answer.by ? { by: person(m.answer.by) } : {}),
              at: m.answer.at,
              ...(m.answer.error ? { error: m.answer.error } : {}),
            },
          }
        : {}),
      createdAt: m.createdAt,
    };
  }

  /** 「提需求」用途里配了的模型（假的两档；Fable 没配进来，所以不在里面）。 */
  const MODELS = [
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  ];
  const modelName = (id: string | null) => MODELS.find((m) => m.id === id)?.name ?? '默认模型';

  function commanderOf(r: MReq): RequestCommander {
    const picked = r.modelId ? (MODELS.find((m) => m.id === r.modelId) ?? null) : null;
    return {
      state: r.chat.state,
      running: r.chat.state !== 'idle',
      model: picked,
      defaultModel: MODELS[0] ?? null,
      models: MODELS,
      turns: r.chat.turns,
      maxTurns: 40,
      ...(r.chat.pausedWhy ? { pausedWhy: r.chat.pausedWhy } : {}),
    };
  }

  /** 指挥官这一句（假后端当场回）：一次一个问题，带选项。 */
  function commanderReply(r: MReq) {
    if (r.chat.turns >= 40) {
      r.chat.pausedWhy = '指挥官暂停了：这条已经聊满 40 轮';
      say(r.seq, 'system', 0, r.chat.pausedWhy, undefined, {
        card: { type: 'paused', why: '这条已经聊满 40 轮' },
      });
      return;
    }
    r.chat.turns += 1;
    delete r.chat.pausedWhy;
    say(r.seq, 'commander', 0, `记下了。我去看了相关代码（${modelName(r.modelId)}）。`, undefined, {
      card: {
        type: 'question',
        question: '这件事最急的是哪一块？',
        options: ['先做最小能用的', '一次做全', '先出个样子看看'],
        allowOwn: true,
      },
    });
  }

  /** 只有一个人说过话时每句都回；两个人都说过以后，只在 @指挥官 时回（和 shared 的判法同一个口径）。 */
  function commanderShouldReply(r: MReq, mentioned: boolean): boolean {
    const speakers = new Set(
      msgsOf(r.seq)
        .filter((m) => m.kind === 'human')
        .map((m) => m.authorId),
    );
    return speakers.size <= 1 || mentioned;
  }

  function findMessage(seq: number, messageId: number): MMsg {
    const m = msgs.find((x) => x.seq === seq && x.id === messageId);
    if (!m) throw new ApiError(404, 'message_not_found', `需求 ${seq} 里没有消息 ${messageId}`);
    return m;
  }

  let nextIssue = 60;

  function find(seq: number): MReq {
    const r = reqs.find((x) => x.seq === seq);
    if (!r) throw new ApiError(404, 'request_not_found', `没有需求 ${seq}`);
    return r;
  }

  function detailOf(seq: number): RequestDetail {
    const r = find(seq);
    const row = rowOf(r, viewerId);
    return RequestDetailResponse.parse({
      asOf: new Date(now()).toISOString(),
      request: {
        ...row,
        draft: r.draft,
        draftVersion: r.draftVersion,
        humanEdited: r.humanEdited,
        needsDecision: !(people.get(r.initiatorId)?.decides ?? false),
        ...(r.deciderId ? { decider: person(r.deciderId) } : {}),
        ...(r.closedAt ? { closedAt: r.closedAt } : {}),
        ...(r.closeReason ? { closeReason: r.closeReason } : {}),
        createdAt: r.createdAt,
        continuedBy: reqs
          .filter((x) => x.continuesSeq === r.seq && x.deletedAt === null)
          .map((x) => x.seq)
          .sort((a, b) => a - b),
      },
      commander: commanderOf(r),
      messages: msgsOf(seq).map(toMessage),
      lastReadMessageId: stateOf(seq, viewerId).lastRead,
      actions: actionsOf(r, viewerId),
    });
  }

  function refused(why: string): never {
    throw new ApiError(409, 'request_refused', why);
  }
  function guardWrite() {
    if (mode === 'unavailable') throw new ApiError(503, 'requests_unavailable', NOT_HERE);
  }
  function viewerName() {
    return people.get(viewerId)?.name ?? '有人';
  }

  function hits(r: MReq, q: string): boolean {
    const needle = q.toLowerCase();
    if (r.draft.title.toLowerCase().includes(needle)) return true;
    if (msgsOf(r.seq).some((m) => m.kind === 'human' && m.body.toLowerCase().includes(needle))) return true;
    const issue = /^#?(\d{1,9})$/.exec(q.trim());
    return issue ? r.issueRefs.some((i) => i.number === Number(issue[1])) : false;
  }

  return {
    async requests(q) {
      await wait();
      const base = { asOf: new Date(now()).toISOString(), view: q.view, filter: q.filter };
      if (mode === 'unavailable') {
        return RequestListResponse.parse({
          ...base,
          counts: { todo: 0, all: 0, mine: 0, archived: 0, deleted: 0 },
          items: [],
          unavailable: NOT_HERE,
        });
      }
      const inView = (view: RequestListQueryBody['view']) =>
        reqs.filter((r) =>
          view === 'deleted'
            ? r.deletedAt !== null && r.initiatorId === viewerId
            : view === 'archived'
              ? r.deletedAt === null && r.archivedAt !== null
              : r.deletedAt === null && r.archivedAt === null,
        );
      const list = inView(q.view);
      const rows = list.map((r) => rowOf(r, viewerId));
      const mine = (row: RequestRow) => row.initiator.id === viewerId;
      let items =
        q.filter === 'todo'
          ? rows.filter((r) => r.waitingOnMe !== null)
          : q.filter === 'mine'
            ? rows.filter(mine)
            : rows;
      if (q.q) {
        const needle = q.q;
        items = items.filter((row) => hits(find(row.seq), needle));
      }
      items = [...items].sort((a, b) => {
        const pa = stateOf(a.seq, viewerId).pinnedAt ?? '';
        const pb = stateOf(b.seq, viewerId).pinnedAt ?? '';
        if (pa !== pb) return pb.localeCompare(pa);
        return b.lastActivityAt.localeCompare(a.lastActivityAt) || b.seq - a.seq;
      });
      return RequestListResponse.parse({
        ...base,
        counts: {
          todo: rows.filter((r) => r.waitingOnMe !== null).length,
          all: rows.length,
          mine: rows.filter(mine).length,
          archived: inView('archived').length,
          deleted: inView('deleted').length,
        },
        items,
      });
    },

    async request(seq) {
      await wait();
      if (mode === 'unavailable') throw new ApiError(503, 'requests_unavailable', NOT_HERE);
      return detailOf(seq);
    },

    async createRequest(raw) {
      await wait();
      guardWrite();
      const input = CreateRequestRequest.omit({ repoId: true }).parse(raw);
      const repoId = raw.repoId;
      if (!opts.repos.some((r) => r.id === repoId) && repoId !== repo0.id) {
        throw new ApiError(404, 'repo_not_found', '没有这个项目：只能给驾驶舱里已导入的项目提需求');
      }
      if (input.continuesSeq !== undefined) {
        const prev = reqs.find((x) => x.seq === input.continuesSeq && x.deletedAt === null);
        if (!prev) throw new ApiError(404, 'request_not_found', `没有需求 ${input.continuesSeq}`);
        if (prev.status !== 'closed_do' && prev.status !== 'closed_drop') {
          refused('只有已结案的需求能「接着这条提」：没结案的请直接在原来那条里接着聊');
        }
      }
      const seq = nextSeq++;
      const first = input.body.trim().split('\n')[0]?.trim() ?? '';
      const title = input.title ?? (first.length > 30 ? `${first.slice(0, 30)}…` : first || '新需求');
      const r = base(seq, viewerId, title, 0, repoId);
      if (input.title) r.humanEdited = ['title'];
      if (input.continuesSeq !== undefined) r.continuesSeq = input.continuesSeq;
      reqs.push(r);
      const m = say(seq, 'human', 0, input.body, viewerId, { channel: input.channel });
      stateOf(seq, viewerId).lastRead = m.id;
      commanderReply(r);
      return detailOf(seq);
    },

    async sendRequestMessage(seq, raw) {
      await wait();
      guardWrite();
      const input = SendRequestMessageRequest.omit({ mentions: true }).parse(raw);
      const r = find(seq);
      const v = actionsOf(r, viewerId).send;
      if (!v.allowed) refused(v.why ?? '不能发消息');
      const m = say(seq, 'human', 0, input.body, viewerId, {
        channel: input.channel,
        mentions: [...new Set(raw.mentions ?? [])],
      });
      r.lastActivityAt = m.createdAt;
      stateOf(seq, viewerId).lastRead = m.id;
      if (commanderShouldReply(r, input.mentionCommander || input.body.includes('@指挥官')))
        commanderReply(r);
      return detailOf(seq);
    },

    async updateRequestDraft(seq, raw) {
      await wait();
      guardWrite();
      const input = UpdateRequestDraftRequest.parse(raw);
      const r = find(seq);
      const v = actionsOf(r, viewerId).editDraft;
      if (!v.allowed) refused(v.why ?? '不能改草稿');
      if (input.baseVersion !== r.draftVersion) {
        refused(`草稿已经改到第 ${r.draftVersion} 版，你看到的是第 ${input.baseVersion} 版：刷新后再改`);
      }
      const next: Record<string, unknown> = { ...r.draft };
      for (const [k, val] of Object.entries(input.patch)) {
        if (val === undefined) continue;
        const empty =
          (typeof val === 'string' && val.trim() === '') || (Array.isArray(val) && val.length === 0);
        if (empty) delete next[k];
        else next[k] = val;
      }
      r.draft = next as RequestDraft;
      r.draftVersion += 1;
      r.humanEdited = [...new Set([...r.humanEdited, ...(Object.keys(input.patch) as RequestDraftField[])])];
      r.lastActivityAt = new Date(now()).toISOString();
      return detailOf(seq);
    },

    async requestAction(seq, raw) {
      await wait();
      guardWrite();
      const input = RequestActionSchema.parse(raw);
      const r = find(seq);
      const v = actionsOf(r, viewerId)[input.action as RequestAction];
      if (!v.allowed) refused(v.why ?? `不能${ACTION_WORDS[input.action]}`);
      if ('draftVersion' in input && input.draftVersion !== r.draftVersion) {
        refused(
          `草稿已经改到第 ${r.draftVersion} 版，你看到的是第 ${input.draftVersion} 版：刷新看过最新的再${ACTION_WORDS[input.action]}`,
        );
      }
      const at = new Date(now()).toISOString();
      const who = viewerName();
      const sys = (body: string) => say(seq, 'system', 0, body);
      switch (input.action) {
        case 'submit': {
          const d = firstDecider();
          if (d === null) refused('没有能拍板的人');
          Object.assign(r, { status: 'pending_decision', deciderId: d, lastActivityAt: at });
          r.firstSubmittedAt ??= at;
          sys(`${who} 提交拍板（草稿第 ${r.draftVersion} 版），等 ${person(d).name} 拍`);
          break;
        }
        case 'confirm':
        case 'approve': {
          // 和真后端一样：开出单才结案；单号是假的
          const number = nextIssue++;
          const slug = repoSlug(r.repoId);
          Object.assign(r, {
            status: 'closed_do',
            ...(input.action === 'confirm' ? { deciderId: viewerId } : {}),
            closedAt: at,
            lastActivityAt: at,
          });
          r.issueRefs = [...r.issueRefs, { repo: slug, number, state: 'open', stateAt: at }];
          const url = `https://github.com/${slug}/issues/${number}`;
          sys(
            input.action === 'confirm'
              ? `${who} 确定开单（草稿第 ${r.draftVersion} 版），已结案。开出 #${number}：${url}`
              : `${who} 拍板：同意做（草稿第 ${r.draftVersion} 版），已结案。开出 #${number}：${url}`,
          );
          break;
        }
        case 'reject':
          Object.assign(r, {
            status: 'closed_drop',
            closedAt: at,
            closeReason: input.reason,
            archivedAt: at,
            lastActivityAt: at,
          });
          sys(`${who} 拍板：不做。理由：${input.reason}`);
          break;
        case 'rediscuss':
          Object.assign(r, { status: 'discussing', lastActivityAt: at });
          sys(`${who} 点了「再聊聊」${input.note ? `：${input.note}` : ''}`);
          break;
        case 'withdraw':
          Object.assign(r, { status: 'discussing', lastActivityAt: at });
          sys(`${who} 撤回到讨论中`);
          break;
        case 'reopen':
          r.status = 'discussing';
          r.closedAt = null;
          r.archivedAt = null;
          r.lastActivityAt = at;
          delete r.closeReason;
          sys(`${who} 重开了这条需求，回到讨论中`);
          break;
        case 'drop':
          Object.assign(r, {
            status: 'closed_drop',
            closedAt: at,
            closeReason: input.reason,
            archivedAt: at,
            lastActivityAt: at,
          });
          sys(`${who} 放下了这条需求。理由：${input.reason}`);
          break;
        case 'archive':
          r.archivedAt = at;
          break;
        case 'unarchive':
          r.archivedAt = null;
          break;
        case 'delete':
          r.deletedAt = at;
          break;
        case 'restore':
          r.deletedAt = null;
          break;
        case 'pin':
          stateOf(seq, viewerId).pinnedAt = at;
          break;
        case 'unpin':
          stateOf(seq, viewerId).pinnedAt = null;
          break;
        case 'rename':
          r.draft = { ...r.draft, title: input.title };
          r.draftVersion += 1;
          r.humanEdited = [...new Set([...r.humanEdited, 'title' as const])];
          r.lastActivityAt = at;
          break;
      }
      return detailOf(seq);
    },

    async markRequestRead(seq, messageId) {
      await wait();
      guardWrite();
      find(seq);
      if (!msgsOf(seq).some((m) => m.id === messageId)) {
        throw new ApiError(404, 'message_not_found', `需求 ${seq} 里没有消息 ${messageId}`);
      }
      const st = stateOf(seq, viewerId);
      st.lastRead = Math.max(st.lastRead ?? 0, messageId);
      return MarkRequestReadResponse.parse({ lastReadMessageId: st.lastRead });
    },

    async requestIssueOpening(seq, draftVersion) {
      await wait();
      const r = find(seq);
      const issue = r.status === 'closed_do' ? r.issueRefs.at(-1) : undefined;
      return RequestIssueOpeningResponse.parse({
        asOf: new Date(now()).toISOString(),
        seq,
        draftVersion,
        state: issue ? 'opened' : 'none',
        ...(issue
          ? {
              issue: {
                repo: issue.repo,
                number: issue.number,
                url: `https://github.com/${issue.repo}/issues/${issue.number}`,
              },
              requestedBy: person(r.initiatorId),
            }
          : {}),
      });
    },

    async answerEngineAsk(seq, messageId, text) {
      await wait();
      guardWrite();
      const r = find(seq);
      const m = findMessage(seq, messageId);
      if (m.kind !== 'engine_ask') refused('这条不是引擎的提问，没法回答');
      if (r.initiatorId !== viewerId && r.deciderId !== viewerId)
        refused('只有发起人或拍板人能回答引擎的提问');
      const at = new Date(now()).toISOString();
      m.answer = { text: text.trim(), by: viewerId, at };
      m.answerState = 'written';
      r.lastActivityAt = at;
      return detailOf(seq);
    },

    async nudgeCommander(seq) {
      await wait();
      guardWrite();
      const r = find(seq);
      const v = actionsOf(r, viewerId).send;
      if (!v.allowed) refused(v.why ?? '现在不能让指挥官接着问');
      commanderReply(r);
      return detailOf(seq);
    },

    async stopCommander(seq) {
      await wait();
      guardWrite();
      const r = find(seq);
      r.chat.state = 'idle';
      return detailOf(seq);
    },

    async setCommanderModel(seq, modelId) {
      await wait();
      guardWrite();
      const r = find(seq);
      if (r.status === 'closed_do' || r.status === 'closed_drop') refused('已结案的需求不能换模型');
      if (modelId !== null && !MODELS.some((m) => m.id === modelId)) {
        refused('只能选「提需求」用途里配了的模型');
      }
      if (r.modelId === modelId) return detailOf(seq);
      say(seq, 'system', 0, `${viewerName()} 把这条需求的指挥官换成 ${modelName(modelId)}`, undefined, {
        card: { type: 'model_switch', from: r.modelId, to: modelId },
      });
      r.modelId = modelId;
      return detailOf(seq);
    },

    async requestReview(seq) {
      await wait();
      guardWrite();
      const r = find(seq);
      if (r.status === 'closed_do' || r.status === 'closed_drop') refused('已结案的需求不再挑错');
      say(seq, 'review', 0, `别家（GPT 5.6）看了第 ${r.draftVersion} 版草稿，挑了 2 条：`, undefined, {
        card: {
          type: 'review',
          draftVersion: r.draftVersion,
          model: 'GPT 5.6',
          items: [
            { text: '「怎么算做完」里有一条在 diff 里看不见：改成能在页面上点出来的样子。', verdict: null },
            { text: '没写不做什么：范围容易越做越大。', verdict: null },
          ],
        },
      });
      return detailOf(seq);
    },

    async markReviewItem(seq, messageId, body) {
      await wait();
      guardWrite();
      const m = findMessage(seq, messageId);
      if (m.card?.type !== 'review') refused('这条不是别家的意见');
      const item = m.card.items[body.index];
      if (!item) refused(`没有第 ${body.index + 1} 条意见`);
      item.verdict = body.verdict;
      return detailOf(seq);
    },

    commanderStream(_seq, listener) {
      // 假后端的指挥官当场回话，不会有「在跑」的时候：一连上就回完
      const t = setTimeout(() => listener({ type: 'done' }), 0);
      return () => clearTimeout(t);
    },
  };
}
