// 任务页「用量与模型」页签（#3228 收成一行，#3509 改成页签）：几个数、三段、每一笔、用哪个模型。
// 摘要只写读到的：几笔、已用时、输入当量、模型指定了没有；读不到的那项不写，不拿 0 顶。
// 选中这个页签记在地址里（?tab=usage，旧链接 ?usage=open 一样认）：刷新、发给别人都还是同一处。
import type { TaskDetail } from '../api/types';
import { formatDuration } from '../lib/format';
import { segmentLabel } from '../lib/segments';
import { isTaskFinished } from '../lib/status';
import { Section } from './layout/section';
import { Stack } from './layout/stack';
import { Text } from './layout/text';
import { SegmentBreakdown, SegmentRunList, SegmentStats, wallMs } from './segment-usage';
import { TaskModelPins } from './task-model-pins';

const COUNT = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });

export function usageFoldSummary(d: TaskDetail, now: number): string {
  const t = d.usage.total;
  const parts = [
    `${d.segmentRuns.length} 笔`,
    `${isTaskFinished(d.task) ? '总耗时' : '已用时'} ${formatDuration(wallMs(d, now))}`,
  ];
  // 有一笔没读到 token 就不写这项：写了是少算的数
  if (t.inputEquivalent > 0 && t.missingEquivalent === 0)
    parts.push(`输入当量 ${COUNT.format(t.inputEquivalent)}`);
  const pinned = d.routePins.pins.filter((p) => p.modelId !== undefined);
  if (d.routePins.unavailable) parts.push('模型指定没读到');
  else if (pinned.length) parts.push(`${pinned.map((p) => segmentLabel[p.segment]).join('、')}指定了模型`);
  else parts.push('动手、验收都是自动选');
  return parts.join(' · ');
}

/** 旧链接 `?usage=open`（用量折叠区展开）：现在等于选中「用量与模型」页签。 */
export const USAGE_PARAM = 'usage';

/** 「用哪个模型」：结束了的单从没指定过，也没什么可看的，不画。 */
export function canPinModels(d: TaskDetail): boolean {
  return !(isTaskFinished(d.task) && !d.routePins.pins.length && !d.routePins.unavailable);
}

export function UsageTab({
  d,
  now,
  onViewTranscript,
}: {
  d: TaskDetail;
  now: number;
  onViewTranscript: (runId: string) => void;
}) {
  return (
    <div data-usage-fold>
      <Stack gap="xl">
        <span data-usage-summary>
          <Text size="meta" tone="muted">
            {usageFoldSummary(d, now)}
          </Text>
        </span>
        <SegmentStats d={d} now={now} />
        <Section variant="plain" title="三段" description="对题 → 动手 → 验收，每段再按模型分">
          <SegmentBreakdown d={d} now={now} />
        </Section>
        <Section variant="plain" title="每一笔" description="按起跑先后，点「看会话」在右侧看会话内容">
          <SegmentRunList d={d} now={now} onViewTranscript={onViewTranscript} />
        </Section>
        {canPinModels(d) ? <TaskModelPins d={d} now={now} /> : null}
      </Stack>
    </div>
  );
}
