// 机器资源三格（#1973、#1985）：这台机器（本台是法国，选了远程环境是那一台）此刻的整机内存、CPU、磁盘。
// 桌面是画布左下「此刻」面板右边紧挨着的一张小卡（board-canvas.tsx 的坞），手机放在主页顶上细栏的第二行
// （顶栏右段放不下，会压到搜索框）。整张是链接，点一下到资源页（/resources，选了远程环境就带着 ?node=）。
// 学 macOS 菜单栏的资源小表（iStat Menus 那一类）：名字 + 具体数值（内存「已用 / 总量」、CPU「忙的核数 / 总核数」、
// 磁盘「已用 / 总量」）+ 一根细条 + 百分比，常驻；全文在每一格的悬停里，详细的在资源页。数值和百分比出自同一回读数
// （resources.ts 的 hostMeters）。数据隔几秒经推送（SSE 的 resources 事件）换一回，细条的宽度跟着走，不整页重拉。
//
// 改这里之前必须知道：
// - 读不到写「没读到」（stop 灰点），原因在悬停里；后端没给、那台没推过，悬停写明没有。绝不写 0、不写正常。
// - 紧（内存 ≥ 85%、CPU ≥ 90%、磁盘 ≥ 90%）细条和数字用提示黄，不用失败红：机器忙不是坏了（health-strip.tsx 头注释「wait / stall
//   提示色（黄系）」的规矩）。色板里 wait 是灰（排队）、和平时的灰条分不开，所以取黄系里真是黄的 stall。
// - 本台超过三个采样间隔没来新读数，写「读数旧了」：推送断了或后端停了采样，数还在但不是此刻的。
// - 放不下时先收细条（< lg）、再收百分比（< sm，手机），数值一直留着；手机上三格挤不下一行时磁盘那格折到第二行
//   （flex-wrap，靠右），不截字。按钮不小于 40 高。
import { Link } from 'react-router';
import { useNow } from '../../lib/hooks';
import { useSelectedNodeId, withNode } from '../../lib/node';
import { cn } from '../../lib/utils';
import { StatusDot } from '../layout/status-badge';
import type { LayoutTone } from '../layout/tone';
import { hostMeters, type Meter } from './resources';
import type { HomeResources } from './types';

function toneOf(meter: Meter, stale: boolean): LayoutTone {
  if (meter.kind === 'unread' || stale) return 'stop';
  return meter.tight ? 'stall' : 'done';
}

/** 一格的数值写法：读成了写「已用 / 总量」，没读到写「没读到」。 */
function amountText(meter: Meter & { kind: 'ok' }): string {
  return meter.amount.kind === 'ok' ? meter.amount.text : '没读到';
}

/** 一格：名字、具体数值、细条、百分比。读不到是灰点加「没读到」。窄屏先收细条、再收百分比，数值一直在。 */
function Cell({ name, meter, stale, id }: { name: string; meter: Meter; stale: boolean; id: string }) {
  const tone = toneOf(meter, stale);
  const strong = meter.kind === 'ok' && meter.tight && !stale;
  return (
    <span
      data-meter={id}
      data-tone={tone}
      title={
        meter.kind === 'ok'
          ? `${name}：${meter.detail}${meter.amount.kind === 'unread' ? `；数值没读到：${meter.amount.why}` : ''}`
          : `${name}没读到：${meter.why}`
      }
      className="flex shrink-0 items-center gap-1.5 text-meta whitespace-nowrap"
    >
      <span className="text-muted-foreground">{name}</span>
      {meter.kind === 'ok' ? (
        <>
          <span
            data-meter-amount
            className={cn(
              'num',
              meter.amount.kind === 'unread'
                ? 'text-muted-foreground'
                : strong
                  ? 'text-ink-stall'
                  : stale
                    ? 'text-muted-foreground'
                    : 'text-foreground',
            )}
          >
            {amountText(meter)}
          </span>
          <span aria-hidden className="h-1.5 w-10 overflow-hidden rounded-full bg-selected max-lg:hidden">
            <span
              className={cn(
                'block h-full rounded-full transition-[width] duration-300 ease-out',
                meter.tight && !stale ? 'bg-st-stall' : 'bg-muted-foreground',
              )}
              style={{ width: `${Math.min(100, Math.max(2, meter.percent))}%` }}
            />
          </span>
          <span
            data-meter-percent
            className={cn(
              'num w-9 text-right font-medium max-sm:hidden',
              strong ? 'text-ink-stall' : stale ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {meter.text}
          </span>
        </>
      ) : (
        <span className="flex items-center gap-1 text-muted-foreground">
          <StatusDot tone="stop" className="size-1.5" />
          没读到
        </span>
      )}
    </span>
  );
}

export function MachineMeter({
  resources,
  remote,
  machine,
  className,
}: {
  resources: HomeResources | undefined;
  /** 看的是别的环境推来的快照：新鲜度由快照横幅说，这里不判旧。 */
  remote: boolean;
  /** 读屏里的机器名：本台不传写「这台机器」。 */
  machine?: string | undefined;
  className?: string;
}) {
  const nodeId = useSelectedNodeId();
  const now = useNow();
  const m = hostMeters(resources, now, { remote });
  const word = (name: string, meter: Meter) =>
    `${name}${meter.kind === 'ok' ? ` ${amountText(meter)} ${meter.text}${meter.tight ? ' 紧' : ''}` : ' 没读到'}`;
  const label = `${machine ?? '这台机器'}的资源：${word('内存', m.memory)}，${word('CPU', m.cpu)}，${word('磁盘', m.disk)}${
    m.stale ? '，读数旧了' : ''
  }。点开看每个上线项目各占多少`;
  return (
    <Link
      to={withNode('/resources', nodeId)}
      data-machine-meter
      aria-label={label}
      title={m.missing}
      className={cn(
        'flex min-h-10 shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-0.5 rounded-md px-1.5 transition-colors duration-100 hover:bg-accent md:min-h-8 md:flex-nowrap',
        className,
      )}
    >
      <Cell id="memory" name="内存" meter={m.memory} stale={m.stale} />
      <Cell id="cpu" name="CPU" meter={m.cpu} stale={m.stale} />
      <Cell id="disk" name="磁盘" meter={m.disk} stale={m.stale} />
      {m.stale ? <span className="text-meta text-muted-foreground max-md:hidden">读数旧了</span> : null}
    </Link>
  );
}
