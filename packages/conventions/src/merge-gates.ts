// 合并闸的判法（design 第五节「流程只为快」，#74；#1114 / 决定 0023 起只剩引擎任务 PR 的冷调用一条）：引擎任务 PR 当前头上有没有
// 通过的冷调用结论。纯判断，不碰网络；读写 GitHub 的在 merge-gate.ts。草稿、冲突 GitHub 自己拦，别的 PR 只看 CI。
// 三态纪律：读不到、认不出由调用方判「没查成」（退出码 2），不当成「没问题」。

/**
 * 验收那一遍（合前一次冷调用，#555-2）写在 PR 当前头上的提交状态。
 *
 * 合并闸只**读**它——合并闸跑在 CI 里，判法必须确定（同一份代码什么时候跑结果都一样，
 * design 第五节），所以不能在这里起模型调用。冷调用那一遍在装配侧跑，结论贴成这个 context 的状态，闸只认状态。
 */
export const COLD_VERIFY_CONTEXT = 'cold-verify';
/** 冷调用最多几轮（specs/555-3：默认 1 轮、最多 2 轮）。到顶了还不过就是不过，不许拿第 3 轮盖过去。 */
export const COLD_VERIFY_MAX_ROUND = 2;

export type StatusState = 'success' | 'failure' | 'error' | 'pending';
const STATES: readonly string[] = ['success', 'failure', 'error', 'pending'];

export interface CommitStatus {
  state: StatusState;
  description: string;
}

/**
 * 从「当前头的合并状态」（GET /commits/{sha}/status）里取某个 context 的那一条。
 *
 * 没有这一条返回 null；读回来的样子认不出返回一句为什么（调用方判没查成）。
 */
export function statusByContext(statuses: readonly unknown[], context: string): CommitStatus | null | string {
  let found: CommitStatus | null = null;
  for (const s of statuses) {
    if (!isObject(s) || typeof s.context !== 'string') return '提交状态里有一条认不出（没有 context）';
    if (s.context !== context) continue;
    if (typeof s.state !== 'string' || !STATES.includes(s.state)) {
      return `${context} 的 state「${String(s.state)}」认不出`;
    }
    if (found) continue; // 同一个 context 只该有一条；多了取第一条（GitHub 按新到旧排）
    found = {
      state: s.state as StatusState,
      description: typeof s.description === 'string' ? s.description.trim() : '',
    };
  }
  return found;
}

/**
 * 从同一份提交状态里取冷调用（#555）写下的一条。没有 = null（闸判「还没验」），
 * 认不出 = 一句为什么（闸判没查成，不当成没问题）。
 */
export function coldVerifyFrom(statuses: readonly unknown[]): CommitStatus | null | string {
  return statusByContext(statuses, COLD_VERIFY_CONTEXT);
}

/**
 * 这个 PR 该不该有冷调用（合前验收）的结论。`needed` 为假就是不用验。
 *
 * **范围是引擎任务工作流（#632）开的 PR**：验收是三段流程的第三段，由引擎在合之前跑、把结论贴成状态；
 * 闸要保证的是「引擎的 PR 没验过就合不进去」——不论是引擎自己的顺序出了错、有人手挂了自动合并，还是兜底的对账挂了它。
 * 人手开的 PR 没有引擎替它们验，也就不能要这条状态（要了就永远卡在「还没验」），它们只看 CI。
 * 认「引擎的 PR」靠分支名（flow-branch.ts 的 isFlowBranch）：它防的是引擎的 bug 和漏挂，不防存心绕过的人（那样的人本来就能直接合）。
 */
export interface ColdVerifyNeed {
  needed: boolean;
  /** 要验时的理由（写给人看）；不用验时是空串。 */
  why: string;
}

export function coldVerifyNeed(flowPr: boolean): ColdVerifyNeed {
  return flowPr
    ? { needed: true, why: '这是引擎任务工作流开的 PR（分支名 fleet/<单号>-t<8 位>）' }
    : { needed: false, why: '' };
}

/**
 * 验收那一遍（合前一次冷调用，#555-2）的判法。三态纪律：读不到、认不出不当成「没问题」，有两处要点：
 *
 * 1. **没有这条状态不是「没问题」**：这条 status 该由装配侧写好才轮到合并闸（规格里「读不到就明确失败」那条），
 *    闸看到的「没有」只有两种可能——装配侧压根没跑、或写了没写成。两种都不许放行，所以判红的措辞是
 *    「还没验 / 没验成」，不是「等它写着」。
 * 2. **error 也算没过**：GitHub 自己把状态写成 error（写的时候网络断在半路之类）时不能当通过。
 *
 * 调用方只在需要它的地方问（引擎任务工作流开的 PR，见 coldVerifyNeed）：别的 PR 不验，也就没有这条状态——那是「不用验」，
 * 不是「没验成」，所以判「要不要验」必须在调用方，不在这里。
 */
export function checkColdVerify(head: string, got: CommitStatus | null, need: ColdVerifyNeed): string[] {
  if (!need.needed) return [];
  const at = `当前头 ${head.slice(0, 7)}`;
  const why = `${need.why}，${at} 上要有通过的 ${COLD_VERIFY_CONTEXT} 状态（specs/555：合之前一次冷调用，换家族验「单子说要的东西真做了没有」）`;
  if (got === null) {
    // 没有这条 = 没验成（不是「等它写」）：装配侧要么没跑、要么写了没写成，两种都不放行。
    return [
      `还没验：${at} 上没有 ${COLD_VERIFY_CONTEXT} 状态，${why}。冷调用那一遍跑完会把结论写上，合并闸自动重算；推了新提交的，旧头上的不算。`,
    ];
  }
  const desc = got.description ? `：${oneLine(got.description)}` : '';
  switch (got.state) {
    case 'success':
      return [];
    case 'pending':
      return [`等验收：${at} 上的 ${COLD_VERIFY_CONTEXT} 还在跑（pending${desc}），${why}。`];
    default:
      return [
        `验收没过：${at} 上的 ${COLD_VERIFY_CONTEXT} 是 ${got.state}${desc}，${why}。按它写的问题改完推上去；第 ${COLD_VERIFY_MAX_ROUND} 轮还不过就得人看（specs/555 第 3 条：默认 1 轮、最多 2 轮）。`,
      ];
  }
}

// —— 合并闸的其余几条和写回 GitHub 的提交状态 ——

/** 合并闸写在 PR 当前头上的提交状态：「按我们的规矩能不能合」的唯一信号。 */
export const GATE_CONTEXT = 'merge-gate';
/** 提交状态的 description 上限（GitHub 限 140 个字符）。 */
export const DESCRIPTION_MAX = 140;

/** description 放第一条，多的写「另有 N 条」；全文在详情链接（这次运行的日志）里。 */
export function statusDescription(lines: readonly string[]): string {
  const first = (lines[0] ?? '').replace(/\s+/g, ' ').trim();
  const more = lines.length > 1 ? `（另有 ${lines.length - 1} 条，点详情看）` : '';
  const room = DESCRIPTION_MAX - [...more].length;
  const chars = [...first];
  const head = chars.length > room ? `${chars.slice(0, room - 1).join('')}…` : first;
  return head + more;
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
