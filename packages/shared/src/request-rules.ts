// 需求的状态机和权限（#2049，方案 specs/2047-提需求/方案.md 第一至三节）：每个动作能不能做、为什么不能做。
// 判法只有这一份：后端的接口（packages/api 的 request-store-pg.ts）在锁住那一行之后调它，页面看详情里的 actions（也是它算的），
// 定时任务（packages/db 的 sweepRequests）用这里的自动归档、硬删判据。
// 改这里之前必须知道：
// - 身份只认登录会话里的用户（viewer），不认请求里写的；拍板人按 users 表判（decides_requests），不按谁说了算。
// - 结案锁死：已结案的不能再发消息、改草稿、改名；要改只能「接着这条提」另开一条。
// - 删除只给「还没留下任何决定、也没牵扯别人」的：讨论中、只有发起人说过话（指挥官的话不算）、从没提交过拍板，且只有发起人能删；
//   指挥官会话排着队或正在回话时也删不了，要先停（C 片，#2061）。
// - 讨论中不能手动归档：要么接着聊，要么「放下」（写理由）。
// - 讨论中闲置满 3 天由定时任务自动收口（写原因、归档）。收口不算结案：不锁死、不能「接着这条提」，谁都能「重开」回讨论中；
//   收口时不能发消息、改草稿，要先重开（免得说了话却没人知道它已经收了）。
import {
  REQUEST_ACTIONS,
  REQUEST_ARCHIVE_AFTER_SETTLED_DAYS,
  REQUEST_IDLE_CLOSE_DAYS,
  REQUEST_IDLE_DAYS,
  REQUEST_KINDS,
  REQUEST_PURGE_AFTER_DAYS,
  type RequestAction,
  type RequestActions,
  type RequestDraft,
  type RequestIssueRef,
  type RequestStatus,
  type RequestVerdict,
} from './web-api/requests.ts';

const DAY_MS = 24 * 60 * 60_000;

/** 判一条需求要的事实：都由服务端从库里读，不收前端的。 */
export interface RequestFacts {
  status: RequestStatus;
  initiatorId: string;
  /** 拍板人：提交拍板（或自己确定）之后才有。 */
  deciderId: string | null;
  /** 发起人自己能拍板（users.decides_requests）：能的话自己「确定」，不能要「提交拍板」等拍板人。 */
  initiatorDecides: boolean;
  archived: boolean;
  /** 删了的时刻（ISO）；没删是 null。 */
  deletedAt: string | null;
  /** 提交过拍板（哪怕后来被「再聊聊」退回）。 */
  everSubmitted: boolean;
  /** 发起人以外的人说过话（指挥官、系统、引擎的话不算）。 */
  otherHumanSpoke: boolean;
  /** 草稿还缺的栏（中文栏名）；齐了是空。 */
  draftMissing: readonly string[];
  /** 看的这个人置顶了没有。 */
  pinned: boolean;
  /** 指挥官会话排着队或正在回话（C 片，#2061）：这时删除不可用，要先停。 */
  commanderRunning: boolean;
}

export const COMMANDER_RUNNING_DELETE_WHY = '指挥官正在回话，停下后才能删';

/** 看的这个人：登录会话里的用户，加上 users 表里的拍板资格。 */
export interface RequestViewer {
  id: string;
  decidesRequests: boolean;
}

export interface RequestRuleContext {
  now: Date;
  /** users 表里有没有能拍板的人（合伙人发起的要有人拍）。 */
  deciderAvailable: boolean;
}

const yes: RequestVerdict = { allowed: true };
const no = (why: string): RequestVerdict => ({ allowed: false, why });

export const CLOSED_LOCKED_WHY = '已结案，内容不再改：要改请在电脑上点「接着这条提」另开一条';
export const DELETED_WHY = '这条需求已经删了：先在「最近删除」里恢复';
export const IDLE_CLOSED_WHY = '已收口（闲置太久没动静）：点「重开」回到讨论中再接着聊';

export function isClosed(status: RequestStatus): boolean {
  return status === 'closed_do' || status === 'closed_drop';
}

