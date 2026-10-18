// 「要你拍」选完以后按选项上的动作执行（#2353：整池暂停/放开、重查、移出仓、留着；删工作树交给引擎），结果写回这张卡。
// 自己写的、以及没有具体动作的（note-only，含老数据没写 action）仍交给指挥官（decision-handoff）。
// 执行成功才由调用方 settleDecision 标已处理；失败把原因写上卡，resolved_at 留空。
// 改这里之前必须知道：删工作树要 sudo 调 fleet-agent-scope，驾驶舱后端的单元开着 NoNewPrivileges、提不了权，
// 所以这里只记「交给引擎」（execution.queued），由引擎每小时对账的工作树那一段删、再把结果写回（engine 的 worktree-sweep.ts）。
import type { FeishuPushFacts } from '@fleet-dao/db';
import { feishuPushProblem } from '@fleet-dao/db';
import type { RepoRef, SelfCheckItem } from '@fleet-dao/github';
import {
  acceptPoolHoldsWrite,
  answerResolves,
  type DecisionAction,
  HANDED_TO_COMMANDER,
  POOL_HOLDS_SETTING,
  PoolHoldSchema,
  REPO_IMPORT_REMOVE,
  readDecisionAction,
  revocationProblem,
  WORKTREE_DELETE_QUEUED,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { HandoffResult } from './decision-handoff.ts';
import type { Actor, AuditVia, NotificationRecord, Store } from './ports.ts';

/** 重查要本机能力。没接上（开发环境）时对应动作失败，卡留着并写明没接上。暂停、放开、移出仓、留着只靠库。 */
export interface DecisionCapabilities {
  /** 再查这个仓的两个 GitHub App。还没装好、没查成抛错。 */
  recheckGitHubApp(repo: string): Promise<void>;
  /** 再读飞书推送。还不通抛错。 */
  recheckFeishuPush(): Promise<void>;
}

/** 每种动作一个口。执行器按 kind 只调对应的那一个；测试用它断言调到了。 */
export interface DecisionActionPorts {
  /** 把删这棵树交给引擎（真端口只核路径：答案已经落库，引擎按答案删）。 */
  deleteWorktree(path: string): Promise<void>;
  keep(): Promise<void>;
  pausePool(poolId: string): Promise<void>;
  resumePool(poolId: string): Promise<void>;
  recheck(action: Extract<DecisionAction, { kind: 'recheck' }>): Promise<void>;
  dropRepo(repo: { owner: string; name: string }): Promise<void>;
  /** 交给指挥官。进度单没写成就抛（话是原因）；任务单没写成不抛。 */
  noteOnly(): Promise<void>;
}

export type DecisionHandoff = { progress: HandoffResult; task?: HandoffResult };

const clip = (text: string, max: number): string => {
  const trimmed = text.trim();
  const body = trimmed.length > 0 ? trimmed : '没做成，没说为什么';
  return body.length > max ? `${body.slice(0, max - 1)}…` : body;
};

/** 已核实没有写入的拒绝；普通写口异常可能发生在提交之后。 */
class DecisionNotApplied extends Error {}

/**
 * 按动作执行。抛错收成失败（text 是原因，最长 500 字），不往外抛。
 * 重查 GitHub App 没写仓：在调端口之前失败。
 */
export async function executeDecisionAction(
  action: DecisionAction,
  ports: DecisionActionPorts,
): Promise<{ ok: boolean; text: string; queued?: true; unknown?: true }> {
  try {
    switch (action.kind) {
      case 'delete-worktree':
        await ports.deleteWorktree(action.path);
        return { ok: true, queued: true, text: WORKTREE_DELETE_QUEUED };
      case 'keep':
        await ports.keep();
        return { ok: true, text: '记下留着：这条转已处理，之后不再提醒' };
      case 'pause-pool':
        await ports.pausePool(action.poolId);
        return { ok: true, text: `账号池 ${action.poolId} 已整池暂停` };
      case 'resume-pool':
        await ports.resumePool(action.poolId);
        return { ok: true, text: `账号池 ${action.poolId} 已放开` };
      case 'recheck': {
        if (action.what === 'github-app' && !action.repo) throw new Error('重查 GitHub App 要写是哪个仓');
        await ports.recheck(action);
        return {
          ok: true,
          text:
            action.what === 'github-app'
              ? `已重查 ${action.repo} 的 GitHub App，装好了`
              : '已重查飞书推送，通了',
        };
      }
      case 'drop-repo':
        await ports.dropRepo({ owner: action.owner, name: action.name });
        return { ok: true, text: `已把 ${action.owner}/${action.name} 移出监控` };
      case 'note-only':
        await ports.noteOnly();
        return { ok: true, text: HANDED_TO_COMMANDER };
    }
  } catch (err) {
    const writes =
      action.kind === 'pause-pool' || action.kind === 'resume-pool' || action.kind === 'drop-repo';
    const unknown = writes && !(err instanceof DecisionNotApplied);
    return {
      ok: false,
      text: clip(
        unknown ? `执行结果未知，请核实现场，不能自动重试：${errMessage(err)}` : errMessage(err),
        500,
      ),
      ...(unknown ? { unknown: true as const } : {}),
    };
  }
}

/** 点的选项上的动作；自己写的一律 note-only。老选项没写 action 也是 note-only。 */
export function actionOfAnswer(
  notification: Pick<NotificationRecord, 'options'>,
  optionId: string | undefined,
): DecisionAction {
  if (optionId === undefined) return { kind: 'note-only' };
  return readDecisionAction(notification.options?.find((o) => o.id === optionId));
}

/**
 * 答案已经落库之后：执行，并算出要不要标已处理（做成了、不是交给引擎的、且这一项不带 keepsOpen）。
 * note-only 的交接结果由端口的 handOff 交给调用方，调用方拿它回给页面。
 */
export async function applyDecisionAnswer(input: {
  notification: NotificationRecord;
  optionId: string | undefined;
  ports: DecisionActionPorts;
}): Promise<{ executed: { ok: boolean; text: string; queued?: true; unknown?: true }; resolve: boolean }> {
  const action = actionOfAnswer(input.notification, input.optionId);
  const executed = await executeDecisionAction(action, input.ports);
  return {
    executed,
    resolve: executed.ok && !executed.queued && answerResolves(input.notification.options, input.optionId),
  };
}

type HoldsValue = Record<string, unknown> | 'empty' | 'corrupt';

function holdsValue(value: unknown): HoldsValue {
  if (value === undefined || value === null) return 'empty';
  if (typeof value !== 'object' || Array.isArray(value)) return 'corrupt';
  return value as Record<string, unknown>;
}

async function writeHolds(
  store: Store,
  actor: Actor,
  via: AuditVia,
  before: { value: unknown; version: number } | undefined,
  next: Record<string, unknown>,
  reason: string,
): Promise<void> {
  const accepted = acceptPoolHoldsWrite(before?.value, next);
  if (!accepted.ok) throw new DecisionNotApplied(accepted.message);
  const problem = revocationProblem(before?.value, accepted.value, reason);
  if (problem) throw new DecisionNotApplied(problem);
  const result = await store.putSetting(
    {
      key: POOL_HOLDS_SETTING,
      value: accepted.value,
      expectedVersion: before?.version ?? 0,
      by: actor,
    },
    {
      actor,
      action: 'setting.update',
      target: `setting:${POOL_HOLDS_SETTING}`,
      before: before?.value,
      after: accepted.value,
      reason,
      via,
      ok: true,
    },
  );
  if (result === 'conflict') throw new DecisionNotApplied('整池暂停刚被别人改过，再选一次');
}

/**
 * 真端口：暂停/放开写 engine.poolHolds（写上之后提醒可以转已处理，探针撤不掉这个开关）；
 * 移出仓走 removeRepo；留着是空操作（处理人不是对账，扫树才认「人决定留着」）；
 * 删树只核路径（引擎按答案删）；重查走 capabilities，没接上抛「没接上」。
 */
export function liveDecisionPorts(input: {
  store: Store;
  actor: Actor;
  via: AuditVia;
  capabilities?: DecisionCapabilities | undefined;
  handOff: () => Promise<DecisionHandoff>;
}): DecisionActionPorts {
  const { store, actor, via } = input;
  const setting = async () => (await store.listSettings()).find((s) => s.key === POOL_HOLDS_SETTING);
  return {
    async deleteWorktree(path) {
      if (!path.startsWith('/')) throw new Error(`工作树的路径认不出（要绝对路径）：${path}`);
    },
    async keep() {
      // 处理人写成拍板的人，扫树看见不是对账自己撤的就不再报。这里没有别的要写的。
    },
    async pausePool(poolId) {
      const current = await setting();
      const map = holdsValue(current?.value);
      if (map === 'corrupt') {
        throw new DecisionNotApplied(`设置 ${POOL_HOLDS_SETTING} 的值不是 {池编号: 条目}，整池暂停写不进去`);
      }
      const prior = map === 'empty' ? {} : map;
      if (PoolHoldSchema.safeParse(prior[poolId]).success) return;
      const reason = `驾驶舱「让我拍」选了先停着（账号池 ${poolId}）`;
      await writeHolds(
        store,
        actor,
        via,
        current,
        {
          ...prior,
          [poolId]: {
            reason,
            decidedBy: `驾驶舱用户 ${actor.id}`,
            revokeWhen: '创始人在这条上选「修好了，放开」',
          },
        },
        reason,
      );
    },
    async resumePool(poolId) {
      const current = await setting();
      const map = holdsValue(current?.value);
      if (map === 'empty') return;
      if (map === 'corrupt') {
        throw new DecisionNotApplied(`设置 ${POOL_HOLDS_SETTING} 的值不是 {池编号: 条目}，放开写不进去`);
      }
      if (!Object.hasOwn(map, poolId)) return;
      const reason = `驾驶舱「让我拍」选了放开账号池 ${poolId}`;
      const { [poolId]: _removed, ...rest } = map;
      await writeHolds(store, actor, via, current, rest, reason);
    },
    async recheck(action) {
      if (action.what === 'github-app') {
        if (!action.repo) throw new Error('重查 GitHub App 要写是哪个仓');
        if (!input.capabilities?.recheckGitHubApp) throw new Error('重查 GitHub App 没接上');
        await input.capabilities.recheckGitHubApp(action.repo);
        return;
      }
      if (!input.capabilities?.recheckFeishuPush) throw new Error('重查飞书推送没接上');
      await input.capabilities.recheckFeishuPush();
    },
    async dropRepo({ owner, name }) {
      const repo = (await store.listRepos()).find((r) => r.owner === owner && r.name === name);
      if (!repo) throw new DecisionNotApplied(`受管的仓里没有 ${owner}/${name}`);
      const outcome = await store.removeRepo(
        { repoId: repo.id },
        {
          actor,
          action: REPO_IMPORT_REMOVE,
          target: `repo:${owner}/${name}`.toLowerCase(),
          reason: `驾驶舱「让我拍」把 ${owner}/${name} 移出监控`,
          via,
          ok: true,
        },
      );
      if (outcome === 'not_found') throw new DecisionNotApplied(`受管的仓里没有 ${owner}/${name}`);
      if (outcome === 'has_tasks')
        throw new DecisionNotApplied('这个仓还挂着没结束的需求，先把它们处理掉再移出');
    },
    async noteOnly() {
      const handoff = await input.handOff();
      if (!handoff.progress.ok) throw new Error(handoff.progress.why);
    },
  };
}

/** 重查 GitHub App。凭据没接上、仓名不是 owner/name、还没装好、没查成，都抛给人看的原因。 */
export async function runGitHubAppRecheck(
  selfCheck: ((repos: RepoRef[]) => Promise<SelfCheckItem[]>) | undefined,
  repo: string,
): Promise<void> {
  if (!selfCheck) throw new Error('GitHub 机器人的凭据没读到，重查不了');
  const slash = repo.indexOf('/');
  const owner = slash > 0 ? repo.slice(0, slash) : '';
  const name = slash > 0 ? repo.slice(slash + 1) : '';
  if (!owner || !name || name.includes('/')) {
    throw new Error(`重查 GitHub App 的仓要写成 owner/name：${repo}`);
  }
  const items = await selfCheck([{ owner, name }]);
  const slug = `${owner}/${name}`;
  const mine = items.filter((item) => item.repo === slug);
  if (mine.length === 0) throw new Error(`没查到 ${repo}`);
  const bad = mine.filter((item) => !item.ok || item.notInstalled || item.why);
  if (bad.length === 0) return;
  throw new Error(
    bad
      .map(
        (item) =>
          item.why ??
          (item.notInstalled ? `${item.role} 还没装到 ${repo}` : `${item.role} 在 ${repo} 上还不对`),
      )
      .join('；'),
  );
}

/** 重查飞书推送。不通抛那句原因（和看门狗同一份判法）；通着不抛。 */
export async function runFeishuPushRecheck(facts: FeishuPushFacts, now: Date): Promise<void> {
  const problem = feishuPushProblem(facts, now);
  if (problem) throw new Error(problem);
}
