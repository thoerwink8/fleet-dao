// 模块化的会话底部操控台 + 防跑偏提醒卡（零黑话、全组件化）。
import {
  CheckCircle2,
  Compass,
  FolderGit2,
  GitFork,
  PauseCircle,
  PlayCircle,
  Send,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAdeState } from '../lib/ade';
import { API_BASE } from '../lib/api';
import { cn } from '../lib/cn';
import { Chip } from './chip';
import { UiButton, UiInput, UiSegmentedTabs, UiSelect } from './ui-kit';

export interface YskNotice {
  id: string;
  sessionId: string;
  watcherModel: string;
  severity: 'warning' | 'critical';
  message: string;
  steerSuggestion: string;
  outOfScopeFiles?: string[];
}

const DEMO_YSK_BY_SESSION: Readonly<Record<string, YskNotice>> = {
  'cmd-demo-flaky-ci': {
    id: 'ysk-flaky-1',
    sessionId: 'cmd-demo-flaky-ci',
    watcherModel: 'devin/swe-2',
    severity: 'critical',
    message:
      '本来是查测试偶发超时，但它顺手改了 packages/web/src/components/shell.tsx 的导航文字，还删了 1 处测试断言。',
    steerSuggestion:
      '请立即用 git checkout -- packages/web/src/components/shell.tsx 还原范围外导航修改，并恢复原测试 expect 断言。',
    outOfScopeFiles: ['packages/web/src/components/shell.tsx'],
  },
  'cmd-demo-migration': {
    id: 'ysk-mig-1',
    sessionId: 'cmd-demo-migration',
    watcherModel: 'devin/swe-2',
    severity: 'warning',
    message: '正在写迁移脚本，已连读 6 个大文件（已自动压缩省流），注意只改 packages/harness-store 目录。',
    steerSuggestion: '保持在 packages/harness-store 内修改，完成后跑 npx vitest run packages/harness-store。',
  },
};

