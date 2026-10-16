// 模型强弱档徽标（#2691）：路由页模型旁的小标签。档位只由部署目录定（models.strength），驾驶舱只读；没标的不画。
// 用 Tag（分类，不是状态）：强档用品牌色突出一点，标准、快档中性；颜色只是分类着色，不表示好坏。
import type { ModelStrength } from '@fleet-dao/shared';
import { Tag, type TagTone } from './layout/tag';

const STRENGTH: Record<ModelStrength, { label: string; tone: TagTone; title: string }> = {
  strong: { label: '强档', tone: 'brand', title: '强档：重活先给强档模型' },
  standard: { label: '标准档', tone: 'neutral', title: '标准档：中等强度的模型' },
  light: { label: '快档', tone: 'neutral', title: '快档：轻活、求快的模型' },
};

export function ModelStrengthBadge({ strength }: { strength: ModelStrength | undefined | null }) {
  if (!strength) return null;
  const s = STRENGTH[strength];
  return (
    <span title={s.title} data-model-strength={strength} className="inline-flex shrink-0">
      <Tag tone={s.tone}>{s.label}</Tag>
    </span>
  );
}
