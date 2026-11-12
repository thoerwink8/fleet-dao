// 模块化、大白话的「分步任务」页（原名 任务波次 DAG）。
// 用统一组件（UiCard / UiSectionHeader / UiButton / UiField / UiInput / UiSelect / UiStatCard / UiSegmentedTabs）重构。
import {
  ArrowRight,
  CheckCircle2,
  GitPullRequest,
  Layers,
  MessageSquareShare,
  Play,
  Plus,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Chip } from '../components/chip';
import { PageBar } from '../components/shell';
import {
  UiButton,
  UiCard,
  UiField,
  UiInput,
  UiSectionHeader,
  UiSegmentedTabs,
  UiSelect,
  UiStatCard,
} from '../components/ui-kit';
import { useAdeState } from '../lib/ade';

export function WorkWavePage() {
  const { state, createWaveSubtask, advanceWaveNode } = useAdeState();
  const [selectedWave, setSelectedWave] = useState<'all' | 1 | 2 | 3>('all');
  const [showAddNode, setShowAddNode] = useState(false);
  const [nodeTitle, setNodeTitle] = useState('');
  const [nodeWave, setNodeWave] = useState<1 | 2 | 3>(2);
  const [nodeRole, setNodeRole] = useState('worker-code');
  const [nodeModel, setNodeModel] = useState('Kiro · Claude Sonnet');
  const [nodeScope, setNodeScope] = useState('packages/harness-web/**');

  const waveNodes = state.waveNodes;
  const shown = waveNodes.filter((n) => selectedWave === 'all' || n.wave === selectedWave);

  const verifiedCount = waveNodes.filter((n) => n.status === 'verified').length;
  const runningCount = waveNodes.filter((n) => n.status === 'running').length;
  const readyCount = waveNodes.filter((n) => n.status === 'ready' || n.status === 'rework').length;

  const handleCreateWaveNode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nodeTitle.trim()) return;
    await createWaveSubtask({
      title: nodeTitle.trim(),
      wave: nodeWave,
      role: nodeRole,
      modelName: nodeModel,
      writeScope: nodeScope.trim() || 'packages/**',
    });
    setNodeTitle('');
    setShowAddNode(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageBar
        title="分步任务"
        extra={
          <div className="flex items-center gap-2">
            <span className="num hidden items-center gap-1.5 text-2xs text-ink-2 sm:inline-flex">
              <GitPullRequest className="size-3.5 text-brand" />
              汇总分支：
              <code className="rounded-sm bg-subtle px-1.5 py-0.5 font-mono">wave/3851-option2</code>
            </span>
            <UiButton variant="primary" size="sm" icon={<Plus />} onClick={() => setShowAddNode((v) => !v)}>
              {showAddNode ? '收起' : '派发波次任务'}
            </UiButton>
          </div>
        }
      >
        <UiSegmentedTabs
          value={selectedWave}
          onChange={setSelectedWave}
          options={
            [
              ['all', `全部波次 (${waveNodes.length})`],
              [1, `第一波 · 找代码与底座 (${waveNodes.filter((n) => n.wave === 1).length})`],
              [2, `第二波 · 并行写代码 (${waveNodes.filter((n) => n.wave === 2).length})`],
              [3, `第三波 · 界面与收尾 (${waveNodes.filter((n) => n.wave === 3).length})`],
            ] as const
          }
        />
      </PageBar>

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 pb-20 md:p-6">
        {showAddNode ? (
          <UiCard>
            <form onSubmit={(e) => void handleCreateWaveNode(e)} className="grid gap-3 sm:grid-cols-4">
              <UiField label="子任务要做什么" htmlFor="wave-node-title" className="sm:col-span-2">
                <UiInput
                  id="wave-node-title"
                  aria-label="新波次子任务描述"
                  value={nodeTitle}
                  onChange={(e) => setNodeTitle(e.target.value)}
                  placeholder="例如：给机器列表接口加上断网重连测试"
                />
              </UiField>
              <UiField label="放哪一步跑" htmlFor="wave-node-wave">
                <UiSelect
                  id="wave-node-wave"
                  aria-label="新波次编号"
                  value={nodeWave}
                  onChange={(e) => setNodeWave(Number(e.target.value) as 1 | 2 | 3)}
                >
                  <option value={1}>第一步 · 找代码与底座</option>
                  <option value={2}>第二步 · 并行写代码</option>
                  <option value={3}>第三步 · 界面与收尾</option>
                </UiSelect>
              </UiField>
              <UiField label="任务类型" htmlFor="wave-node-role">
                <UiSelect
                  id="wave-node-role"
                  aria-label="新波次工种"
                  value={nodeRole}
                  onChange={(e) => setNodeRole(e.target.value)}
                >
                  <option value="worker-code">写代码 (worker-code)</option>
                  <option value="worker-ui">改界面 (worker-ui)</option>
                  <option value="scout">找代码 (scout)</option>
                  <option value="verifier">独立验收 (verifier)</option>
                </UiSelect>
              </UiField>
              <UiField label="指派模型" htmlFor="wave-node-model" className="sm:col-span-2">
                <UiSelect
                  id="wave-node-model"
                  aria-label="新波次模型"
                  value={nodeModel}
                  onChange={(e) => setNodeModel(e.target.value)}
                >
                  <option value="Kiro · Claude Sonnet">Kiro · Claude Sonnet</option>
                  <option value="CommonCode · DeepSeek V4 Pro">CommonCode · DeepSeek V4 Pro</option>
                  <option value="reclaude · Claude Opus 5.5">reclaude · Claude Opus 5.5</option>
                  <option value="Antigravity · Gemini 3.1 Pro">Antigravity · Gemini 3.1 Pro</option>
                  <option value="Devin SWE-2 (Free)">Devin SWE-2 (免费)</option>
                </UiSelect>
              </UiField>
              <div className="flex items-end gap-2 sm:col-span-2">
                <UiField label="允许改哪些目录" className="flex-1">
                  <UiInput
                    aria-label="新波次写范围锁"
                    value={nodeScope}
                    onChange={(e) => setNodeScope(e.target.value)}
                    className="font-mono"
                  />
                </UiField>
                <UiButton type="submit" variant="primary">
                  加入波次并启动
                </UiButton>
              </div>
            </form>
          </UiCard>
        ) : null}

        {/* 顶部 4 个统计模块卡 */}
        <section aria-label="单PR合流概览" className="grid gap-3 sm:grid-cols-4">
          <UiStatCard
            label="合并方式"
            value="本地波次分支合流 → 最终单 PR"
            sub="子任务各自改不同目录，最后一次提 PR"
          />
          <UiStatCard
            label="当前进度"
            value={`${verifiedCount} 已完成 / ${runningCount} 在跑 / ${readyCount} 等待`}
            sub="前一步跑完自动触发下一步"
          />
          <UiStatCard label="越界检查" value="实时防跑偏 · 0 乱改目录" sub="盯着每个任务只改自己负责的文件" />
          <UiStatCard
            label="省下的流量"
            value="54,100 Tokens (省 69%)"
            sub="先找准文件行号再喂给主力模型"
            tone="brand"
          />
        </section>

        {/* 子任务卡片列表 */}
        <section aria-label="波次子任务列表" className="grid gap-3.5 md:grid-cols-2 lg:grid-cols-3">
          {shown.map((node) => (
            <UiCard
              key={node.id}
              data-testid={`wave-node-${node.id}`}
              className="flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="num inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-ink-2">
                    <Layers className="size-3.5 text-brand" />第 {node.wave} 步 · {node.id}
                  </span>
                  <Chip
                    tone={
                      node.status === 'verified' ? 'neutral' : node.status === 'running' ? 'brand' : 'warning'
                    }
                  >
                    {node.status === 'verified'
                      ? '已完成'
                      : node.status === 'running'
                        ? '正在跑'
                        : '等上一步'}
                  </Chip>
                </div>

                <h2 className="mt-2.5 text-sm font-semibold leading-5 text-ink">{node.title}</h2>

                <dl className="mt-3.5 flex flex-col gap-2 rounded-lg bg-subtle/60 p-3 text-2xs">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted">负责模型</dt>
                    <dd className="font-mono font-medium text-ink">{node.modelName}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted">运行账号 / 机器</dt>
                    <dd className="font-mono text-ink-2">{node.accountTag}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted">负责目录</dt>
                    <dd className="font-mono text-ink-2">{node.writeScope}</dd>
                  </div>
                </dl>
              </div>

              <div className="mt-4 flex items-center justify-between gap-2 border-t border-line/70 pt-3 text-2xs">
                <span className="min-w-0 flex-1 truncate text-muted">{node.funnelStep}</span>
                <div className="flex shrink-0 items-center gap-2">
                  {node.status !== 'verified' ? (
                    <UiButton
                      variant="secondary"
                      size="xs"
                      icon={node.status === 'ready' ? <Play /> : <CheckCircle2 />}
                      onClick={() => void advanceWaveNode(node.id)}
                    >
                      {node.status === 'ready' ? '启动' : '标为完成'}
                    </UiButton>
                  ) : null}
                  <Link
                    to={`/s/${node.sessionId}`}
                    className="inline-flex shrink-0 items-center gap-1 font-medium text-brand hover:underline"
                  >
                    看对话
                    <ArrowRight className="size-3" />
                  </Link>
                </div>
              </div>
            </UiCard>
          ))}
        </section>

        {/* 任务间实时互通消息 */}
        <UiCard aria-label="同波次共享黑板">
          <UiSectionHeader
            icon={<MessageSquareShare />}
            title="任务间自动通气"
            subtitle="前一个任务改了接口或类型，自动发消息提醒其它正在跑的任务"
            action={<Chip mono>共 {state.blackboardFacts.length} 条记录</Chip>}
          />
          <ul className="mt-3.5 divide-y divide-line text-xs">
            {state.blackboardFacts.map((f) => (
              <li
                key={f.id}
                className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <span className="font-mono text-2xs font-semibold text-brand">{f.from}</span>
                  <span className="mx-1.5 text-muted">·</span>
                  <code className="rounded-md bg-subtle px-1.5 py-0.5 font-mono text-2xs text-ink-2">
                    {f.scope}
                  </code>
                  <p className="mt-1 text-ink-2">{f.text}</p>
                </div>
                <span className="num shrink-0 font-mono text-2xs text-muted">{f.at} 已同步</span>
              </li>
            ))}
          </ul>
        </UiCard>
      </div>
    </div>
  );
}
