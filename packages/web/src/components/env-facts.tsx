// 一台环境的六项事实（引擎、在跑的会话、池占用、健康、在用版本、最近拉单）怎么画：法国页的「运行概况」（本台）和「机器」表展开的快照（远程）共用这一份。
//
// 规矩（照搬原来两页，见 specs/820-驾驶舱环境视图与中止恢复/方案.md §5 片 1）：
// - 后端逐项包好「查成了 / 没查成」，这里只把两态如实画：没查成写「没读到 + 原因」，不拿空或 0 顶；一项读失败不连累别的项；
// - 等待色和「真坏了」分开：引擎按配置没开、落后主线、从没跑成是等情况，不画红；没连上、健康红、上次失败才红；
// - 失联的环境（muted）一律灰字、不带状态色，别让旧的「运行中」「N 项红」看起来像现在的状态。
//
// #3533 起照 Arco 样稿（canvas/France.dc.html）：本台是「两个指标 + 一张描述列表」，不再是一项一张卡；
// 页面只拼 components/layout 的件，不写样式类（lint-design R13–R20）。

import type { ReactNode } from 'react';
import type { EnvEngine, EnvFacts, EnvSchedule, EnvVersion } from '../api/types';
import { stageLabel } from '../lib/catalog';
import { formatAgo, formatDateTime } from '../lib/format';
import { type StatusKey, statusEntry } from '../theme/status-dict';
import { Descriptions, type DescriptionsItem } from './layout/descriptions';
import { Stack } from './layout/stack';
import { Stat, StatGrid } from './layout/stat';
import { StatusBadge } from './layout/status-badge';
import { Text } from './layout/text';

/** 引擎：on / off（按配置没开）/ down（真没连上）/ unknown（没查成）四态各说各的。 */
export function engineWords(e: EnvEngine): { status: StatusKey; sub: string } {
  switch (e.state) {
    case 'on':
      return { status: 'machine:engine:on', sub: e.detail ?? '探到了在拉活的工人' };
    case 'off':
      return { status: 'machine:engine:off', sub: e.detail ?? '按 release.env 的 FLEET_SERVICES 没开' };
    case 'down':
      return { status: 'machine:engine:down', sub: e.detail ?? '开着却探不到在线的工人' };
    case 'unknown':
      return { status: 'machine:engine:unknown', sub: e.detail ?? '这台后端没有接引擎探针' };
  }
}

/** 在用版本这一项的状态词；落后几个没读到时不下结论（只写提交号）。 */
export function versionStatus(v: EnvVersion): StatusKey | undefined {
  if (v.current === null || v.problems.length > 0) return 'machine:version:problem';
  if (v.behind === null) return undefined;
  return v.behind > 0 ? 'machine:version:behind' : 'machine:version:current';
}

/** 最近拉单这一项的状态词。 */
export function scheduleStatus(v: EnvSchedule): StatusKey {
  if (v.status === 'never') return 'job:never';
  if (v.outcome === 'failed') return 'job:failed';
  if (v.status !== 'fresh') return 'job:overdue';
  if (v.outcome === 'unscanned') return 'job:unscanned';
  if (v.outcome === 'partial') return 'job:partial';
  return 'job:fresh';
}

/** 一项没读到：橙「没读到」加原因（原因直接写出来，不藏在悬停里）。 */
export function UnreadValue({ reason }: { reason: string }) {
  return (
    <Stack gap="sm">
      <StatusBadge status="machine:fact:unread" />
      <Text size="meta" tone="muted">
        {reason}
      </Text>
    </Stack>
  );
}

/** 状态词：正常画点加字；失联环境（muted）只写灰字。 */
function Word({ status, muted }: { status: StatusKey; muted: boolean }) {
  return muted ? <Text tone="muted">{statusEntry(status).label}</Text> : <StatusBadge status={status} />;
}

/** 六项里几项没查成、健康几项红：小结（都没有就是 null）。 */
export function factsSummary(facts: EnvFacts): string | null {
  const failing = facts.health.ok ? facts.health.value.failing.length : 0;
  const unread = factsUnread(facts);
  const parts: string[] = [];
  if (unread > 0) parts.push(`${unread} 项没查成`);
  if (failing > 0) parts.push(`健康 ${failing} 项红`);
  return parts.length ? parts.join(' · ') : null;
}

/** 几项没查成（含总开关那一项）。 */
export function factsUnread(facts: EnvFacts): number {
  return [
    facts.engine,
    ...(facts.master ? [facts.master] : []),
    facts.version,
    facts.sessions,
    facts.pools,
    facts.health,
    facts.schedule,
  ].filter((f) => !f.ok).length;
}

interface ItemOpts {
  facts: EnvFacts;
  now: number;
  /** 最近拉单「从没跑成」时顺带写一共几个定时任务。 */
  jobCount?: number | undefined;
  /** 失联 / 没数据：状态词改成灰字。 */
  muted?: boolean | undefined;
  /** 带上「在用版本」一项（远程快照里用；本台的版本在版本卡）。 */
  withVersion?: boolean | undefined;
}

function sessionsHint(total: number, byStage: Record<string, number>): string {
  if (total === 0) return '手上没有在跑的会话';
  return Object.entries(byStage)
    .map(([k, n]) => `${stageLabel[k as keyof typeof stageLabel] ?? k} ${n}`)
    .join(' · ');
}

