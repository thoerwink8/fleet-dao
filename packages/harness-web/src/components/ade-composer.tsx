// 模块化、大白话的「新建会话 & 项目管理」组件。
// 遵循减法与零术语原则：所有配置使用统一 UI 组件（UiCard / UiSectionHeader / UiButton / UiField / UiInput / UiSelect），
// 把晦涩术语全部改为直白中文：项目目录、任务类型、模型、思考深度、运行机器、可改目录。
import {
  CheckCircle2,
  FolderGit2,
  GitBranch,
  Plus,
  Rocket,
  Server,
  ShieldCheck,
  Sliders,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAdeState } from '../lib/ade';
import { cn } from '../lib/cn';
import { Chip } from './chip';
import { UiButton, UiCard, UiField, UiInput, UiSectionHeader, UiSelect } from './ui-kit';

const AGENT_ROLES = [
  {
    id: 'worker-code',
    label: '写代码 · 修问题',
    desc: '自动定位代码、修改并跑测试验证',
    defaultModel: 'kiro::kiro-claude-sonnet',
    defaultEffort: 'high' as const,
  },
  {
    id: 'commander',
    label: '拆任务 · 总调度',
    desc: '把大需求拆成并行小任务，分派给各台机器',
    defaultModel: 'reclaude::claude-opus-5-5',
    defaultEffort: 'high' as const,
  },
  {
    id: 'worker-ui',
    label: '改界面 · 做组件',
    desc: '组件化还原设计，自动检查电脑与手机端排版',
    defaultModel: 'antigravity::gemini-3.1-pro',
    defaultEffort: 'medium' as const,
  },
  {
    id: 'planner',
    label: '定方案 · 查根因',
    desc: '只读分析代码与报错，给出清晰方案，不改文件',
    defaultModel: 'recodex::gpt-5.3-codex',
    defaultEffort: 'max' as const,
  },
  {
    id: 'scout',
    label: '快速找代码',
    desc: '20 秒找出相关文件与行号，省流量',
    defaultModel: 'devin::devin-swe-2',
    defaultEffort: 'low' as const,
  },
  {
    id: 'verifier',
    label: '独立验收审查',
    desc: '换另一家模型挑错，检查有没有漏改或改坏',
    defaultModel: 'recodex::gpt-5.3-codex',
    defaultEffort: 'high' as const,
  },
] as const;

const HOST_OPTIONS = [
  { id: 'desktop-win', label: '本机电脑 (Windows)' },
  { id: 'vps-france', label: '云端主机 #1 (Linux VPS)' },
  { id: 'corp-intranet-01', label: '公司内网机 (SSH 隧道)' },
] as const;

const QUICK_TEMPLATES = [
  {
    label: '排查测试报错',
    prompt: '定位最近失败的测试或类型错误，修复根因并运行 pnpm check 验证通过。',
    role: 'worker-code',
    scope: 'packages/**',
  },
  {
    label: '拆解新需求',
    prompt: '分析当前项目代码结构，把需求拆成互不冲突的几步并行任务。',
    role: 'commander',
    scope: 'specs/**',
  },
  {
    label: '打磨界面与组件',
    prompt: '用统一的模块化组件重构当前页面，去掉晦涩术语，确保电脑与手机端干净对齐。',
    role: 'worker-ui',
    scope: 'packages/harness-web/**',
  },
] as const;

