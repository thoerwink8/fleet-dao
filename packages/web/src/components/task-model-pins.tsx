// 单子页「用哪个模型」（「每个任务能点进去随意切换模型」）：动手、验收各一行，下拉选模型（还能钉到一条
// 渠道），或回到自动。写到库里（task_route_pins），引擎下一次给这一段选路就照它；在跑的这一轮不打断。
// 动手段多一个「现在就换」（#1216）：指定了和在跑的不一样的模型时出现，点了先写明代价再确认，确认后会话当场停下、原分支接着做。
// 指定的模型派不出时引擎停下等人、不悄悄换别的：页面在下拉里、在这一行上都照路由两层现算的结论说清（lib/route-pins.ts）。
import { useState } from 'react';
import { toast } from 'sonner';
import { errorText, useRoutingLayers, useUpdateTaskRoutePin } from '../api/client';
import type { TaskDetail } from '../api/types';
import { formatAgo } from '../lib/format';
import {
  type ActivePin,
  AUTO,
  activePin,
  choicesFor,
  type Liveness,
  latestRun,
  type ModelChoice,
  pinLiveness,
  ROUTED_SEGMENTS,
  type RoutedSegment,
} from '../lib/route-pins';
import { segmentLabel } from '../lib/segments';
import { isTaskFinished } from '../lib/status';
import { Button } from './layout/button';
import { ConfirmDialog } from './layout/confirm-dialog';
import { FormItem } from './layout/form';
import { NativeSelect } from './layout/native-select';
import { Notice } from './layout/notice';
import { Section } from './layout/section';
import { Stack } from './layout/stack';
import { Text } from './layout/text';

const LIVE_WORD: Record<Liveness['verdict'], string> = { live: '派得出', dead: '派不出', unknown: '不确定' };

/** 下拉选项里的模型名后面跟一句现在派不派得出（原生下拉的选项只有文字）。 */
function withLive(name: string, l: Liveness): string {
  return `${name}（${LIVE_WORD[l.verdict]}）`;
}

/** 「现在」那一句：指定了谁（谁、什么时候、为什么），或自动。 */
function Current({ pin, models, now }: { pin: ActivePin | undefined; models: ModelChoice[]; now: number }) {
  if (!pin) {
    return (
      <Stack gap="sm">
        <Text strong>自动</Text>
        <Text size="meta" tone="muted">
          按路由两层的顺序选，前面的派不出顺延到下一个
        </Text>
      </Stack>
    );
  }
  const m = models.find((x) => x.modelId === pin.modelId);
  const route = pin.routeId ? m?.routes.find((r) => r.routeId === pin.routeId) : undefined;
  return (
    <Stack gap="sm">
      <span data-pinned={pin.modelId}>
        <Text strong>指定 {m?.name ?? pin.modelId}</Text>
        {pin.routeId ? <Text tone="muted">，只走 {route?.name ?? pin.routeId}</Text> : null}
      </span>
      <Text size="meta" tone="muted">
        {formatAgo(pin.setAt, now)}定的{pin.reason ? `：${pin.reason}` : ''}
      </Text>
    </Stack>
  );
}

