// 设置 → 仓库一节开头的一句：总开关和每个项目的「让 AI 接活」是什么关系，并给出总开关现在的状态（#1086）。
// 样稿 Settings.dc.html：一个状态点加字、一句灰字关系、去法国页开关的链接，一行排下。
// 总开关读不到时如实写「没查成」「这个环境的版本还不带总开关」，不画成开、也不画成关。
import { useMasterView } from './engine-master';
import { TextLink } from './layout/link';
import { Stack } from './layout/stack';
import { LevelDot } from './layout/status-badge';
import { Text } from './layout/text';

export function EngineMasterRelation() {
  const { view } = useMasterView();
  const state =
    view.kind === 'ok'
      ? view.master.on
        ? '总开关现在开着'
        : '总开关现在关着'
      : view.kind === 'absent'
        ? '这个环境的版本还不带总开关'
        : view.kind === 'error'
          ? '总开关现在是开是关没查成'
          : '正在读总开关';
  const level =
    view.kind === 'ok'
      ? view.master.on
        ? 'success'
        : 'default'
      : view.kind === 'error'
        ? 'warning'
        : 'default';
  const relation = `每个项目的「让 AI 接活」要和引擎总开关一起看：总开关关＝全停，开＝只有这里接活开着的项目才派${
    view.kind === 'ok' && !view.master.on ? '；现在下面哪个项目开着也不会派' : ''
  }`;
  return (
    <div data-testid="engine-master-relation">
      <Stack direction="horizontal" gap="sm" align="center" wrap>
        <LevelDot level={level} />
        <Text strong>{state}</Text>
        <Text size="meta" tone="muted" title={relation}>
          {relation}
        </Text>
        <TextLink to="/france">去法国页开关</TextLink>
      </Stack>
    </div>
  );
}