/** 草稿开单要的四节里，草稿管的那几栏（原话由系统拼，不在草稿里）。 */
export function draftMissing(draft: RequestDraft): string[] {
  const missing: string[] = [];
  if (!draft.title.trim()) missing.push('标题');
  if (!draft.scene?.trim()) missing.push('场景');
  if (!draft.modules?.trim()) missing.push('已知的模块');
  if (!draft.done || draft.done.length === 0) missing.push('怎么算做完');
  // 类别写了认不出的值（指挥官写过「文档」）：拍板时开单才失败，提前在这里拦下，说清只能写哪几个
  const kind = draft.kind?.trim();
  if (kind && !(REQUEST_KINDS as readonly string[]).includes(kind))
    missing.push(`类别（只能是${REQUEST_KINDS.join('、')}）`);
  return missing;
}

/** 删了的需求几点被彻底删掉。 */
export function purgeAt(deletedAt: string): string {
  return new Date(new Date(deletedAt).getTime() + REQUEST_PURGE_AFTER_DAYS * DAY_MS).toISOString();
}

/** 删了满 30 天：定时任务连消息一起硬删。 */
export function purgeDue(deletedAt: string | null, now: Date): boolean {
  return deletedAt !== null && new Date(purgeAt(deletedAt)).getTime() <= now.getTime();
}

/** 讨论中多少天没动静：满 14 天才给（列表标「搁置 N 天」），不满、不在讨论中、删了的都是 null。 */
export function idleDays(
  r: { status: RequestStatus; lastActivityAt: string; deletedAt: string | null },
  now: Date,
): number | null {
  if (r.status !== 'discussing' || r.deletedAt !== null) return null;
  const days = Math.floor((now.getTime() - new Date(r.lastActivityAt).getTime()) / DAY_MS);
  return days >= REQUEST_IDLE_DAYS ? days : null;
}

/** 讨论中闲置满 3 天该自动收口：回闲置了几天；不该收口是 null（不在讨论中、删了的、不满 3 天）。 */
export function idleCloseDue(
  r: { status: RequestStatus; lastActivityAt: string; deletedAt: string | null },
  now: Date,
): number | null {
  if (r.status !== 'discussing' || r.deletedAt !== null) return null;
  const days = Math.floor((now.getTime() - new Date(r.lastActivityAt).getTime()) / DAY_MS);
  return days >= REQUEST_IDLE_CLOSE_DAYS ? days : null;
}

/** 收口的原因（写进 close_reason，页面原样显示）：闲置几天、最后一句是谁说的。 */
export function idleCloseReason(days: number, lastSpeaker: string | null): string {
  const who = lastSpeaker === null ? '还没有人说过话' : `最后一句是${lastSpeaker}说的`;
  return `闲置 ${days} 天没动静，自动收口；${who}`;
}

/**
 * 该不该自动归档：已结案·不做的马上归档；已结案·做的，开出的单全部上线或关掉、最后一张满 3 天才归档。
 * 没开出单（B 片还没接上开单）的已结案·做不归档：它还在「进行中」等单子。
 */
export function autoArchiveDue(
  r: {
    status: RequestStatus;
    archivedAt: string | null;
    deletedAt: string | null;
    issueRefs: readonly RequestIssueRef[];
  },
  now: Date,
): boolean {
  if (r.archivedAt !== null || r.deletedAt !== null) return false;
  if (r.status === 'closed_drop') return true;
  if (r.status !== 'closed_do' || r.issueRefs.length === 0) return false;
  if (!r.issueRefs.every((i) => i.state === 'deployed' || i.state === 'closed')) return false;
  const settled = Math.max(...r.issueRefs.map((i) => new Date(i.stateAt).getTime()));
  return now.getTime() - settled >= REQUEST_ARCHIVE_AFTER_SETTLED_DAYS * DAY_MS;
}

/** 能不能删：不能时写为什么、该怎么办（方案第三节「能不能删」那张表）。 */
function deleteVerdict(r: RequestFacts, viewer: RequestViewer): RequestVerdict {
  if (isClosed(r.status)) return no('已结案的需求不能删，只能归档：它是做过的事的记录');
  if (r.status === 'pending_decision') {
    return no('待拍板的需求不能删：拍板人点「不做」，或发起人撤回到讨论中再「放下」');
  }
  if (r.everSubmitted) return no('提交过拍板的需求不能删，只能「放下」（写理由）');
  if (r.otherHumanSpoke)
    return no('别人也说过话，不能删：别人说过的话不该被另一个人删掉，请「放下」（写理由）');
  if (viewer.id !== r.initiatorId) return no('只有发起人能删');
  if (r.commanderRunning) return no(COMMANDER_RUNNING_DELETE_WHY);
  return yes;
}

