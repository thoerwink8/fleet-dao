// 资源页「整机」一节（#1986；#3509 照 Arco，样稿 canvas/Resources.dc.html）：内存、CPU、磁盘三格，每格「已用 / 总量」加一根进度条。
// 异常只靠进度条变橙（紧：内存 ≥ 85%、CPU ≥ 90%；磁盘按 hostMeters 的判法），读数旧了在区块头标橙色「读数旧了」；
// 旧读数不再标紧（旧数据不该吓人）。读不到写「没读到」加原因，不拿 0 顶。
// 数值怎么来在 components/home/resources.ts 的 hostMeters；这里只管摆。
import { formatAgo } from '../../lib/format';
import { hostMeters, type Meter } from '../home/resources';
import type { HomeResources } from '../home/types';
import { Grid } from '../layout/grid';
import { Progress } from '../layout/progress';
import { Section } from '../layout/section';
import { Stack } from '../layout/stack';
import { Stat } from '../layout/stat';
import { Tag } from '../layout/tag';
import { Text } from '../layout/text';

/** 整机一大格：名字、「已用 / 总量」、细条加百分比；读不到写没读到和原因。 */
function Gauge({ id, name, meter, stale }: { id: string; name: string; meter: Meter; stale: boolean }) {
  if (meter.kind === 'unread') {
    return (
      <div data-gauge={id} data-tone="stop">
        <Stack gap="sm">
          <Text size="meta" tone="secondary">
            {name}
          </Text>
          <Text size="heading" tone="muted">
            没读到
          </Text>
          <Text size="meta" tone="muted">
            {meter.why}
          </Text>
        </Stack>
      </div>
    );
  }
  const [used, total] = meter.amount.kind === 'ok' ? meter.amount.text.split(' / ') : [undefined, undefined];
  const strong = meter.tight && !stale;
  return (
    <div data-gauge={id} data-tone={strong ? 'stall' : stale ? 'stop' : 'done'} title={meter.detail}>
      <Stack gap="sm">
        {used === undefined ? (
          <>
            <Text size="meta" tone="secondary">
              {name}
            </Text>
            <Text size="heading" tone="muted">
              数值没读到
            </Text>
            {meter.amount.kind === 'unread' ? (
              <Text size="meta" tone="muted">
                {meter.amount.why}
              </Text>
            ) : null}
          </>
        ) : (
          <span data-gauge-used>
            <Stat label={name} value={used} unit={`/ ${total}`} />
          </span>
        )}
        <span data-gauge-percent>
          <Progress
            percent={meter.percent}
            thresholds={strong ? { warn: 0 } : {}}
            label={meter.text}
            aria-label={`${name}用量`}
          />
        </span>
      </Stack>
    </div>
  );
}

export function HostSection({
  resources,
  remote,
  machine,
  now,
}: {
  resources: HomeResources | undefined;
  remote: boolean;
  machine: string;
  now: number;
}) {
  const m = hostMeters(resources, now, { remote });
  const when = resources
    ? `读于 ${formatAgo(resources.at, Math.max(now, Date.parse(resources.at)))}${remote ? '（那台推来的快照）' : ` · 每 ${Math.round(resources.everyMs / 1000)} 秒更新`}`
    : undefined;
  return (
    <Section
      title="整机"
      description={machine}
      data-resources-host
      actions={
        <>
          {m.stale ? <Tag tone="warning">读数旧了</Tag> : null}
          {when ? (
            <Text size="meta" tone="muted">
              {when}
            </Text>
          ) : null}
        </>
      }
    >
      {m.missing ? (
        <span data-resources-missing>
          <Text tone="muted">{m.missing}</Text>
        </span>
      ) : (
        <Grid cols={3}>
          <Gauge id="memory" name="内存" meter={m.memory} stale={m.stale} />
          <Gauge id="cpu" name="CPU" meter={m.cpu} stale={m.stale} />
          <Gauge id="disk" name="磁盘" meter={m.disk} stale={m.stale} />
        </Grid>
      )}
    </Section>
  );
}
