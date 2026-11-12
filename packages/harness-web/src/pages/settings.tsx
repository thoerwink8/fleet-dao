// 模块化、大白话的「设置（模型分配、额度与规则）」页面。
// 使用统一组件（UiCard / UiSectionHeader / UiButton / UiField / UiInput / UiSelect / UiSegmentedTabs）重构。
import { CheckCircle2, Gauge, Plus, Sliders, Sparkles, Wand2 } from 'lucide-react';
import { useState } from 'react';
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
} from '../components/ui-kit';
import { type AdeModelOption, useAdeState } from '../lib/ade';

const QUOTA_POOLS = [
  {
    pool: 'reclaude 拼车池 (5小时窗)',
    runner: '官方直连',
    remaining: '$27.90 / $80.00',
    resetNote: '42 分钟后刷新 · 优先用完',
  },
  {
    pool: 'reclaude 独享池',
    runner: '官方直连',
    remaining: '$61.60 / $80.00',
    resetNote: '3 小时 12 分后刷新 · 总控与兜底',
  },
  {
    pool: 'Kiro & DeepSeek 主力池',
    runner: '常驻流',
    remaining: '充足 (91%)',
    resetNote: '自动分流 · 无排队限流',
  },
  {
    pool: 'Devin SWE-2 & Recodex',
    runner: '常驻流',
    remaining: 'SWE-2 免费 / Recodex 95%',
    resetNote: '防跑偏盯梢与交叉复核',
  },
];