/** 每个动作对这个人能不能做。 */
export function requestActions(
  r: RequestFacts,
  viewer: RequestViewer,
  ctx: RequestRuleContext,
): RequestActions {
  const out = {} as Record<RequestAction, RequestVerdict>;
  const isInitiator = viewer.id === r.initiatorId;

  if (r.deletedAt !== null) {
    for (const a of REQUEST_ACTIONS) out[a] = no(DELETED_WHY);
    out.restore = !isInitiator
      ? no('只有发起人能恢复')
      : purgeDue(r.deletedAt, ctx.now)
        ? no('删了已满 30 天，等着被彻底删掉，恢复不了')
        : yes;
    return out;
  }

  const closed = isClosed(r.status);
  const discussing = r.status === 'discussing';
  const pending = r.status === 'pending_decision';
  const idleClosed = r.status === 'idle_closed';
  const missing = r.draftMissing.length > 0 ? `草稿还缺：${r.draftMissing.join('、')}` : null;

  out.send = closed ? no(CLOSED_LOCKED_WHY) : idleClosed ? no(IDLE_CLOSED_WHY) : yes;
  out.editDraft = closed
    ? no(CLOSED_LOCKED_WHY)
    : idleClosed
      ? no(IDLE_CLOSED_WHY)
      : pending
        ? no('待拍板时草稿锁着：拍板人点「再聊聊」或发起人撤回后再改')
        : yes;
  out.rename = discussing
    ? yes
    : no(closed ? CLOSED_LOCKED_WHY : idleClosed ? IDLE_CLOSED_WHY : '只有讨论中的需求能改名');

  if (!discussing) {
    const why = closed ? CLOSED_LOCKED_WHY : idleClosed ? IDLE_CLOSED_WHY : '已经提交拍板了，等拍板人拍';
    out.submit = no(why);
    out.confirm = no(why);
  } else if (!isInitiator) {
    out.submit = no('只有发起人能提交拍板');
    out.confirm = no('只有发起人能确定开单');
  } else if (r.initiatorDecides) {
    out.submit = no('你发起的需求不用拍板：直接「确定，开单」');
    out.confirm = missing ? no(missing) : yes;
  } else {
    out.confirm = no('合伙人发起的需求要创始人拍板：请「提交拍板」');
    out.submit = missing
      ? no(missing)
      : ctx.deciderAvailable
        ? yes
        : no('没有能拍板的人：users 表里没有 decides_requests 的创始人，请创始人在服务器上设好');
  }

  const decideWhy = !pending
    ? closed
      ? '已结案，不能再拍板'
      : idleClosed
        ? IDLE_CLOSED_WHY
        : '还没提交拍板'
    : viewer.id !== r.deciderId
      ? '只有拍板人能拍板'
      : null;
  out.approve = decideWhy ? no(decideWhy) : yes;
  out.reject = decideWhy ? no(decideWhy) : yes;
  out.rediscuss = decideWhy ? no(decideWhy) : yes;

  out.withdraw = !pending ? no('只有待拍板的需求能撤回') : isInitiator ? yes : no('只有发起人能撤回');
  out.reopen = idleClosed ? yes : no('只有收口的需求能重开');

  out.drop = !(discussing || idleClosed)
    ? no(closed ? '已经结案了' : '待拍板时不能放下：拍板人点「不做」，或发起人先撤回')
    : isInitiator || viewer.decidesRequests
      ? yes
      : no('只有发起人或拍板人能放下');

  out.archive = r.archived
    ? no('已经归档了')
    : closed || idleClosed
      ? yes
      : no(
          discussing
            ? '讨论中的需求不能归档：接着聊，或「放下」（写理由）'
            : '待拍板的需求不能归档：等拍板人拍',
        );
  out.unarchive = r.archived ? yes : no('没有归档');

  out.delete = deleteVerdict(r, viewer);
  out.restore = no('没有删');

  out.pin = r.pinned ? no('已经置顶了') : yes;
  out.unpin = r.pinned ? yes : no('没有置顶');
  return out;
}
