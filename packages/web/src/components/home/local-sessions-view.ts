// 主页「本机会话」（#1991）怎么写给人看：创始人电脑上在跑的 AI 会话，四种状态——在跑、刚停、超过阈值没动、没上报。
// 数据：GET /nodes/sessions（本机钩子写心跳、计划任务每 2 分钟推到法国，shared/web-api/local-sessions.ts 文件头）。
// 和画布上「在跑的」（引擎的单）分开放：这是本机会话，不是引擎派的活。
//
// 改这里之前必须知道：
// - 收不到（stale：超过 5 分钟没推来；never：配了钥匙从没推过）一律写「没上报」和上次收到在多久前，不画成 0 个会话。
//   stale 时那时候的会话照列、灰着，状态字改成「上次看到」——不冒充现在还在跑。
// - 法国没配钥匙（notWired）写「没接上」和原因。
import type { LocalSessions, LocalSessionView } from '../../api/types';
import { formatAgo, formatDuration } from '../../lib/format';
import type { LayoutTone } from '../layout/tone';

export interface SessionLine {
  key: string;
  /** 主信息：仓（没在 git 仓里写「不在仓里」）。 */
  title: string;
  /** 小字：分支 · 工作树 · 子代理类型 · 最后在调的工具。 */
  meta: string;
  label: string;
  tone: LayoutTone;
  /** 「3 分钟没动」「刚停 4 分钟」「起了 1 小时 35 分」这类短话。 */
  when: string;
}

export interface NodeBlock {
  id: string;
  machine: string;
  /** fresh 在上报；其余写没上报。 */
  reporting: boolean;
  /** 没上报的原因（上次收到在多久前 / 从没收到）。 */
  why?: string;
  lines: SessionLine[];
  problems: string[];
}

export type LocalView =
  | { kind: 'ok'; nodes: NodeBlock[]; running: number; reporting: boolean }
  | { kind: 'notWired'; why: string }
  | { kind: 'empty'; why: string };

const STATE: Record<LocalSessionView['state'], { label: string; tone: LayoutTone }> = {
  running: { label: '在跑', tone: 'run' },
  stopped: { label: '刚停', tone: 'done' },
  idle: { label: '超过 15 分钟没动', tone: 'stall' },
};

function line(s: LocalSessionView, reporting: boolean, now: number): SessionLine {
  const st = STATE[s.state];
  const meta = [
    s.branch ?? '分离头',
    s.worktree ? `工作树 ${s.worktree}` : '主检出',
    s.subagent ? `子代理${s.agentType ? ` ${s.agentType}` : ''}` : null,
    s.lastTool ? `最后在调 ${s.lastTool}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const when =
    s.state === 'stopped'
      ? `停了 ${formatDuration(s.idleMs)}`
      : s.state === 'idle'
        ? `${formatDuration(s.idleMs)}没动`
        : `起了 ${formatDuration(now - Date.parse(s.startedAt))}`;
  return {
    key: s.id,
    title: s.repo ?? '不在仓里',
    meta,
    // 没上报时这是那时候的样子：不冒充此刻还在跑
    label: reporting ? st.label : '上次看到',
    tone: reporting ? st.tone : 'stop',
    when,
  };
}

const ORDER: Record<LocalSessionView['state'], number> = { running: 0, idle: 1, stopped: 2 };

export function localView(data: LocalSessions, now: number): LocalView {
  if (data.notWired) return { kind: 'notWired', why: data.notWired };
  if (data.nodes.length === 0) {
    return {
      kind: 'empty',
      why: '法国还没收到过任何一台推来的本机会话，也没配本机的通行证（装法见 docs/ops.md「本机会话上报」）',
    };
  }
  const nodes = data.nodes.map((n): NodeBlock => {
    const reporting = n.freshness === 'fresh';
    const why =
      n.freshness === 'never'
        ? '没上报：配了通行证，但一次都没收到（本机还没装，或计划任务推不出去）'
        : n.freshness === 'stale' && n.receivedAt
          ? `没上报：上次收到是 ${formatAgo(n.receivedAt, now)}（本机该每 2 分钟推一次：可能关机了、断网了，或计划任务停了）`
          : undefined;
    return {
      id: n.id,
      machine: n.machine ?? n.id,
      reporting,
      ...(why ? { why } : {}),
      lines: [...n.sessions]
        .sort((a, b) => ORDER[a.state] - ORDER[b.state])
        .map((s) => line(s, reporting, now)),
      problems: n.problems,
    };
  });
  const running = data.nodes
    .filter((n) => n.freshness === 'fresh')
    .reduce((k, n) => k + n.sessions.filter((s) => s.state === 'running').length, 0);
  return { kind: 'ok', nodes, running, reporting: nodes.every((n) => n.reporting) };
}

/** 抽屉按钮、手机横条上的一句：「本机 2 在跑」「本机没上报」。 */
export function localBrief(v: LocalView | undefined): { text: string; tone: LayoutTone | undefined } {
  if (!v) return { text: '本机', tone: undefined };
  if (v.kind !== 'ok') return { text: '本机没接上', tone: 'stop' };
  if (!v.reporting) return { text: '本机没上报', tone: 'stall' };
  return { text: `本机 ${v.running} 在跑`, tone: v.running > 0 ? 'run' : undefined };
}