export function AdeNewSessionComposer({ onCreated }: { onCreated?: (sessionId: string) => void } = {}) {
  const navigate = useNavigate();
  const { state, addWorkspace, selectWorkspace, createSession } = useAdeState();

  const activeWs = state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? state.workspaces[0];

  const [role, setRole] = useState<string>('worker-code');
  const [model, setModel] = useState<string>('reclaude::claude-opus-5-5');
  const [effort, setEffort] = useState<'low' | 'medium' | 'high' | 'max'>('high');
  const [hostId, setHostId] = useState<string>(activeWs?.hostId ?? 'desktop-win');
  const [writeScope, setWriteScope] = useState<string>('packages/**');
  const [branch, setBranch] = useState<string>('feat/ade-task');
  const [yskEnabled, setYskEnabled] = useState<boolean>(true);
  const [prompt, setPrompt] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  const [showAddWs, setShowAddWs] = useState(false);
  const [wsName, setWsName] = useState('');
  const [wsPath, setWsPath] = useState('');
  const [wsBranch, setWsBranch] = useState('main');
  const [wsCheckCmd, setWsCheckCmd] = useState('pnpm check');
  const [wsHostId, setWsHostId] = useState('desktop-win');
  const [wsKind, setWsKind] = useState<'self' | 'external'>('self');
  const [wsAddedBanner, setWsAddedBanner] = useState<string | null>(null);

  const handleRoleChange = (nextRole: string) => {
    setRole(nextRole);
    const preset = AGENT_ROLES.find((r) => r.id === nextRole);
    if (preset) {
      setModel(preset.defaultModel);
      setEffort(preset.defaultEffort);
    }
  };

  const handleAddWorkspace = (e: React.FormEvent) => {
    e.preventDefault();
    const name = wsName.trim();
    const path = wsPath.trim();
    if (!name || !path) return;
    setWsName('');
    setWsPath('');
    setShowAddWs(false);
    setWsAddedBanner(`已添加并切换到工作区「${name}」(${path})`);
    void addWorkspace({
      name,
      path,
      gitUrl: path,
      defaultBranch: wsBranch.trim() || 'main',
      checkCmd: wsCheckCmd.trim() || 'pnpm check',
      hostId: wsHostId,
      repoKind: wsKind,
    }).then((created) => setHostId(created.hostId));
  };

  const handleLaunchSession = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = prompt.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      const sid = await createSession({
        prompt: text,
        workspaceId: activeWs?.id ?? 'ws-fleet-dao',
        role,
        model,
        effort,
        hostId,
        writeScope: writeScope.trim() || 'packages/**',
        yskEnabled,
        branch: branch.trim() || 'feat/ade-task',
      });
      setPrompt('');
      onCreated?.(sid);
      void navigate(`/s/${encodeURIComponent(sid)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 pb-20 md:p-6" data-testid="ade-new-session-composer">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
        {/* 模块 1：项目 / 工作区选择 */}
        <UiCard aria-label="工作区管理栏">
          <UiSectionHeader
            icon={<FolderGit2 />}
            title="选择项目（工作区）"
            subtitle="切换当前要改的代码目录，或添加本机/远端新项目"
            action={
              <UiButton variant="soft" size="sm" icon={<Plus />} onClick={() => setShowAddWs((v) => !v)}>
                {showAddWs ? '收起' : '添加工作区'}
              </UiButton>
            }
          />

          {wsAddedBanner ? (
            <div
              role="status"
              className="mt-3 flex items-center gap-2 rounded-lg border border-brand/25 bg-brand-soft px-3 py-2 text-xs text-brand-strong"
            >
              <CheckCircle2 className="size-4 shrink-0" />
              <span>{wsAddedBanner}</span>
            </div>
          ) : null}

          <div className="mt-3.5 grid gap-3 sm:grid-cols-3">
            {state.workspaces.map((w) => {
              const selected = w.id === activeWs?.id;
              return (
                <button
                  key={w.id}
                  type="button"
                  data-testid={`workspace-option-${w.id}`}
                  onClick={() => {
                    void selectWorkspace(w.id);
                    setHostId(w.hostId);
                  }}
                  aria-pressed={selected}
                  className={cn(
                    'flex cursor-pointer flex-col items-start rounded-xl border p-3.5 text-left transition-all',
                    selected
                      ? 'border-brand bg-brand-soft/35 shadow-xs ring-1 ring-brand/25'
                      : 'border-line bg-subtle/40 hover:border-line-strong hover:bg-subtle',
                  )}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold text-ink">{w.name}</span>
                    <Chip mono>{w.defaultBranch}</Chip>
                  </div>
                  <div className="mt-1 w-full truncate font-mono text-2xs text-ink-2" title={w.path}>
                    {w.path}
                  </div>
                  <div className="mt-2 flex w-full items-center justify-between border-t border-line/60 pt-2 text-2xs text-muted">
                    <span className="truncate font-mono">检查: {w.checkCmd}</span>
                    <span>{w.repoKind === 'external' ? '公司仓' : '自用仓'}</span>
                  </div>
                </button>
              );
            })}
          </div>

          {showAddWs ? (
            <form
              onSubmit={handleAddWorkspace}
              data-testid="add-workspace-form"
              className="mt-4 grid gap-3 rounded-xl border border-brand/25 bg-subtle/60 p-4 sm:grid-cols-3"
            >
              <UiField label="项目名称" htmlFor="ws-name-input">
                <UiInput
                  id="ws-name-input"
                  aria-label="工作区名称"
                  value={wsName}
                  onChange={(e) => setWsName(e.target.value)}
                  placeholder="例如：计费中心"
                />
              </UiField>
              <UiField label="目录路径或仓库地址" htmlFor="ws-path-input">
                <UiInput
                  id="ws-path-input"
                  aria-label="工作区路径"
                  value={wsPath}
                  onChange={(e) => setWsPath(e.target.value)}
                  placeholder="例如：D:/work/billing"
                  className="font-mono"
                />
              </UiField>
              <UiField label="验证命令" htmlFor="ws-check-input">
                <UiInput
                  id="ws-check-input"
                  aria-label="工作区门禁命令"
                  value={wsCheckCmd}
                  onChange={(e) => setWsCheckCmd(e.target.value)}
                  placeholder="pnpm check"
                  className="font-mono"
                />
              </UiField>
              <UiField label="默认分支" htmlFor="ws-branch-input">
                <UiInput
                  id="ws-branch-input"
                  aria-label="工作区默认分支"
                  value={wsBranch}
                  onChange={(e) => setWsBranch(e.target.value)}
                  className="font-mono"
                />
              </UiField>
              <UiField label="运行机器" htmlFor="ws-host-select">
                <UiSelect
                  id="ws-host-select"
                  aria-label="工作区绑定主机"
                  value={wsHostId}
                  onChange={(e) => setWsHostId(e.target.value)}
                >
                  {HOST_OPTIONS.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.label}
                    </option>
                  ))}
                </UiSelect>
              </UiField>
              <div className="flex items-end gap-2">
                <UiField label="仓库类型" className="flex-1">
                  <UiSelect
                    aria-label="工作区仓库性质"
                    value={wsKind}
                    onChange={(e) => setWsKind(e.target.value as 'self' | 'external')}
                  >
                    <option value="self">自用项目</option>
                    <option value="external">公司/对外项目（不带 AI 署名）</option>
                  </UiSelect>
                </UiField>
                <UiButton type="submit" variant="primary">
                  保存工作区
                </UiButton>
              </div>
            </form>
          ) : null}
        </UiCard>

        {/* 模块 2：发起新会话 */}
        <UiCard aria-label="发起新会话工作台">
          <UiSectionHeader
            icon={<Rocket />}
            title="发任务 / 新建会话"
            subtitle="选好要做什么、用哪个模型、在哪台机器跑，直接交代任务"
            action={
              <div className="flex flex-wrap items-center gap-1.5">
                {QUICK_TEMPLATES.map((tpl) => (
                  <UiButton
                    key={tpl.label}
                    variant="secondary"
                    size="xs"
                    onClick={() => {
                      handleRoleChange(tpl.role);
                      setWriteScope(tpl.scope);
                      setPrompt(tpl.prompt);
                    }}
                  >
                    + {tpl.label}
                  </UiButton>
                ))}
              </div>
            }
          />

          <form onSubmit={(e) => void handleLaunchSession(e)} className="mt-4 flex flex-col gap-4">
            {/* 任务类型 */}
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {AGENT_ROLES.map((r) => {
                const on = role === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => handleRoleChange(r.id)}
                    aria-pressed={on}
                    data-testid={`role-option-${r.id}`}
                    className={cn(
                      'flex cursor-pointer flex-col items-start rounded-xl border p-3 text-left transition-all',
                      on
                        ? 'border-brand bg-brand-soft/35 text-ink shadow-xs ring-1 ring-brand/25'
                        : 'border-line bg-subtle/40 text-ink-2 hover:border-line-strong hover:bg-subtle',
                    )}
                  >
                    <span className="text-xs font-semibold text-ink">{r.label}</span>
                    <span className="mt-1 text-2xs leading-4 text-muted">{r.desc}</span>
                  </button>
                );
              })}
            </div>

            {/* 模型、思考深度、机器、可改目录 */}
            <div className="grid gap-3 rounded-xl border border-line/70 bg-subtle/50 p-3.5 sm:grid-cols-2 lg:grid-cols-4">
              <UiField
                label={
                  <span className="inline-flex items-center gap-1">
                    <Sliders className="size-3.5 text-brand" />
                    使用模型
                  </span>
                }
                htmlFor="ade-model-select"
              >
                <UiSelect
                  id="ade-model-select"
                  aria-label="新建会话选择模型"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="font-mono text-2xs"
                >
                  {state.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </UiSelect>
              </UiField>

              <UiField
                label={
                  <span className="inline-flex items-center gap-1">
                    <Sparkles className="size-3.5 text-brand" />
                    思考深度
                  </span>
                }
                htmlFor="ade-effort-select"
              >
                <UiSelect
                  id="ade-effort-select"
                  aria-label="新建会话思考档位"
                  value={effort}
                  onChange={(e) => setEffort(e.target.value as 'low' | 'medium' | 'high' | 'max')}
                >
                  <option value="low">快速 (省额度)</option>
                  <option value="medium">标准</option>
                  <option value="high">深入思考 (推荐)</option>
                  <option value="max">极限攻坚 (查疑难)</option>
                </UiSelect>
              </UiField>

              <UiField
                label={
                  <span className="inline-flex items-center gap-1">
                    <Server className="size-3.5 text-brand" />
                    运行机器
                  </span>
                }
                htmlFor="ade-host-select"
              >
                <UiSelect
                  id="ade-host-select"
                  aria-label="新建会话目标主机"
                  value={hostId}
                  onChange={(e) => setHostId(e.target.value)}
                >
                  {HOST_OPTIONS.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.label}
                    </option>
                  ))}
                </UiSelect>
              </UiField>

              <UiField
                label={
                  <span className="inline-flex items-center gap-1">
                    <GitBranch className="size-3.5 text-brand" />
                    只允许改哪些目录
                  </span>
                }
                htmlFor="ade-scope-input"
              >
                <UiInput
                  id="ade-scope-input"
                  aria-label="新建会话写范围锁"
                  value={writeScope}
                  onChange={(e) => setWriteScope(e.target.value)}
                  placeholder="packages/**"
                  className="font-mono text-2xs"
                />
              </UiField>
            </div>

            <textarea
              aria-label="新建会话任务描述"
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="直接写你要做的事，比如：把订单页面的筛选做成组件，并加上单测…"
              className="w-full rounded-xl border border-line bg-surface p-3.5 text-xs leading-5 text-ink transition-colors placeholder:text-muted focus:border-brand focus:outline-none"
            />

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="flex flex-wrap items-center gap-4 text-xs text-ink-2">
                <label className="inline-flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={yskEnabled}
                    onChange={(e) => setYskEnabled(e.target.checked)}
                    className="accent-brand"
                  />
                  <ShieldCheck className="size-3.5 text-brand" />
                  <span>开启防跑偏提醒（发现乱改其他目录时自动提醒）</span>
                </label>
                <label className="inline-flex items-center gap-1.5 text-2xs text-muted">
                  <span>分支</span>
                  <input
                    aria-label="新建会话工作分支"
                    type="text"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    className="h-7 w-32 rounded-md border border-line bg-subtle px-2 font-mono text-2xs text-ink"
                  />
                </label>
              </div>

              <UiButton
                type="submit"
                variant="primary"
                icon={<Rocket />}
                disabled={submitting || !prompt.trim()}
              >
                {submitting ? '正在启动…' : '立即启动会话'}
              </UiButton>
            </div>
          </form>
        </UiCard>
      </div>
    </div>
  );
}