/** 六项事实，一项一个描述列表的条目（读失败的那项值是 UnreadValue，别的项照常）。 */
export function factItems({
  facts,
  now,
  jobCount,
  muted = false,
  withVersion = false,
}: ItemOpts): DescriptionsItem[] {
  const items: DescriptionsItem[] = [];

  if (facts.engine.ok) {
    const w = engineWords(facts.engine.value);
    items.push({ label: '引擎进程', value: <Word status={w.status} muted={muted} />, hint: w.sub });
  } else items.push({ label: '引擎进程', value: <UnreadValue reason={facts.engine.reason} /> });

  if (facts.sessions.ok) {
    const s = facts.sessions.value;
    items.push({ label: '在跑的会话', value: `${s.total} 个`, hint: sessionsHint(s.total, s.byStage) });
  } else items.push({ label: '在跑的会话', value: <UnreadValue reason={facts.sessions.reason} /> });

  if (facts.pools.ok) {
    const p = facts.pools.value;
    items.push({
      label: '池占用',
      value: `${p.count} 块`,
      hint: (
        <Text size="meta" tone={!muted && (p.unread > 0 || p.stale > 0) ? 'warning' : 'muted'}>
          {`在跑 ${p.running}${p.reserved ? ` · 已选定还没开跑 ${p.reserved}` : ''} · 没读成 ${p.unread} · 过期 ${p.stale}`}
        </Text>
      ),
    });
  } else items.push({ label: '池占用', value: <UnreadValue reason={facts.pools.reason} /> });

  if (facts.health.ok) {
    const h = facts.health.value;
    items.push({
      label: '健康',
      value: h.failing.length === 0 ? '没红的' : `${h.failing.length} 项红`,
      hint: (
        <Text size="meta" tone={!muted && h.failing.length > 0 ? 'danger' : 'muted'}>
          {h.failing.length === 0
            ? `${h.total} 项都通；未接 ${h.notWired.length} 项`
            : `红：${h.failing.join('、')}`}
        </Text>
      ),
    });
  } else items.push({ label: '健康', value: <UnreadValue reason={facts.health.reason} /> });

  if (withVersion) {
    if (facts.version.ok) {
      const v = facts.version.value;
      const status = versionStatus(v);
      items.push({
        label: '在用版本',
        value: (
          <Stack direction="horizontal" gap="sm" align="center" wrap>
            <Text mono>{v.current === null ? '没读到' : v.current.slice(0, 12)}</Text>
            {status ? <Word status={status} muted={muted} /> : null}
          </Stack>
        ),
        hint: v.problems.length ? `${v.detail ?? ''} ${v.problems.join('；')}`.trim() : v.detail,
      });
    } else items.push({ label: '在用版本', value: <UnreadValue reason={facts.version.reason} /> });
  }

  if (facts.schedule.ok) {
    const v = facts.schedule.value;
    items.push({
      label: '最近拉单',
      value: (
        <Stack direction="horizontal" gap="sm" align="center" wrap>
          <Word status={scheduleStatus(v)} muted={muted} />
          <span title={v.lastSuccessAt ? `最近一次跑成：${formatDateTime(v.lastSuccessAt)}` : undefined}>
            {v.status === 'never'
              ? '从没跑成'
              : v.lastSuccessAt
                ? formatAgo(v.lastSuccessAt, now)
                : '没查到上次跑成的时间'}
          </span>
        </Stack>
      ),
      hint:
        v.status === 'never'
          ? jobCount !== undefined
            ? `这个环境还没有拉单记录（共 ${jobCount} 个定时任务，拉到才算）`
            : '这个环境还没有拉单记录'
          : v.why
            ? v.why
            : v.outcome === undefined
              ? '上次这一轮还没有结局'
              : `上次结局：${v.outcome}${v.scanned === undefined ? '' : `，扫了 ${v.scanned} 个`}`,
    });
  } else items.push({ label: '最近拉单', value: <UnreadValue reason={facts.schedule.reason} /> });

  return items;
}

/** 远程快照里的六项（加在用版本），一张两列的描述列表。 */
export function FactsList(props: ItemOpts): ReactNode {
  return <Descriptions columns={2} items={factItems({ ...props, withVersion: true })} />;
}

/**
 * 本台的「运行概况」正文：两个指标（在跑的会话、健康检查）加一张描述列表（引擎进程、会话分段、池占用、健康、最近拉单）。
 * 指标读失败写「没读到」，原因在下面的列表里；数字只在异常时上色（健康红、没读到橙）。
 */
export function FactsOverview({
  facts,
  now,
  jobCount,
  extra,
}: {
  facts: EnvFacts;
  now: number;
  jobCount?: number | undefined;
  /** 描述列表下面的补充（描述列表放不下的备注）。 */
  extra?: ReactNode;
}) {
  const { sessions, health } = facts;
  const failing = health.ok ? health.value.failing.length : 0;
  return (
    <Stack gap="lg">
      <StatGrid cols={2}>
        <Stat
          label="在跑的会话"
          value={sessions.ok ? sessions.value.total : '没读到'}
          unit={sessions.ok ? '个' : undefined}
          tone={sessions.ok ? undefined : 'stall'}
        />
        <Stat
          label="健康检查"
          value={health.ok ? (failing > 0 ? failing : health.value.total) : '没读到'}
          unit={health.ok ? (failing > 0 ? '项红' : '项通过') : undefined}
          tone={health.ok ? (failing > 0 ? 'fail' : undefined) : 'stall'}
        />
      </StatGrid>
      <Descriptions columns={2} items={factItems({ facts, now, jobCount })} />
      {extra}
    </Stack>
  );
}
