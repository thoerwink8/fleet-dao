// 单子页「用哪个模型」（驾驶舱改版 2026-10-07：「每个任务能点进去随意切换模型」）：动手、验收各一行，下拉选模型（还能钉到一条
// 渠道），或回到自动。写到库里（task_route_pins），引擎下一次给这一段选路就照它；在跑的这一轮不打断。
// 指定的模型派不出时引擎停下等人、不悄悄换别的：页面在下拉里、在这一行上都照路由两层现算的结论说清（lib/route-pins.ts）。
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
import { cn } from '../lib/utils';
import { Panel } from './page';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

const LIVE_WORD: Record<Liveness['verdict'], string> = { live: '派得出', dead: '派不出', unknown: '不确定' };
const LIVE_INK: Record<Liveness['verdict'], string> = {
  live: 'text-ink-done',
  dead: 'text-ink-fail',
  unknown: 'text-ink-stall',
};

function LiveTag({ l }: { l: Liveness }) {
  return <span className={cn('text-caption', LIVE_INK[l.verdict])}>{LIVE_WORD[l.verdict]}</span>;
}

/** 「现在」那一句：指定了谁（谁、什么时候、为什么），或自动。 */
function Current({ pin, models, now }: { pin: ActivePin | undefined; models: ModelChoice[]; now: number }) {
  if (!pin) {
    return (
      <div>
        <div className="text-sub font-medium">自动</div>
        <div className="text-caption text-muted-foreground">按路由两层的顺序选，前面的派不出顺延到下一个</div>
      </div>
    );
  }
  const m = models.find((x) => x.modelId === pin.modelId);
  const route = pin.routeId ? m?.routes.find((r) => r.routeId === pin.routeId) : undefined;
  return (
    <div>
      <div className="text-sub font-medium" data-pinned={pin.modelId}>
        指定 {m?.name ?? pin.modelId}
        {pin.routeId ? (
          <span className="font-normal text-muted-foreground">，只走 {route?.name ?? pin.routeId}</span>
        ) : null}
      </div>
      <div className="text-caption text-muted-foreground">
        {formatAgo(pin.setAt, now)}定的{pin.reason ? `：${pin.reason}` : ''}
      </div>
    </div>
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

  return (
    <li className="grid gap-x-4 gap-y-2 py-3 md:grid-cols-12 md:items-start" data-pin-segment={segment}>
      <div className="md:col-span-1">
        <span className="font-medium">{segmentLabel[segment]}</span>
      </div>
      <div className="min-w-0 md:col-span-4">
        <Current pin={pin} models={models} now={now} />
        {last ? (
          <div className="mt-0.5 text-caption text-muted-foreground" data-last-run>
            {last.running ? '这一轮在跑的' : '上一轮用的'}是 {last.modelName}
            {last.running && pin && pin.modelId !== last.model ? '：不打断，下一轮起换' : ''}
          </div>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 md:col-span-5">
        <Select
          value={pin?.modelId ?? AUTO}
          disabled={locked || busy}
          onValueChange={(v) => void send(v === AUTO ? null : v)}
        >
          <SelectTrigger size="sm" className="w-56" aria-label={`${segmentLabel[segment]}用哪个模型`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO}>自动（按路由顺序）</SelectItem>
            {models.map((m) => (
              <SelectItem key={m.modelId} value={m.modelId}>
                <span className="num">{m.name}</span>
                <LiveTag l={m.liveness} />
              </SelectItem>
            ))}
            {pin && !chosen ? (
              <SelectItem value={pin.modelId}>
                <span className="num">{pin.modelId}</span>
                <span className="text-caption text-ink-fail">不在这个用途里</span>
              </SelectItem>
            ) : null}
          </SelectContent>
        </Select>
        {chosen && chosen.routes.length > 1 ? (
          <Select
            value={pin?.routeId ?? AUTO}
            disabled={locked || busy}
            onValueChange={(v) => void send(chosen.modelId, v === AUTO ? null : v)}
          >
            <SelectTrigger size="sm" className="w-56" aria-label={`${segmentLabel[segment]}走哪条渠道`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>任一渠道（按顺序）</SelectItem>
              {chosen.routes.map((r) => (
                <SelectItem key={r.routeId} value={r.routeId}>
                  <span>{r.name}</span>
                  <LiveTag l={r.liveness} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      <div className="md:col-span-2 md:text-right">
        {pin && !finished ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void send(null)}>
            回到自动
          </Button>
        ) : null}
      </div>
      {health && health.verdict !== 'live' ? (
        <p
          role="alert"
          className={cn(
            'rounded-md px-3 py-2 text-sub md:col-span-11 md:col-start-2',
            health.verdict === 'dead' ? 'bg-st-fail/10 text-ink-fail' : 'bg-st-stall/10 text-ink-stall',
          )}
          data-pin-health={health.verdict}
        >
          {chosen?.name ?? pin?.modelId}
          {health.verdict === 'dead' ? ' 现在派不出' : ' 现在说不准派不派得出'}：{health.why}。
          引擎轮到这一段时只等它，派不出就停下等你，不会换别的模型；要换就在这里改，或回到自动。
        </p>
      ) : null}
    </li>
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
  return (
    <Panel
      title="用哪个模型"
      description={
        finished
          ? '这张单已经结束，指定只留作记录。'
          : '给这张单的动手、验收指定模型：下一次选路起照它，在跑的这一轮不打断。指定的派不出时引擎停下等你，不悄悄换别的。'
      }
      bodyClassName="px-4 py-1"
      className="mt-4"
    >
      <ul className="divide-y">
        <li className="grid gap-x-4 gap-y-1 py-3 md:grid-cols-12 md:items-baseline" data-pin-segment="scope">
          <span className="font-medium text-muted-foreground md:col-span-1">{segmentLabel.scope}</span>
          <span className="text-sub text-muted-foreground md:col-span-11">
            在对话里和你一起做，引擎不起会话、不经选路，没有模型可指定
          </span>
        </li>
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
      </ul>
      {problems.find((p) => p.problem) ? (
        <p role="alert" className="mb-3 rounded-md bg-st-fail/10 px-3 py-2 text-sub text-ink-fail">
          {problems.find((p) => p.problem)?.problem}
        </p>
      ) : null}
    </Panel>
  );
}
