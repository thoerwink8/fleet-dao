// 流水线这一行的说法（#2759，#3509 起放进工作台「系统状态」）：卡在哪一步、谁在修了多久；没卡就是在走。
// 流水线这一块没给（老后端）写「没查成」，不写成在走。「有几件要你定」不在这里：它是「要你拍的」那块标题上的数。
import { formatDuration } from '../../lib/format';
import type { Level } from '../../theme/status-dict';
import type { HomePipeline } from './types';

export type PipelineKind = 'moving' | 'stuck' | 'unknown';

export function pipelineOf(input: { pipeline: HomePipeline | undefined; now: number }): {
  kind: PipelineKind;
  level: Level;
  text: string;
} {
  const pipeline = input.pipeline;
  if (!pipeline) return { kind: 'unknown', level: 'warning', text: '没查成' };
  if (pipeline.state === 'moving') return { kind: 'moving', level: 'success', text: '在走' };
  if (pipeline.who && pipeline.since) {
    const dur = formatDuration(Math.max(0, input.now - Date.parse(pipeline.since)));
    return { kind: 'stuck', level: 'error', text: `卡在${pipeline.step}，${pipeline.who}在修 ${dur}` };
  }
  if (pipeline.who) {
    return { kind: 'stuck', level: 'error', text: `卡在${pipeline.step}，${pipeline.who}在修，多久没记` };
  }
  return { kind: 'stuck', level: 'error', text: `卡在${pipeline.step}，还没人接` };
}