function SegmentRow({
  d,
  segment,
  models,
  problem,
  now,
}: {
  d: TaskDetail;
  segment: RoutedSegment;
  models: ModelChoice[];
  problem: string | undefined;
  now: number;
}) {
  const update = useUpdateTaskRoutePin();
  const pin = activePin(d, segment);
  const last = latestRun(d, segment);
  const finished = isTaskFinished(d.task);
  const health = pin && !problem ? pinLiveness(models, pin, segment) : undefined;
  const chosen = pin ? models.find((m) => m.modelId === pin.modelId) : undefined;
  const busy = update.isPending;
  const locked = finished || Boolean(problem) || d.routePins.unavailable !== undefined;

  // 「现在就换」（#1216）：只有动手段、单子在跑没暂停、这一轮的会话正在跑、而且指定的和在跑的不是同一个模型
  const canRepin =
    segment === 'manual' &&
    pin !== undefined &&
    !finished &&
    !locked &&
    d.task.state === 'running' &&
    d.task.paused === undefined &&
    last?.running === true &&
    pin.modelId !== last.model;
  const [confirming, setConfirming] = useState(false);

  // 失败抛给确认框：框留着、写原因、能再点
  const repinNow = async () => {
    if (!pin) return;
    try {
      await update.mutateAsync({
        taskId: d.task.id,
        body: { segment, modelId: pin.modelId, routeId: pin.routeId ?? null, now: true },
      });
      toast.success(`${segmentLabel[segment]}正在换成 ${chosen?.name ?? pin.modelId}`, {
        description: '这一轮已停下，从分支上接着做',
      });
    } catch (e) {
      toast.error('没换成', { description: errorText(e) });
      throw e;
    }
  };

  const send = async (modelId: string | null, routeId: string | null = null) => {
    try {
      await update.mutateAsync({ taskId: d.task.id, body: { segment, modelId, routeId } });
      toast.success(
        modelId === null
          ? `${segmentLabel[segment]}回到自动`
          : `${segmentLabel[segment]}改用 ${models.find((m) => m.modelId === modelId)?.name ?? modelId}`,
        { description: '下一次选路起生效；在跑的这一轮不打断' },
      );
    } catch (e) {
      toast.error('没改成', { description: errorText(e) });
    }
  };

  const help = (
    <Stack gap="sm">
      <Current pin={pin} models={models} now={now} />
      {last ? (
        <span data-last-run>
          <Text size="meta" tone="muted">
            {last.running ? '这一轮在跑的' : '上一轮用的'}是 {last.modelName}
            {last.running && pin && pin.modelId !== last.model ? '：不打断，下一轮起换' : ''}
          </Text>
        </span>
      ) : null}
    </Stack>
  );

  return (
    <div data-pin-segment={segment}>
      <Stack gap="md">
        <FormItem label={segmentLabel[segment]} help={help}>
          <Stack direction="horizontal" gap="sm" align="center" wrap>
            <NativeSelect
              aria-label={`${segmentLabel[segment]}用哪个模型`}
              value={pin?.modelId ?? AUTO}
              disabled={locked || busy}
              onChange={(e) => void send(e.target.value === AUTO ? null : e.target.value)}
            >
              <option value={AUTO}>自动（按路由顺序）</option>
              {models.map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {withLive(m.name, m.liveness)}
                </option>
              ))}
              {pin && !chosen ? <option value={pin.modelId}>{pin.modelId}（不在这个用途里）</option> : null}
            </NativeSelect>
            {chosen && chosen.routes.length > 1 ? (
              <NativeSelect
                aria-label={`${segmentLabel[segment]}走哪条渠道`}
                value={pin?.routeId ?? AUTO}
                disabled={locked || busy}
                onChange={(e) => void send(chosen.modelId, e.target.value === AUTO ? null : e.target.value)}
              >
                <option value={AUTO}>任一渠道（按顺序）</option>
                {chosen.routes.map((r) => (
                  <option key={r.routeId} value={r.routeId}>
                    {withLive(r.name, r.liveness)}
                  </option>
                ))}
              </NativeSelect>
            ) : null}
            {canRepin ? (
              <Button
                size="sm"
                disabledReason={busy ? '正在改' : undefined}
                onClick={() => setConfirming(true)}
              >
                现在就换
              </Button>
            ) : null}
            {pin && !finished ? (
              <Button size="sm" variant="text" loading={busy} onClick={() => void send(null)}>
                回到自动
              </Button>
            ) : null}
          </Stack>
        </FormItem>
        {health && health.verdict !== 'live' ? (
          <div data-pin-health={health.verdict}>
            <Notice tone={health.verdict === 'dead' ? 'fail' : 'stall'}>
              {chosen?.name ?? pin?.modelId}
              {health.verdict === 'dead' ? ' 现在派不出' : ' 现在说不准派不派得出'}：{health.why}。
              引擎轮到这一段时只等它，派不出就停下等你，不会换别的模型；要换就在这里改，或回到自动。
            </Notice>
          </div>
        ) : null}
      </Stack>
      {canRepin && confirming ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setConfirming(false);
          }}
          title={`现在就换到 ${chosen?.name ?? pin?.modelId}？`}
          description={`正在跑的这一轮马上停下，改用 ${chosen?.name ?? pin?.modelId} 在原分支上接着做。这一轮已做的会从分支上接着做，已花的 token 不退。`}
          confirmText="确认现在就换"
          cancelText="先不换"
          onConfirm={repinNow}
        />
      ) : null}
    </div>
  );
}

/** 单子页「用哪个模型」：动手、验收两行，对题一行说明为什么指定不了。 */
export function TaskModelPins({ d, now }: { d: TaskDetail; now: number }) {
  const layers = useRoutingLayers();
  const finished = isTaskFinished(d.task);
  const problems = ROUTED_SEGMENTS.map((segment) => {
    if (d.routePins.unavailable)
      return { segment, models: [], problem: `指定读不了：${d.routePins.unavailable}` };
    if (layers.error)
      return { segment, models: [], problem: `路由没读成，现在没法换：${errorText(layers.error)}` };
    if (!layers.data) return { segment, models: [], problem: undefined };
    const got = choicesFor(layers.data, segment);
    return 'problem' in got
      ? { segment, models: [], problem: got.problem }
      : { segment, models: got.models, problem: undefined };
  });
  const firstProblem = problems.find((p) => p.problem)?.problem;
  return (
    <Section
      variant="plain"
      title="用哪个模型"
      // 块头只留一句；「现在就换」「派不出时停下等你」的整段说明在任务页页头 ⓘ 里（#1920），派不出时这一行下面也会写
      description={finished ? '这张单已经结束，指定只留作记录' : '下一次选路起照它，在跑的这一轮不打断'}
    >
      <Stack gap="lg">
        {firstProblem ? <Notice tone="fail">{firstProblem}</Notice> : null}
        <div data-pin-segment="scope">
          <FormItem
            label={segmentLabel.scope}
            help="在对话里和你一起做，引擎不起会话、不经选路，没有模型可指定"
          >
            <Text tone="muted">不指定</Text>
          </FormItem>
        </div>
        {problems.map((p) => (
          <SegmentRow
            key={p.segment}
            d={d}
            segment={p.segment}
            models={p.models}
            problem={p.problem}
            now={now}
          />
        ))}
      </Stack>
    </Section>
  );
}