export function SettingsPage({ hideBar = false }: { hideBar?: boolean } = {}) {
  const { state, updateRoute, addModel, addOverlayRule } = useAdeState();
  const [selectedOverlay, setSelectedOverlay] = useState<'deepseek' | 'kiro' | 'recodex' | 'swe2'>(
    'deepseek',
  );
  const [newRuleText, setNewRuleText] = useState('');
  const [showAddModel, setShowAddModel] = useState(false);
  const [modelId, setModelId] = useState('');
  const [modelLabel, setModelLabel] = useState('');
  const [modelRunner, setModelRunner] = useState<'pi-api-stream' | 'native-reclaude-stream' | 'native-cli'>(
    'pi-api-stream',
  );
  const [modelFamily, setModelFamily] = useState<AdeModelOption['family']>('claude');
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const activeOverlay = state.overlays[selectedOverlay] ?? {
    title: '',
    evolvedCount: 0,
    rules: [],
  };

  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault();
    const rule = newRuleText.trim();
    if (!rule) return;
    await addOverlayRule(selectedOverlay, rule);
    setNewRuleText('');
    setSavedNotice(`已给 ${selectedOverlay} 加上新规则并立即生效`);
  };

  const handleAddModel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modelId.trim() || !modelLabel.trim()) return;
    await addModel({
      id: modelId.trim(),
      label: modelLabel.trim(),
      runner: modelRunner,
      family: modelFamily,
    });
    setModelId('');
    setModelLabel('');
    setShowAddModel(false);
    setSavedNotice(`已添加新模型「${modelLabel.trim()}」，可在新建会话和任务分配里直接选`);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {hideBar ? null : (
        <PageBar
          title="模型与规则设置"
          extra={
            <Chip mono className="hidden sm:inline-flex">
              额度自动均衡已开启
            </Chip>
          }
        />
      )}

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 pb-24 md:p-6">
        {savedNotice ? (
          <div
            role="status"
            className="flex items-center gap-2 rounded-xl border border-brand/25 bg-brand-soft px-4 py-2.5 text-xs font-medium text-brand-strong"
          >
            <CheckCircle2 className="size-4 shrink-0" />
            <span>{savedNotice}</span>
          </div>
        ) : null}

        {/* 模块 1：任务怎么分给模型 */}
        <UiCard aria-label="四维路由矩阵表">
          <UiSectionHeader
            icon={<Sliders />}
            title="哪种活交给哪个模型（可随时改）"
            subtitle="为不同任务指定默认模型、思考深度与备选方案；密钥只存机器本地钥匙串"
            action={
              <UiButton variant="soft" size="sm" icon={<Plus />} onClick={() => setShowAddModel((v) => !v)}>
                {showAddModel ? '收起' : '添加新模型'}
              </UiButton>
            }
          />

          {showAddModel ? (
            <form
              onSubmit={(e) => void handleAddModel(e)}
              className="mt-4 grid gap-3 rounded-xl border border-brand/25 bg-subtle/60 p-4 sm:grid-cols-4"
            >
              <UiField label="模型标识 (ID)" htmlFor="new-model-id">
                <UiInput
                  id="new-model-id"
                  aria-label="新模型标识"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder="opencode::qwen3-coder"
                  className="font-mono"
                />
              </UiField>
              <UiField label="显示名称" htmlFor="new-model-label">
                <UiInput
                  id="new-model-label"
                  aria-label="新模型展示名称"
                  value={modelLabel}
                  onChange={(e) => setModelLabel(e.target.value)}
                  placeholder="OpenCode · Qwen3 Coder"
                />
              </UiField>
              <UiField label="连接方式" htmlFor="new-model-runner">
                <UiSelect
                  id="new-model-runner"
                  aria-label="新模型执行引擎"
                  value={modelRunner}
                  onChange={(e) =>
                    setModelRunner(
                      e.target.value as 'pi-api-stream' | 'native-reclaude-stream' | 'native-cli',
                    )
                  }
                >
                  <option value="pi-api-stream">常驻流 (pi-api-stream)</option>
                  <option value="native-reclaude-stream">官方直连 (reclaude)</option>
                  <option value="native-cli">命令行直调 (native-cli)</option>
                </UiSelect>
              </UiField>
              <div className="flex items-end gap-2">
                <UiField label="模型系列" className="flex-1">
                  <UiSelect
                    aria-label="新模型家族"
                    value={modelFamily}
                    onChange={(e) => setModelFamily(e.target.value as AdeModelOption['family'])}
                  >
                    <option value="claude">Claude</option>
                    <option value="deepseek">DeepSeek</option>
                    <option value="gpt">GPT</option>
                    <option value="gemini">Gemini</option>
                    <option value="grok">Grok</option>
                    <option value="swe2">SWE-2</option>
                  </UiSelect>
                </UiField>
                <UiButton type="submit" variant="primary">
                  保存接入
                </UiButton>
              </div>
            </form>
          ) : null}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[740px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-line text-2xs text-muted">
                  <th className="py-2.5 pr-3 font-medium">任务类型</th>
                  <th className="px-3 py-2.5 font-medium">默认模型（下拉即改）</th>
                  <th className="px-3 py-2.5 font-medium">思考深度</th>
                  <th className="px-3 py-2.5 font-medium">备用模型</th>
                  <th className="px-3 py-2.5 font-medium">成功率</th>
                  <th className="py-2.5 pl-3 font-medium">注意事项</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {state.routes.map((r) => (
                  <tr key={r.role} data-testid={`route-row-${r.role}`}>
                    <td className="py-3 pr-3 font-medium text-ink">{r.roleLabel}</td>
                    <td className="px-3 py-3">
                      <UiSelect
                        aria-label={`${r.role} 首选模型`}
                        value={r.primary}
                        onChange={(e) => {
                          const next = e.target.value;
                          void updateRoute({ role: r.role, primary: next });
                          setSavedNotice(`已将工种「${r.role}」首选模型更新为 ${next}`);
                        }}
                        className="max-w-[250px] truncate bg-subtle/60 font-mono text-2xs text-brand"
                      >
                        <option value={r.primary}>{r.primary}</option>
                        {state.models
                          .filter((m) => m.label !== r.primary)
                          .map((m) => (
                            <option key={m.id} value={m.label}>
                              {m.label}
                            </option>
                          ))}
                      </UiSelect>
                    </td>
                    <td className="px-3 py-3">
                      <UiSelect
                        aria-label={`${r.role} 思考档位`}
                        value={r.effort}
                        onChange={(e) => {
                          const eff = e.target.value as 'low' | 'medium' | 'high' | 'max';
                          void updateRoute({ role: r.role, effort: eff });
                          setSavedNotice(`已将工种「${r.role}」默认思考档位调整为 ${eff}`);
                        }}
                        className="w-24 bg-subtle/60 font-mono text-2xs"
                      >
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                        <option value="max">max</option>
                      </UiSelect>
                    </td>
                    <td className="px-3 py-3 font-mono text-2xs text-ink-2">{r.secondary}</td>
                    <td className="num px-3 py-3 font-mono font-semibold text-ink">{r.wilson}</td>
                    <td className="py-3 pl-3 text-2xs text-ink-2">{r.overlayNote}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </UiCard>

        {/* 模块 2：各家账号额度 */}
        <UiCard aria-label="Magpie额度分发雷达">
          <UiSectionHeader
            icon={<Gauge />}
            title="账号额度余量（Magpie 实时额度雷达）"
            subtitle="快到刷新时间的套餐会自动优先用完，避免浪费"
            action={<Chip tone="brand">本地代理 127.0.0.1:19820 在线</Chip>}
          />
          <div className="mt-3.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {QUOTA_POOLS.map((q) => (
              <div key={q.pool} className="rounded-xl border border-line/70 bg-subtle/50 p-3.5 text-2xs">
                <div className="font-semibold text-ink">{q.pool}</div>
                <div className="num mt-1.5 font-mono text-xs font-semibold text-brand">{q.remaining}</div>
                <div className="mt-1 font-mono text-muted">{q.runner}</div>
                <div className="mt-0.5 text-ink-2">{q.resetNote}</div>
              </div>
            ))}
          </div>
        </UiCard>

        {/* 模块 3：给不同模型的专属规矩 */}
        <UiCard aria-label="模型专属提示词自进化">
          <UiSectionHeader
            icon={<Wand2 />}
            title="给不同模型的专属规矩"
            subtitle="针对每家模型容易犯的毛病，每次发任务时自动带上这几条叮嘱"
            action={
              <UiSegmentedTabs
                value={selectedOverlay}
                onChange={setSelectedOverlay}
                options={
                  [
                    ['deepseek', 'DeepSeek V4 Pro (CommonCode)'],
                    ['kiro', 'Claude Sonnet (Kiro)'],
                    ['recodex', 'GPT-5.3 Codex (Recodex)'],
                    ['swe2', 'Devin SWE-2 (Free YSK)'],
                  ] as const
                }
              />
            }
          />

          <div className="mt-3.5 rounded-xl border border-line/70 bg-subtle/50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-ink">{activeOverlay.title}</span>
              <Chip tone="brand">已生效 {activeOverlay.evolvedCount} 条规矩</Chip>
            </div>
            <ul className="mt-3 flex flex-col gap-2 text-xs text-ink-2">
              {activeOverlay.rules.map((rule) => (
                <li key={rule} className="flex items-start gap-2">
                  <Sparkles className="mt-0.5 size-3.5 shrink-0 text-brand" />
                  <span>{rule}</span>
                </li>
              ))}
            </ul>

            <form onSubmit={(e) => void handleAddRule(e)} className="mt-3.5 flex items-center gap-2">
              <UiInput
                aria-label="新增模型专属护栏规则"
                value={newRuleText}
                onChange={(e) => setNewRuleText(e.target.value)}
                placeholder="给当前模型加一条新规矩（例如：不要顺手改没让你改的文件）…"
                className="flex-1"
              />
              <UiButton type="submit" variant="primary" icon={<Plus />}>
                加一条规矩
              </UiButton>
            </form>
          </div>
        </UiCard>
      </div>
    </div>
  );
}
