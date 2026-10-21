// 顶栏右边的引擎状态（照 Main.dc.html 的 .badge：一个圆点加一句字）：读引擎总开关（useMasterView，本台读设置、远程读那台的快照）。
// 点开是一张小卡：状态、那一句说明、去法国页看开关。远程环境只读，卡里写明要去那台上改。
// 手机顶栏放不下字：留一个 40×40 的圆按钮，里面只有那个点（Phone.dc.html）。
import { Link } from 'react-router';
import { localizeIsoTimes } from '../../lib/format';
import { withNode } from '../../lib/node';
import { cn } from '../../lib/utils';
import { useMasterView } from '../engine-master';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

type Dot = 'success' | 'warning' | 'default';

const DOT: Record<Dot, string> = {
  success: 'bg-success',
  warning: 'bg-warn',
  default: 'bg-ink-3',
};

export function StatusPoint({ dot, className }: { dot: Dot; className?: string | undefined }) {
  return <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', DOT[dot], className)} />;
}

function useEngineStatus() {
  const { view, remote, nodeId } = useMasterView();
  if (view.kind === 'ok') {
    const on = view.master.on;
    return {
      state: on ? 'on' : 'off',
      dot: (on ? 'success' : 'warning') as Dot,
      label: on ? '总开关开着' : '总开关关着',
      detail: localizeIsoTimes(view.master.detail),
      remote,
      nodeId,
    };
  }
  const label = view.kind === 'loading' ? '总开关 …' : view.kind === 'absent' ? '总开关没有' : '总开关没查成';
  const detail =
    view.kind === 'absent'
      ? '这个环境的版本还不带引擎总开关'
      : view.kind === 'error'
        ? `引擎总开关没读成：${view.reason}。不当成开着，也不当成关着。`
        : '正在读引擎总开关';
  return { state: view.kind, dot: 'default' as Dot, label, detail, remote, nodeId };
}

export function EngineStatus({ compact = false }: { compact?: boolean }) {
  const s = useEngineStatus();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-engine-master={s.state}
          aria-label={`引擎${s.label}${s.remote ? '（远程环境，只读）' : ''}，点开看详情`}
          className={cn(
            'shrink-0 items-center transition-colors duration-100 hover:bg-fill-2',
            compact
              ? 'relative grid size-10 place-items-center rounded-full border border-line'
              : 'flex h-8 gap-2 rounded-sm px-2 text-body whitespace-nowrap text-ink',
          )}
        >
          <StatusPoint dot={s.dot} className={compact ? 'size-2' : undefined} />
          {compact ? null : <span>{s.label}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-72 flex-col gap-1 p-3" data-engine-master-card>
        <span className="flex items-center gap-2 text-body font-medium text-ink">
          <StatusPoint dot={s.dot} />
          {s.label}
        </span>
        <p className="text-meta text-ink-3">
          {s.detail}
          {s.remote ? '远程环境只读，开关要去那台上改。' : null}
        </p>
        <Link to={withNode('/france', s.nodeId)} className="text-body text-brand-ink hover:text-link-hover">
          去法国页看开关
        </Link>
      </PopoverContent>
    </Popover>
  );
}
