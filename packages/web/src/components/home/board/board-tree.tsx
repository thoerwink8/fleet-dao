// 手机上的看板：画布换成可折叠的树形列表（初版 PR #13 的做法），信息和操作一样不少。
// 一段一组（对题 / 动手 / 验收，有「还没分段」的单才多一组），组里每张单一张卡（整张卡点进单子详情），旁边一个操作菜单。
import { ChevronRight, EllipsisVertical, MessageCircleQuestion, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { cn } from '../../../lib/utils';
import { useRemoteView } from '../../node-notice';
import { StatusDot } from '../../status';
import { useTargetActions } from '../../task-actions';
import { Button } from '../../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { RunningCard } from '../running-card';
import type { HomeFlowStage, HomeRunning } from '../types';
import { targetOfItem } from './board-ui';
import { countTones, groupSegments, nodeId, type SegmentGroup, segmentKeyOf, worstTone } from './model';
import { avgText, segmentHintOf, segmentName } from './nodes';

export function BoardTree({
  running,
  flow,
}: {
  running: readonly HomeRunning[];
  flow: readonly HomeFlowStage[];
}) {
  const [params, setParams] = useSearchParams();
  const stuck = params.get('stuck') === '1';
  const needsYou = params.get('you') === '1';
  const groups = groupSegments(running, flow, { stuck, needsYou });
  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  const toggle = (key: 'stuck' | 'you', on: boolean) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (on) p.delete(key);
        else p.set(key, '1');
        return p;
      },
      { replace: true, preventScrollReset: true },
    );
  return (
    <div className="px-3 pt-3 pb-4" data-flow-board data-board-tree>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={stuck}
          aria-label="只看卡住的：出问题了（不含等你）"
          title="出问题了（不含等你）"
          onClick={() => toggle('stuck', stuck)}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sub transition-colors',
            stuck ? 'border-foreground bg-foreground text-background' : 'bg-card text-muted-foreground',
          )}
        >
          <TriangleAlert className="size-3.5" />
          只看卡住的
        </button>
        <button
          type="button"
          aria-pressed={needsYou}
          aria-label="只看等你的：等你拍（不含出问题）"
          title="等你拍（不含出问题）"
          onClick={() => toggle('you', needsYou)}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sub transition-colors',
            needsYou ? 'border-foreground bg-foreground text-background' : 'bg-card text-muted-foreground',
          )}
        >
          <MessageCircleQuestion className="size-3.5" />
          只看等你的
        </button>
        <span className="num ml-auto text-xs text-muted-foreground">
          {shown}/{running.length}
        </span>
      </div>
      {shown === 0 && (stuck || needsYou) ? (
        <p className="mb-3 text-xs text-muted-foreground">
          {stuck && needsYou
            ? '没有出问题的单，也没有等你拍的单'
            : stuck
              ? '没有出问题的单（不含等你）'
              : '没有等你拍的单'}
        </p>
      ) : null}
      <ul className="space-y-2" aria-label="三段里的单">
        {groups.map((g) => (
          <SegmentRow key={g.key} group={g} running={running} />
        ))}
      </ul>
    </div>
  );
}

function SegmentRow({ group, running }: { group: SegmentGroup; running: readonly HomeRunning[] }) {
  const [open, setOpen] = useState(group.items.length > 0);
  // 颜色按这一段的全部单算（过滤只藏单子，不改这一段的状态色）
  const counts = countTones(running.filter((r) => segmentKeyOf(r) === group.key));
  const tone = group.total ? worstTone(counts) : 'wait';
  return (
    <li className="overflow-hidden rounded-xl border bg-card" data-flow-lane={group.key}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={!group.items.length}
        className="flex w-full items-start gap-2 py-2.5 pr-3 pl-2 text-left disabled:cursor-default"
      >
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground">
          <ChevronRight
            className={cn(
              'size-4 transition-transform',
              open && 'rotate-90',
              !group.items.length && 'opacity-30',
            )}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <StatusDot tone={tone} />
            <span className="text-strong font-semibold">{segmentName(group.key)}</span>
            <span className="ml-auto text-xs text-muted-foreground">
              <span className="num text-foreground">{group.total}</span> 张在途
            </span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {segmentHintOf(group.key)}
          </span>
          <span className="num block truncate text-xs text-muted-foreground">
            {avgText(group.stage, group.key)}
          </span>
        </span>
      </button>
      {open && group.items.length ? (
        <ul className="space-y-1.5 border-t bg-muted/40 p-2">
          {group.items.map((it) => (
            <li key={nodeId.ticket(it)} className="flex items-stretch gap-1">
              <RunningCard item={it} className="min-w-0 flex-1" />
              <ActionsMenu item={it} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ActionsMenu({ item }: { item: HomeRunning }) {
  const remote = useRemoteView() !== null;
  const entries = useTargetActions(targetOfItem(item, remote));
  if (!entries.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-8 shrink-0 self-center"
          aria-label={`#${item.issueNumber} 的操作`}
        >
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {entries.map(({ action, def, run }) => {
          const Icon = def.icon;
          return (
            <DropdownMenuItem key={action} variant={def.danger ? 'destructive' : 'default'} onSelect={run}>
              <Icon />
              {def.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