export function YskHeadsUpCard({
  sessionId,
  onSendSteer,
}: {
  sessionId: string;
  onSendSteer?: (mode: 'steer' | 'queue' | 'jump', text: string) => void;
}) {
  const notice = DEMO_YSK_BY_SESSION[sessionId];
  const [sentText, setSentText] = useState<string | null>(null);

  if (!notice) return null;

  const isCritical = notice.severity === 'critical';
  return (
    <div
      data-testid="ysk-heads-up"
      className={cn(
        'mb-3 rounded-xl border p-3.5 text-xs shadow-xs transition-colors',
        isCritical
          ? 'border-danger/30 bg-danger-soft/75 text-ink'
          : 'border-warning/30 bg-warning-soft/75 text-ink',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 font-semibold">
          <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
            <Sparkles className={cn('size-4 shrink-0', isCritical ? 'text-danger' : 'text-warning')} />
            <span>防跑偏提醒（✦ Heads up · 主 agent）</span>
          </span>
          <Chip tone={isCritical ? 'danger' : 'warning'} mono>
            盯梢 · {notice.watcherModel}
          </Chip>
        </div>
        <div className="flex items-center gap-1.5">
          {sentText ? (
            <span className="inline-flex items-center gap-1 text-2xs font-medium text-brand">
              <CheckCircle2 className="size-3.5" />
              已注入实时 Steer 纠偏
            </span>
          ) : (
            <UiButton
              variant="secondary"
              size="xs"
              icon={<Compass />}
              aria-label="一键发 Steer 纠偏"
              onClick={() => {
                setSentText(notice.steerSuggestion);
                onSendSteer?.('steer', notice.steerSuggestion);
              }}
            >
              一键纠偏
            </UiButton>
          )}
        </div>
      </div>
      <p className="mt-1.5 leading-5 text-ink-2">{notice.message}</p>
    </div>
  );
}

/**
 * 会话底部模块化操控台：项目与分支信息、暂停/复制新分支/完成验收、插话方式（顺手说 / 排着说 / 打断重来）、换模型与思考深度。
 */
export function SessionSteerBar({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const { state: adeState, controlSession } = useAdeState();
  const meta = adeState.sessionMeta[sessionId];
  const ws =
    adeState.workspaces.find((w) => w.id === (meta?.workspaceId ?? adeState.activeWorkspaceId)) ??
    adeState.workspaces[0];

  const [mode, setMode] = useState<'steer' | 'queue' | 'jump'>('steer');
  const [runnerChannel, setRunnerChannel] = useState<string>(meta?.model ?? 'reclaude::claude-opus-5-5');
  const [effort, setEffort] = useState<'low' | 'medium' | 'high' | 'max'>(meta?.effort ?? 'high');
  const [draft, setDraft] = useState('');
  const [ctrlFeedback, setCtrlFeedback] = useState<string | null>(null);
  const [history, setHistory] = useState<
    Array<{
      id: string;
      mode: 'steer' | 'queue' | 'jump';
      text: string;
      channel: string;
      effort: string;
      at: string;
    }>
  >([]);

  const submit = (overrideMode?: 'steer' | 'queue' | 'jump', overrideText?: string) => {
    const text = (overrideText ?? draft).trim();
    if (!text) return;
    const m = overrideMode ?? mode;
    setHistory((prev) => [
      ...prev,
      {
        id: `steer-${Date.now()}-${prev.length}`,
        mode: m,
        text,
        channel: runnerChannel,
        effort,
        at: new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }),
      },
    ]);
    if (!overrideText) setDraft('');
    void fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/steer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: m, text, channel: runnerChannel, effort }),
    }).catch(() => undefined);
  };

  const handleModelSwitch = (nextModel: string) => {
    setRunnerChannel(nextModel);
    void controlSession(sessionId, { action: 'switch-config', model: nextModel, effort });
  };

  const handleEffortSwitch = (nextEffort: 'low' | 'medium' | 'high' | 'max') => {
    setEffort(nextEffort);
    void controlSession(sessionId, { action: 'switch-config', model: runnerChannel, effort: nextEffort });
  };

  const handleSessionAction = async (action: 'pause' | 'resume' | 'complete' | 'fork') => {
    const res = await controlSession(sessionId, {
      action,
      model: runnerChannel,
      effort,
      prompt: draft.trim() || undefined,
    });
    if (action === 'fork' && res.forkedSessionId) {
      void navigate(`/s/${encodeURIComponent(res.forkedSessionId)}`);
      return;
    }
    setCtrlFeedback(
      action === 'pause'
        ? '已暂停会话'
        : action === 'resume'
          ? '已恢复运行'
          : action === 'complete'
            ? '已标记完成'
            : '已生效',
    );
  };

  const isPaused = meta?.statusOverride === 'paused' || meta?.statusOverride === 'stopped';

  return (
    <div className="shrink-0 border-t border-line bg-surface px-4 py-3 md:px-6" data-testid="steer-composer">
      <YskHeadsUpCard sessionId={sessionId} onSendSteer={(m, t) => submit(m, t)} />

      {/* 顶部状态与动作栏 */}
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line/70 bg-subtle/60 px-3 py-2 text-xs">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-ink-2">
          <span className="inline-flex items-center gap-1.5 font-medium text-ink">
            <FolderGit2 className="size-3.5 text-brand" />
            <span className="truncate">{ws?.name ?? 'fleet-dao'}</span>
          </span>
          <span className="text-muted">·</span>
          <span className="font-mono text-2xs text-muted">{meta?.branch ?? `work/${sessionId}`}</span>
          {meta?.writeScope ? (
            <Chip mono className="hidden sm:inline-flex">
              目录: {meta.writeScope}
            </Chip>
          ) : null}
          {ctrlFeedback ? <Chip tone="brand">{ctrlFeedback}</Chip> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {isPaused ? (
            <UiButton
              variant="soft"
              size="xs"
              icon={<PlayCircle />}
              onClick={() => void handleSessionAction('resume')}
            >
              继续跑
            </UiButton>
          ) : (
            <UiButton
              variant="secondary"
              size="xs"
              icon={<PauseCircle />}
              onClick={() => void handleSessionAction('pause')}
            >
              暂停
            </UiButton>
          )}
          <UiButton
            variant="secondary"
            size="xs"
            icon={<GitFork />}
            onClick={() => void handleSessionAction('fork')}
          >
            复制出新会话
          </UiButton>
          <UiButton
            variant="secondary"
            size="xs"
            icon={<CheckCircle2 />}
            onClick={() => void handleSessionAction('complete')}
          >
            标为做完
          </UiButton>
        </div>
      </div>

      {history.length > 0 ? (
        <ul className="mb-2.5 flex flex-col gap-1" data-testid="steer-sent-list">
          {history.map((h) => (
            <li
              key={h.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-line/60 bg-subtle px-3 py-1.5 text-2xs text-ink-2"
            >
              <span className="truncate">
                <strong className="font-medium text-brand">
                  [
                  {h.mode === 'steer'
                    ? '顺手引导 (实时引导 Steer)'
                    : h.mode === 'jump'
                      ? '打断重来 (紧急插队 Jump)'
                      : '排着说 (排队 Queue)'}
                  ]
                </strong>{' '}
                {h.text}
              </span>
              <span className="num shrink-0 font-mono text-muted">
                {h.channel.split('::')[1] ?? h.channel} ({h.effort}) · {h.at}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* 模式切换与模型/思考深度 */}
      <div className="flex flex-wrap items-center gap-2.5">
        <UiSegmentedTabs
          ariaLabel="发送模式"
          value={mode}
          onChange={setMode}
          options={
            [
              ['steer', '顺手引导 (Steer)'],
              ['queue', '做完这步再说 (Queue)'],
              ['jump', '立即打断 (Jump)'],
            ] as const
          }
        />

        <label
          htmlFor="steer-model-select"
          className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-xs text-muted"
        >
          <span className="shrink-0 whitespace-nowrap">换模型</span>
          <UiSelect
            id="steer-model-select"
            aria-label="切换会话引擎与模型"
            value={runnerChannel}
            onChange={(e) => handleModelSwitch(e.target.value)}
            className="h-7.5 min-w-0 flex-1 truncate font-mono text-2xs"
          >
            {adeState.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </UiSelect>
        </label>

        <label htmlFor="steer-effort-select" className="inline-flex items-center gap-1.5 text-xs text-muted">
          <span className="shrink-0 whitespace-nowrap">思考深度</span>
          <UiSelect
            id="steer-effort-select"
            aria-label="切换会话思考档位"
            value={effort}
            onChange={(e) => handleEffortSwitch(e.target.value as 'low' | 'medium' | 'high' | 'max')}
            className="h-7.5 w-24 font-mono text-2xs"
          >
            <option value="low">快速 (low)</option>
            <option value="medium">标准 (medium)</option>
            <option value="high">深入 (high)</option>
            <option value="max">极限 (max)</option>
          </UiSelect>
        </label>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="mt-2.5 flex items-center gap-2"
      >
        <UiInput
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="随时跟它说话、补充要求或纠偏…"
          aria-label="会话引导输入"
          className="flex-1 bg-subtle/60"
        />
        <UiButton type="submit" variant="primary" icon={<Send />}>
          发送
        </UiButton>
      </form>
    </div>
  );
}
