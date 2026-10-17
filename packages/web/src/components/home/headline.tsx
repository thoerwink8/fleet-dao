// 首页顶部一句话（#2759）：有要拍的先说要你定几件；否则流水线卡在哪一步、谁在修了多久；都没有就是在走。
// 流水线这一块没给（老后端）写「没查成」，不写成在走。
import { formatDuration } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import { inkClass, type LayoutTone } from '../layout/tone';
import type { HomePipeline } from './types';

export type HeadlineKind = 'decisions' | 'stuck' | 'moving' | 'unknown';

export function headlineOf(input: { decisions: number; pipeline: HomePipeline | undefined; now: number }): {
  kind: HeadlineKind;
  tone: LayoutTone;
  text: string;
} {
  if (input.decisions > 0) {
    return { kind: 'decisions', tone: 'human', text: `有 ${input.decisions} 件要你定` };
  }
  const pipeline = input.pipeline;
  if (!pipeline) return { kind: 'unknown', tone: 'stop', text: '流水线没查成' };
  if (pipeline.state === 'moving') return { kind: 'moving', tone: 'done', text: '流水线在走' };
  if (pipeline.who && pipeline.since) {
    const dur = formatDuration(Math.max(0, input.now - Date.parse(pipeline.since)));
    return { kind: 'stuck', tone: 'fail', text: `卡在${pipeline.step}，${pipeline.who}在修 ${dur}` };
  }
  if (pipeline.who) {
    return { kind: 'stuck', tone: 'fail', text: `卡在${pipeline.step}，${pipeline.who}在修，多久没记` };
  }
  return { kind: 'stuck', tone: 'fail', text: `卡在${pipeline.step}，还没人接` };
}

/** 顶部一句话。钟走了，修了多久跟着变。 */
export function Headline({
  decisions,
  pipeline,
  now,
}: {
  decisions: number;
  pipeline: HomePipeline | undefined;
  /** 测试钉住时刻；不传用现在。 */
  now?: number;
}) {
  const ticking = useNow();
  const line = headlineOf({ decisions, pipeline, now: now ?? ticking });
  return (
    <p
      data-home-headline={line.kind}
      data-tone={line.tone}
      role="status"
      className={cn('text-body font-medium', inkClass[line.tone])}
    >
      {line.text}
    </p>
  );
}
