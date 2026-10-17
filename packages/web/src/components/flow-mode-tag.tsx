// 一张单走全程还是三段（tasks.flow_mode，#2828）。没有这个值的老单不画，不猜。
import type { FlowMode } from '@fleet-dao/shared';
import { Tag } from './layout/tag';

const LABEL: Record<FlowMode, string> = { full: '全程', three: '三段' };
const TITLE: Record<FlowMode, string> = {
  full: '这张单走全程：一个会话自己走到合并',
  three: '这张单走三段：对题、动手、验收各一段',
};

export function FlowModeTag({
  mode,
  fallback,
}: {
  mode: FlowMode | null | undefined;
  /** 不合格、实际退回三段的原因。有这句时标签写成「退回三步」，悬停看原因。 */
  fallback?: string | null | undefined;
}) {
  if (mode !== 'full' && mode !== 'three') return null;
  const reason = mode === 'three' ? fallback?.trim() : undefined;
  const sentBack = reason !== undefined && reason !== '';
  return (
    <span
      data-flow-mode={mode}
      {...(sentBack ? { 'data-flow-fallback': reason } : {})}
      title={sentBack ? reason : TITLE[mode]}
      className="inline-flex shrink-0"
    >
      <Tag>{sentBack ? '退回三步' : LABEL[mode]}</Tag>
    </span>
  );
}
