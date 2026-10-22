// 通知中心（/notifications；#3533 照 Arco 改版，样稿 canvas/Inbox.dc.html）：要你拍的、卡住报警、日报。
// 一块卡头（待处理数、通知设置）带两组筛选；下面左边一列通知（标题一行、灰字一行），右边是选中那条的详情，
// 「要你拍」的选项和自己写一句、看门狗卡的受控修复（#3034）都在详情里。
// 数字是接口给的真实总数，读不到写「—」；读失败、刷新没成、谁在处理没算成，各有各的提示，不画成 0 或「正常」。
// 页面只拼 components/layout 的件，不写样式类（design 第三节、lint-design R13–R20）。
import { useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { brand } from '#brand';
import {
  errorText,
  keys,
  NOTIFICATIONS_PAGE,
  useAnswerNotification,
  useMe,
  useNotifications,
  useResolveNotification,
} from '../api/client';
import type { Notification, NotificationLevel } from '../api/types';
import type { RepairRefresh } from '../components/alert-repair';
import type { AnswerInput } from '../components/decision-picker';
import { Button } from '../components/layout/button';
import { EmptyState } from '../components/layout/empty-state';
import { FilterTabs } from '../components/layout/filter-tabs';
import { Grid } from '../components/layout/grid';
import { TextLink } from '../components/layout/link';
import { List } from '../components/layout/list';
import { LoadError, LoadingRows, LoadPartial } from '../components/layout/load-state';
import { Page } from '../components/layout/page';
import { Section } from '../components/layout/section';
import { Stack } from '../components/layout/stack';
import { Tag } from '../components/layout/tag';
import { Text } from '../components/layout/text';
import { type NoticeActions, NoticeDetail } from '../components/notice-center/notice-detail';
import { DailyFold, type DayGroup, NoticeRows } from '../components/notice-center/notice-list';
import { isWatchdogAlert } from '../lib/alert-repair';
import { decisionToast } from '../lib/decision-result';
import { TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { pendingCount } from '../lib/notice-count';

export function meta() {
  return [{ title: brand.title('通知中心') }];
}

const LEVELS: { id: 'all' | NotificationLevel; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'decision', label: '要你拍' },
  { id: 'alert', label: '卡住报警' },
  { id: 'daily', label: '日报' },
];

function dayOf(iso: string, now: number): string {
  const d = new Date(iso);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const t = d.getTime();
  if (t >= today.getTime()) return '今天';
  if (t >= today.getTime() - TIME.DAY) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function groupByDay(items: Notification[], now: number): DayGroup[] {
  const groups = new Map<string, Notification[]>();
  for (const n of items) {
    const k = dayOf(n.createdAt, now);
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }
  return [...groups.entries()].map(([day, dayItems]) => ({ day, items: dayItems }));
}

/** 通知靠推送更新，没有定时重拉。这份快照超过 5 分钟还没再读成，刷新条标「数据已过期」。 */
const NOTIFICATIONS_STALE_AFTER_MS = 5 * TIME.MIN;

export default function Notifications() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') === 'all' ? 'all' : 'open';
  const level = (LEVELS.find((l) => l.id === params.get('level'))?.id ?? 'all') as 'all' | NotificationLevel;
  const selectedId = params.get('id') ?? undefined;
  const [limit, setLimit] = useState(NOTIFICATIONS_PAGE);
  const qc = useQueryClient();
  // 必须在 useNotifications 订阅之前拍下来：订阅发生在渲染里，拍晚了看到的是这一页自己刚发起的那次。
  // 外壳角标和这一页共用 ['notifications', status]。全局 staleTime（5 秒）内进页不重读；
  // 那次读取还在飞时，新观察者只跟上、不另开。后端若在进页前刚断，跟上的是断之前发出的，
  // 回来仍是成功，页面就把旧的当成这次读成了（e2e 08「用着用着后端断了」时红时绿）。
  const [entry] = useState(() => {
    const state = qc.getQueryState(keys.notifications(status));
    return {
      hadData: state?.data !== undefined,
      busy: state?.fetchStatus === 'fetching' || state?.fetchStatus === 'paused',
      invalidated: state?.isInvalidated === true,
      updatedAt: state?.dataUpdatedAt ?? 0,
    };
  });
  const { data, error, isLoading, isFetching, dataUpdatedAt, refetch } = useNotifications(status, limit);
  const rereadOnce = useRef(false);
  useEffect(() => {
    if (rereadOnce.current) return;
    const raw = qc.getDefaultOptions().queries?.staleTime;
    const staleMs = typeof raw === 'number' ? raw : 0;
    const fresh =
      entry.hadData &&
      !entry.busy &&
      !entry.invalidated &&
      staleMs > 0 &&
      Date.now() - entry.updatedAt < staleMs;
    // 不新鲜、也没有在飞的读取：进页自己的那次订阅会读，不必再强制一次。
    if (!entry.busy && !fresh) return;
    rereadOnce.current = true;
    // 在飞且还没有数据时，refetch 会跟上那一次而不是另开（cancelRefetch 只在已有数据时才取消）。
    // 先取消，晚到的成功就盖不掉这次失败。这一页卸了也要把补读做完，外壳才不会停在没数据上。
    void (async () => {
      if (entry.busy) await qc.cancelQueries({ queryKey: keys.notifications(status) });
      await refetch();
    })();
  }, [qc, refetch, entry, status]);
  const { data: me } = useMe();
  const resolve = useResolveNotification();
  const answerMutation = useAnswerNotification();
  const now = useNow();

  // 没读到时 all 是空的，但下面先判 isLoading、!data、listEmpty 再画列表：读失败不会画成「没有提醒」
  const all: Notification[] = data ? data.items : [];
  const totalCount = data ? data.counts.decision + data.counts.alert + data.counts.daily : 0;
  const shownTotal = data && level !== 'all' ? data.counts[level] : totalCount;
  const list = all.filter((n) => level === 'all' || n.level === level);
  // 只在「全部」级别视图折叠日报；「日报」标签页直接铺开。待处理/连已处理只影响接口过滤，不改折叠。
  const foldDaily = level === 'all';
  const actionItems = foldDaily ? list.filter((n) => n.level !== 'daily') : list;
  const dailyItems = foldDaily ? list.filter((n) => n.level === 'daily') : [];
  const selected = selectedId ? all.find((n) => n.id === selectedId) : undefined;

  const set = (key: string, value: string | null) => {
    const p = new URLSearchParams(params);
    if (value === null) p.delete(key);
    else p.set(key, value);
    setParams(p, { replace: true });
  };

  const done = (n: Notification) =>
    resolve.mutate(n.id, {
      // 看门狗的卡手动标处理不冒充修好（#3034）：只是不再提醒
      onSuccess: () =>
        toast.success('处理了', {
          description: isWatchdogAlert(n) ? `${n.title}（只是不再提醒，没核实修好）` : n.title,
        }),
      onError: (e) => toast.error('没处理成', { description: errorText(e) }),
    });

  const answer = (n: Notification, input: AnswerInput) =>
    answerMutation.mutate(
      { id: n.id, body: input },
      {
        onSuccess: (r) => {
          // 系统照着做的结果照实说（#2353）：没做成不弹成「都好了」，卡留着、上面写原因
          const t = decisionToast(r);
          toast[t.level](t.title, { description: t.description });
        },
        onError: (e) => toast.error('没记下', { description: errorText(e) }),
      },
    );

  // 修复点之前重读一次：读失败时 React Query 留着旧数据，不能拿旧的当现在的
  const refreshRepair: RepairRefresh = async (id) => {
    const r = await refetch();
    if (r.isError || !r.data) return { ok: false, why: r.error ? errorText(r.error) : '没读到' };
    return { ok: true, n: r.data.items.find((x) => x.id === id) };
  };
  const actions: NoticeActions = {
    resolvePending: resolve.isPending,
    resolveId: resolve.variables,
    answeringId: answerMutation.isPending ? answerMutation.variables?.id : undefined,
    onDone: done,
    onAnswer: answer,
    onRefreshRepair: refreshRepair,
  };
  const listEmpty = foldDaily ? actionItems.length === 0 && dailyItems.length === 0 : list.length === 0;
  const handlingProblem = data?.handlingProblem;
  const pick = (id: string) => set('id', id);

  return (
    <Page
      title="通知中心"
      refresh={{
        onRefresh: () => void refetch(),
        isFetching,
        dataUpdatedAt,
        staleAfterMs: NOTIFICATIONS_STALE_AFTER_MS,
      }}
    >
      <Stack>
        {/* 读失败：有旧数据时下面照旧列着上一次读到的（刷新条标「数据已过期」），不画成空，也不拿 0 冒充 */}
        {error ? <LoadError what="提醒" error={error} onRetry={() => void refetch()} /> : null}
        {handlingProblem ? (
          <LoadPartial>{handlingProblem}（提醒照常列出，只是看不出谁在处理）</LoadPartial>
        ) : null}

        <Section
          title={
            <>
              通知
              {/* 结论只在「待处理」里有：接口的计数跟着视图走，「连已处理的」里那几个数不是待处理数 */}
              {data && status === 'open' ? (
                <Tag>
                  <span data-testid="pending-rule">待处理 {pendingCount(data.counts)}</span>
                </Tag>
              ) : null}
            </>
          }
          actions={<TextLink to="/settings#notify">通知设置</TextLink>}
        >
          <Stack gap="md">
            <FilterTabs
              mode="toggle"
              variant="segmented"
              aria-label="处理状态"
              items={[
                { id: 'open', label: '待处理' },
                { id: 'all', label: '连已处理的一起看' },
              ]}
              value={status}
              onChange={(s) => set('status', s === 'open' ? null : 'all')}
            />
            <FilterTabs
              aria-label="按级别"
              items={LEVELS.map((l) => ({
                id: l.id,
                label: l.label,
                // 数字是接口给的真实总数，不是这一页取回的条数（只取了前 N 条时也不会封顶）。
                // 没读到就写「—」（count 传 null），不拿 0 冒充「没有提醒」。真的没有（读成功且总数 0）才写 0。
                count: data ? (l.id === 'all' ? totalCount : data.counts[l.id]) : null,
              }))}
              value={level}
              onChange={(id) => set('level', id === 'all' ? null : id)}
            />
          </Stack>
        </Section>

        {isLoading ? (
          <Section>
            <LoadingRows rows={5} />
          </Section>
        ) : !data ? null : listEmpty ? (
          <Section>
            <EmptyState
              icon={Bell}
              title={status === 'open' ? '没有待处理的提醒' : '这里没有提醒'}
              hint="要你拍板或有东西卡住时，这里和飞书会同时提醒。"
            />
          </Section>
        ) : (
          <Grid preset="split">
            <Stack>
              <Section flush aria-label="通知列表">
                <List>
                  <NoticeRows
                    groups={groupByDay(actionItems, now)}
                    now={now}
                    me={me}
                    selectedId={selected?.id}
                    handlingProblem={handlingProblem}
                    onPick={pick}
                  />
                  {foldDaily && dailyItems.length > 0 ? (
                    <DailyFold key="daily-fold" count={dailyItems.length}>
                      <List>
                        <NoticeRows
                          groups={groupByDay(dailyItems, now)}
                          now={now}
                          me={me}
                          selectedId={selected?.id}
                          handlingProblem={handlingProblem}
                          onPick={pick}
                        />
                      </List>
                    </DailyFold>
                  ) : null}
                </List>
              </Section>
              {data.nextCursor ? (
                <Section>
                  <Stack gap="sm">
                    <Text size="meta" tone="muted">
                      只取回了最近 {all.length} 条，共 {totalCount} 条
                      {level === 'all'
                        ? ''
                        : `（${LEVELS.find((l) => l.id === level)?.label}共 ${shownTotal} 条）`}
                      。
                    </Text>
                    <Stack direction="horizontal">
                      <Button
                        size="sm"
                        {...(isFetching ? { disabledReason: '正在读，等它回话' } : {})}
                        onClick={() => setLimit((v) => v + NOTIFICATIONS_PAGE)}
                      >
                        再多看 {NOTIFICATIONS_PAGE} 条
                      </Button>
                    </Stack>
                  </Stack>
                </Section>
              ) : null}
            </Stack>
            {selected ? (
              <NoticeDetail
                key={selected.id}
                n={selected}
                now={now}
                me={me}
                handlingProblem={handlingProblem}
                onClose={() => set('id', null)}
                {...actions}
              />
            ) : (
              <Section aria-label="通知详情">
                <EmptyState icon={Bell} title="还没选通知" hint="点左侧一行，在这里看详情和处理。" />
              </Section>
            )}
          </Grid>
        )}
      </Stack>
    </Page>
  );
}
