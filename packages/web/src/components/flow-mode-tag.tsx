// 一张单走全程还是三段（tasks.flow_mode，#2828）。没有这个值的老单不画，不猜。
import type { FlowMode } from '@fleet-dao/shared';
import { Tag } from './layout/tag';

const LABEL: Record<FlowMode, string> = { full: '全程', three: '三段' };
const TITLE: Record<FlowMode, string> = {
  full: '这张单走全程：一个会话自己走到合并',
  three: '这张单走三段：对题、动手、验收各一段',
};

export function FlowModeTag({ mode }: { mode: FlowMode | null | undefined }) {
  if (mode !== 'full' && mode !== 'three') return null;
  return (
    <span data-flow-mode={mode} title={TITLE[mode]} className="inline-flex shrink-0">
      <Tag>{LABEL[mode]}</Tag>
    </span>
  );
}
