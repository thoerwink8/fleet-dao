// 模块化、大白话的「待我确认（决策与验收）」页面。
// 去掉晦涩术语（如 Wilson 95% 下界、Gate 1~4 黑话），改为清晰易懂的「四步自动检查」+ 模块化卡片。
import { CheckCircle2, ShieldCheck, ThumbsDown, ThumbsUp } from 'lucide-react';
import { Chip } from '../components/chip';
import { PageBar } from '../components/shell';
import { UiButton, UiCard, UiStatCard } from '../components/ui-kit';
import { useAdeState } from '../lib/ade';

interface DecisionCardItem {
  id: string;
  kind: 'verify-handback' | 'open-auto-gate' | 'self-evolution-rule';
  title: string;
  workerModel: string;
  verifierModel: string;
  passRate: string;
  maturedSamples: number;
  check1Scope: string;
  check2Test: string;
  check3Review: string;
  recommendation: string;
  diffSummary: string;
}

const INITIAL_DECISIONS: readonly DecisionCardItem[] = [
  {
    id: 'DEC-3851-UI',
    kind: 'verify-handback',
    title: '验收：新驾驶舱五大页面组件化重构与电脑/手机双屏检查',
    workerModel: 'Kiro · Claude Sonnet',
    verifierModel: 'Recodex · GPT-5.3 Codex (独立复核)',
    passRate: '91.4%',
    maturedSamples: 26,
    check1Scope: '通过（只改了授权目录，没删测试断言）',
    check2Test: '通过（类型检查 0 报错 · 电脑 1440px / 手机 390px 排版正常）',
    check3Review: '通过（另一家模型独立复核：需求全部满足）',
    recommendation: '建议：放行合并（四项检查全部通过）',
    diffSummary: '+482 / -14 行 · 涉及 packages/harness-web 与 packages/harness-api',
  },
  {
    id: 'DEC-GATE-COMMONCODE',
    kind: 'open-auto-gate',
    title: '省心提议：让「DeepSeek V4 Pro 改小范围代码」以后检查全过就自动合并',
    workerModel: 'CommonCode · DeepSeek V4 Pro',
    verifierModel: 'Claude Opus 5.5 (独立复核)',
    passRate: '92.8%',
    maturedSamples: 42,
    check1Scope: '连续 42 单没有乱改范围外文件',
    check2Test: '连续 42 单一次跑通测试达 97.6%',
    check3Review: '合并后 3 天内 0 次返工撤回',
    recommendation: '建议：开启自动放行，以后这类小改动不用每次手动点确认',
    diffSummary: '已稳定跑过 42 单，稳定度 92.8%',
  },
  {
    id: 'DEC-EVO-PROMPT-09',
    kind: 'self-evolution-rule',
    title: '经验提议：给 DeepSeek V4 Pro 加上「不准顺手改导航文字」的长期提醒',
    workerModel: 'CommonCode · DeepSeek V4 Pro',
    verifierModel: '历史返工总结',
    passRate: '68% → 94%',
    maturedSamples: 15,
    check1Scope: '之前有 3 次顺手改了没让它改的导航文字',
    check2Test: '加上这句提醒试跑 15 单后，再没犯过同样问题',
    check3Review: '只加一句话（42 字），不费额度',
    recommendation: '建议：存进 DeepSeek 的默认规则里，以后每次自动带上',
    diffSummary: '规则编号: deepseek-no-extra-ui-edit',
  },
];

export function DecidePage() {
  const { state, resolveDecision } = useAdeState();
  const resolved = state.decisionsResolved;

  const pendingCount = INITIAL_DECISIONS.filter((d) => !resolved[d.id]).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageBar
        title="待我确认"
        extra={
          <span className="num text-xs text-ink-2">
            待拍板 <strong className="font-semibold text-brand">{pendingCount}</strong> 件
          </span>
        }
      />

      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 pb-20 md:p-6">
        {/* 顶部 4 步检查说明模块 */}
        <section aria-label="四道漏斗说明" className="grid gap-3 sm:grid-cols-4">
          <UiStatCard label="第 1 步 · 防跑偏" value="盯着改动范围" sub="防止顺手改坏别处的代码或删掉测试" />
          <UiStatCard
            label="第 2 步 · 跑测试与截图"
            value="机器自动验"
            sub="自动跑类型检查、单测和电脑/手机双屏截图"
          />
          <UiStatCard
            label="第 3 步 · 换家模型挑错"
            value="交叉复核"
            sub="Claude 写的让 GPT 审，避免自己夸自己"
          />
          <UiStatCard
            label="第 4 步 · 熟手免打扰"
            value="稳定后自动过"
            sub="连续做对 20 单以上且稳定度达标才提议免审"
            tone="brand"
          />
        </section>

        {/* 待拍板卡片列表 */}
        <section aria-label="待拍板决策卡" className="flex flex-col gap-4">
          {INITIAL_DECISIONS.map((item, idx) => {
            const verdict = resolved[item.id];
            return (
              <UiCard key={item.id} data-testid={`decision-card-${item.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="inline-flex flex-wrap items-center gap-2">
                    <span className="num rounded-md bg-brand-soft px-2.5 py-0.5 font-mono text-2xs font-semibold text-brand-strong">
                      #{idx + 1} · {item.id}
                    </span>
                    <Chip mono>稳定度 {item.passRate}</Chip>
                    <Chip mono>已验证 {item.maturedSamples} 单</Chip>
                  </div>
                  {verdict ? (
                    <Chip tone={verdict === 'approved' ? 'brand' : 'danger'}>
                      {verdict === 'approved' ? '已批准执行' : '已退回重做'}
                    </Chip>
                  ) : null}
                </div>

                <h2 className="mt-2.5 text-sm font-semibold text-ink">{item.title}</h2>
                <p className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-brand">
                  <ShieldCheck className="size-3.5 shrink-0" />
                  <span>{item.recommendation}</span>
                </p>

                <dl className="mt-3.5 grid gap-3 rounded-xl border border-line/60 bg-subtle/50 p-3.5 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-2xs text-muted">干活模型 → 复核模型</dt>
                    <dd className="mt-0.5 font-mono text-ink">
                      {item.workerModel} → {item.verifierModel}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-2xs text-muted">改动范围</dt>
                    <dd className="mt-0.5 font-mono text-ink-2">{item.diffSummary}</dd>
                  </div>
                  <div>
                    <dt className="text-2xs text-muted">范围与测试结果</dt>
                    <dd className="mt-0.5 flex items-start gap-1.5 text-ink-2">
                      <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-brand" />
                      <span>
                        {item.check1Scope}；{item.check2Test}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-2xs text-muted">独立复核结论</dt>
                    <dd className="mt-0.5 flex items-start gap-1.5 text-ink-2">
                      <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-brand" />
                      <span>{item.check3Review}</span>
                    </dd>
                  </div>
                </dl>

                <div className="mt-4 flex flex-wrap items-center justify-end gap-2.5">
                  <UiButton
                    variant="danger"
                    icon={<ThumbsDown />}
                    onClick={() => void resolveDecision(item.id, 'rejected')}
                  >
                    退回并升档重做
                  </UiButton>
                  <UiButton
                    variant="primary"
                    icon={<ThumbsUp />}
                    onClick={() => void resolveDecision(item.id, 'approved')}
                  >
                    批准拍板
                  </UiButton>
                </div>
              </UiCard>
            );
          })}
        </section>
      </div>
    </div>
  );
}
