// 法国页的「版本」卡（#1231 发版卡、#1232/#1255 发布入口、#2026 一条龙、#2027 恢复按钮；#3509 起照 Arco 样稿 canvas/France.dc.html 并成一张）：
// 卡头两个按钮——「发版预检」（只读，点了在卡里摆结果）和「发布到法国」（一页唯一的主按钮，不能发就置灰、原因写在旁边）；
// 正文是一张描述列表：主线最新（提交号、CI）、法国在用、和主线差几个（PR 点开看）、最近做完的任务、release-train 此刻的状态、发后体检。
// 发版在走、卡住、没成时下面画九步时间线，卡住、没成后出重试 / 恢复引擎开关 / 撤掉暂停三个按钮（每个点了先弹确认框写明后果）。
// 每一项都带「查成了 / 没查成 + 原因」，没查成的写「没读到」和原因，不拿空、0 或「已是最新」顶。发版单位是主线提交（决定 0032）。
// 页面只拼 components/layout 的件，不写样式类（lint-design R13–R20）。

import type { ReleaseRecoverKind } from '@fleet-dao/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SESSION_WAIT_MS } from '../../../../deploy/france/release-request/session-wait.mjs';
import { errorText, useFrancePreflight, useFranceRelease, useFranceReleaseRecover } from '../api/client';
import type { EnvFacts, FrancePreflightResponse, FranceReleaseState, ReleaseCard } from '../api/types';
import { formatAgo } from '../lib/format';
import { checkLine, lastLine, preflightItems, stepRows, timelineHead } from '../lib/release-timeline';
import type { Level, StatusKey } from '../theme/status-dict';
import { UnreadValue, versionStatus } from './env-facts';
import { Button } from './layout/button';
import { Collapse } from './layout/collapse';
import { ConfirmDialog } from './layout/confirm-dialog';
import { Descriptions, type DescriptionsItem } from './layout/descriptions';
import { LoadError, LoadingRows } from './layout/load-state';
import { Notice } from './layout/notice';
import { Section } from './layout/section';
import { Stack } from './layout/stack';
import { StatusBadge } from './layout/status-badge';
import { Tag } from './layout/tag';
import { Text, type TextTone } from './layout/text';
import { Timeline } from './layout/timeline';

function Sha({ short }: { short: string }) {
  return <Tag mono>{short}</Tag>;
}

type Ci = Extract<ReleaseCard['mainline'], { state: 'ok' }>['ci'];

function CiBadge({ ci }: { ci: Ci }) {
  return (
    <span data-ci={ci.state}>
      <StatusBadge status={`release:ci:${ci.state}` satisfies StatusKey} />
    </span>
  );
}

type Last = ReleaseCard['action']['last'];

const STEP_STATUS: Record<'done' | 'current' | 'blocked' | 'failed' | 'todo', Level> = {
  done: 'success',
  current: 'processing',
  blocked: 'warning',
  failed: 'error',
  todo: 'default',
};

/** 九步时间线（#2026）：第几步、在等什么、已用多久；数据来自法国的 release-train.json。 */
function ReleaseTimeline({ last, now }: { last: Last; now: number }) {
  const timeline = last.timeline;
  if (!timeline) return null;
  const rows = stepRows(timeline, last.state, last.why, now);
  return (
    <div data-release-timeline={last.state}>
      <Stack gap="md">
        <span data-timeline-head>
          <Text strong>{timelineHead(timeline, last.state, now)}</Text>
        </span>
        <Timeline
          items={rows.map((r) => ({
            title: `${r.index + 1}　${r.name}`,
            description: r.text,
            status: STEP_STATUS[r.state],
          }))}
        />
      </Stack>
    </div>
  );
}

/** 发后体检（#2026）：「通过」或「没通过：哪几项」，每项一行（点开看）。 */
function ReleaseCheck({ check }: { check: NonNullable<Last['check']> }) {
  const line = checkLine(check);
  return (
    <div data-release-check={line.ok ? 'ok' : 'bad'}>
      <Stack gap="sm">
        <Stack direction="horizontal" gap="sm" align="center" wrap>
          <StatusBadge status={line.ok ? 'release:check:pass' : 'release:check:fail'} />
          <Text tone={line.ok ? 'secondary' : 'danger'}>{line.text}</Text>
        </Stack>
        <Collapse title={`${line.ok ? '展开' : '看'} ${check.items.length} 项`} defaultOpen={!line.ok}>
          <Stack gap="sm">
            {check.items.map((x) => (
              <div key={x.name} data-check-item={x.ok ? 'ok' : 'bad'}>
                <Stack direction="horizontal" gap="sm" align="baseline" wrap>
                  <StatusBadge status={x.ok ? 'release:check:pass' : 'release:check:fail'} variant="dot" />
                  <Text strong>{x.name}</Text>
                  <Text size="meta" tone="muted">
                    {x.text}
                  </Text>
                </Stack>
              </div>
            ))}
          </Stack>
        </Collapse>
      </Stack>
    </div>
  );
}

const PREFLIGHT_STATUS = {
  ok: 'release:check:pass',
  block: 'release:step:blocked',
  info: 'release:preflight:info',
} as const satisfies Record<'ok' | 'block' | 'info', StatusKey>;

/** 确认框里的预检清单（#2026）：打开框时现读一遍；有卡住项、没读到、没跑成，确认键灰着并写哪项。 */
function preflightView(preflight: ReturnType<typeof useFrancePreflight>): {
  node: ReactNode;
  blockedWhy: string | null;
} {
  const result = preflight.data;
  if (preflight.isPending || (!result && !preflight.isError)) {
    return {
      node: (
        <Text size="meta" tone="muted">
          预检在跑（只读，不暂停、不发版）…
        </Text>
      ),
      blockedWhy: '预检还没跑完',
    };
  }
  if (preflight.isError) {
    const why = `预检没跑成：${errorText(preflight.error)}`;
    return {
      node: (
        <Text size="meta" tone="danger">
          {why}
        </Text>
      ),
      blockedWhy: why,
    };
  }
  if (!result) return { node: null, blockedWhy: '预检还没跑完' };
  if (result.state === 'unreadable') {
    const why = `预检没查成：${result.why}`;
    return {
      node: (
        <Text size="meta" tone="warning">
          {why}
        </Text>
      ),
      blockedWhy: why,
    };
  }
  const items = preflightItems(result.stdout);
  const blocks = items.filter((i) => i.kind === 'block');
  const blockedWhy =
    items.length === 0
      ? '预检没给出清单'
      : blocks.length > 0 || result.code !== 0
        ? `有 ${blocks.length} 项卡住，确认键先灰着：${blocks.map((b) => b.text).join('；')}`
        : null;
  return {
    node: (
      <div data-preflight-list>
        <Stack gap="sm">
          {items.map((i) => (
            <div key={i.text} data-preflight-item={i.kind}>
              <Stack direction="horizontal" gap="sm" align="baseline">
                <StatusBadge status={PREFLIGHT_STATUS[i.kind]} variant="dot" />
                <Text size="meta">{i.text}</Text>
              </Stack>
            </div>
          ))}
        </Stack>
      </div>
    ),
    blockedWhy,
  };
}

type Recover = NonNullable<ReleaseCard['action']['recover']>;

const RECOVER_COPY: Record<
  ReleaseRecoverKind,
  { label: string; title: string; confirm: string; submitted: string; notSubmitted: string }
> = {
  retry: {
    label: '重试',
    title: '重试：从卡住的这一步接着走？',
    confirm: '确认重试',
    submitted: '已提交重试请求',
    notSubmitted: '没能提交重试请求',
  },
  restore: {
    label: '恢复引擎开关',
    title: '恢复引擎开关？',
    confirm: '确认恢复',
    submitted: '已提交恢复引擎开关请求',
    notSubmitted: '没能提交恢复引擎开关请求',
  },
  abort: {
    label: '撤掉暂停',
    title: '撤掉暂停？',
    confirm: '确认撤掉',
    submitted: '已提交撤掉暂停请求',
    notSubmitted: '没能提交撤掉暂停请求',
  },
};

/** 确认框里写明每个按钮点了之后会怎样（后果）；撤掉暂停的后果由后端按进度记录算好带来。 */
function recoverBody(kind: ReleaseRecoverKind, recover: Recover): string {
  if (kind === 'retry') {
    return `卡在${recover.retry?.phase ?? '等收尾'}：法国现场没动（引擎总开关还关着、没发版）。点「确认重试」从这一步接着等会话收尾，往后照走，不从头暂停一遍。`;
  }
  if (kind === 'restore') {
    return `${recover.restore?.target ?? '这一版'} 已经发出去了，引擎总开关发版前是开着的、现在没开回。点「确认恢复」按发版前记下的状态把它开回，再核对各仓「让 AI 接活」开关没被动过。`;
  }
  return recover.abort?.text ?? '';
}

/**
 * 卡住、失败后的三个按钮（#2027）：重试（从卡住那一步接着走）、恢复引擎开关（发完没开回）、撤掉暂停（等价命令行 abort）。
 * 能不能点由后端按进度记录、暂停标记、引擎总开关算好带来（action.recover），这里只画；点了先弹确认框写明后果，
 * 确认才发请求（后端再核一遍、记操作记录、写请求文件，法国上 root 的单元接活）。
 */
function ReleaseRecoverButtons({ recover }: { recover: Recover }) {
  const mut = useFranceReleaseRecover();
  const [asking, setAsking] = useState<ReleaseRecoverKind | null>(null);
  const kinds = (['retry', 'restore', 'abort'] as const).filter((k) => recover[k] !== null);
  if (kinds.length === 0) return null;
  const copy = asking === null ? null : RECOVER_COPY[asking];
  const confirm = async () => {
    if (asking === null) return;
    const c = RECOVER_COPY[asking];
    try {
      await mut.mutateAsync(asking);
      toast.success(c.submitted, { description: '法国接活后，版本卡显示进度；操作记录里有这一条。' });
    } catch (e) {
      toast.error(c.notSubmitted, { description: errorText(e) });
      throw e;
    }
  };
  return (
    <div data-release-recover>
      <Stack gap="sm">
        <Stack direction="horizontal" gap="sm" wrap>
          {kinds.map((k) => (
            <Button
              key={k}
              size="sm"
              variant="outline"
              loading={mut.isPending && mut.variables === k}
              onClick={() => setAsking(k)}
            >
              {RECOVER_COPY[k].label}
            </Button>
          ))}
        </Stack>
        <Text size="meta" tone="muted">
          每个按钮点了先确认，后果写在确认框里，确认后记一条操作记录。
        </Text>
      </Stack>
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(o) => (o ? undefined : setAsking(null))}
        title={copy?.title}
        description={<span data-recover-body>{asking === null ? '' : recoverBody(asking, recover)}</span>}
        confirmText={copy?.confirm}
        onConfirm={confirm}
      >
        <Text size="meta" tone="muted" block>
          点了会记一条操作记录（谁、什么时候点的），法国接活后这里显示进度。
        </Text>
      </ConfirmDialog>
    </div>
  );
}

const LAST_TONE: Record<'ok' | 'warn' | 'fail' | 'plain', TextTone> = {
  ok: 'secondary',
  warn: 'warning',
  fail: 'danger',
  plain: 'muted',
};

/**
 * 「发布到法国」按钮（#1232）：点开弹窗先现跑一遍预检、清单摆在框里（#2026），写明要发的提交、会带上哪几个 PR、发完引擎总开关恢复到发版前；
 * 预检有卡住项时「确认发布」灰着并写哪项。点「确认发布」才发：后端核它等于此刻主线头、记操作记录、写请求文件，法国上 root 的单元接活。
 * 不能点（CI 不绿、已有发版在走、没装接活单元……）就置灰并写原因。
 */
function PublishButton({ card }: { card: ReleaseCard }) {
  const release = useFranceRelease();
  const preflight = useFrancePreflight();
  const [asking, setAsking] = useState(false);
  const { action, mainline, gap } = card;
  const head = mainline.state === 'ok' ? mainline.commit : null;
  const ready = action.state === 'ready' && head !== null;
  const pf = preflightView(preflight);
  const { mutate: runPreflight } = preflight;
  // 框一打开就现跑一遍预检（只读）：确认之前该看的都摆在框里
  useEffect(() => {
    if (asking) runPreflight();
  }, [asking, runPreflight]);
  // 确认框等它：成功框关、弹成功；失败弹 toast 并抛给框——框留着写原因、能再点（#2009）
  const confirm = async () => {
    if (head === null) return;
    try {
      await release.mutateAsync(head.sha);
      toast.success(`已提交发布请求：${head.short}`, {
        description: '法国接活后，版本卡显示九步进度；发完引擎总开关恢复到发版前，再做发后体检。',
      });
    } catch (e) {
      toast.error('没能提交发布请求', { description: errorText(e) });
      throw e;
    }
  };
  const why =
    action.state === 'blocked' && action.reasons.length > 0
      ? action.reasons.join('；')
      : head === null
        ? '主线头没读到，不知道要发哪一个提交'
        : '现在不能发';
  return (
    <>
      <Button
        size="sm"
        variant="primary"
        aria-label="发布到法国"
        {...(ready ? {} : { disabledReason: why })}
        loading={release.isPending}
        onClick={() => setAsking(true)}
      >
        {release.isPending ? '正在提交…' : '发布到法国'}
      </Button>
      <ConfirmDialog
        open={asking && head !== null}
        onOpenChange={setAsking}
        title="发布到法国？"
        description={
          <>
            要发的提交：<Tag mono>{head?.short}</Tag> {head?.title}
          </>
        }
        confirmText="确认发布"
        {...(pf.blockedWhy !== null ? { confirmDisabled: true } : {})}
        onConfirm={confirm}
      >
        <div data-release-preflight>
          <Stack gap="md">
            <Stack direction="horizontal" gap="sm" align="center" justify="between">
              <Text strong>预检（打开这个框时现读的）</Text>
              <Button
                size="xs"
                variant="text"
                loading={preflight.isPending}
                onClick={() => preflight.mutate()}
              >
                重新预检
              </Button>
            </Stack>
            {pf.node}
            {pf.blockedWhy !== null && !preflight.isPending ? (
              <span data-preflight-blocked>
                <Text size="meta" tone="warning">
                  {pf.blockedWhy}
                </Text>
              </span>
            ) : null}
            {gap.state === 'ahead' ? (
              <Stack gap="sm">
                <Text>会带上 {gap.count} 个提交，最近合进去的 PR：</Text>
                {gap.prs.map((p) => (
                  <Text key={p.number} size="meta">
                    <Text size="meta" tone="muted">
                      #{p.number}
                    </Text>{' '}
                    {p.title}
                  </Text>
                ))}
              </Stack>
            ) : null}
            <Text size="meta" tone="muted" block>
              点「确认发布」就是同意对外发布，并记一条操作记录。之后全自动：法国先暂停引擎总开关、等在跑的会话收尾（最多{' '}
              {SESSION_WAIT_MS / 60_000}{' '}
              分钟），再发版；发完把引擎总开关恢复到发版前（发前开着的开回，发前关着的保持关），各仓「让 AI
              接活」开关发版不动；最后做发后体检。开始、成功、卡住、失败各推飞书一条。
            </Text>
          </Stack>
        </div>
      </ConfirmDialog>
    </>
  );
}

/** release-train 此刻的一个状态：在走（卡住、没成）/ 暂停标记没人收 / 没在走 / 没读到。 */
function trainState(release: FranceReleaseState): { status: StatusKey; text: string } {
  switch (release.state) {
    case 'running':
      return {
        status:
          release.status === 'blocked'
            ? 'release:step:blocked'
            : release.status === 'failed'
              ? 'release:step:failed'
              : 'release:step:current',
        text: `${release.phase} · ${release.target}${release.marker ? ' · 派活已暂停' : ' · 暂停标记没写'}${release.why ? ` · ${release.why}` : ''}`,
      };
    case 'paused':
      return {
        status: 'release:train:paused',
        text: '暂停标记在、但一趟的记录不在。这不是正在发的一趟。真发版点上面的「发布到法国」',
      };
    case 'idle':
      return {
        status: 'release:train:idle',
        text: '发版前点「发版预检」看能不能发（只读，不暂停、不发版）。真发版点上面的「发布到法国」',
      };
    default:
      return { status: 'release:train:unread', text: release.why };
  }
}

/** 点「发版预检」后摆在卡里的结果：能发 / 不能发、命令和退出码、一项一行的输出；没接上写没读到和原因。 */
function PreflightResult({ result }: { result: FrancePreflightResponse }) {
  if (result.state === 'unreadable') {
    return (
      <Notice tone="stall" title="发版预检没查成">
        {result.why}
      </Notice>
    );
  }
  const go = result.code === 0;
  const caution = go && result.stdout.includes('：留意');
  const lines = (text: string) => text.split(/\r?\n/).filter((l) => l.trim() !== '');
  return (
    <div data-preflight-result>
      <Stack gap="md">
        <Stack direction="horizontal" gap="sm" align="center" wrap>
          <StatusBadge status={go ? 'release:preflight:go' : 'release:preflight:stop'} />
          {caution ? (
            <Text size="meta" tone="muted">
              能发。有几项要留意，看下面
            </Text>
          ) : go ? null : (
            <Text size="meta" tone="muted">
              不能发，看下面哪一项卡住或读不到
            </Text>
          )}
        </Stack>
        <Text size="meta" tone="muted" block>
          <Text size="meta" tone="muted" mono>
            {result.command}
          </Text>
          {' · '}退出码 {result.code ?? '（没给）'}
          {result.signal ? `，信号 ${result.signal}` : ''}
          {' · 用了 '}
          {Math.round(result.durationMs / 100) / 10} 秒{result.timedOut ? '（读超时被停）' : ''}
          {result.truncated ? '（输出超长已截断）' : ''}
        </Text>
        {result.stdout ? (
          <Stack gap="sm">
            {lines(result.stdout).map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 输出的行没有身份，顺序就是它的身份。
              <Text key={i} size="meta" mono>
                {l}
              </Text>
            ))}
          </Stack>
        ) : null}
        {result.stderr ? (
          <Stack gap="sm">
            <Text size="meta" tone="danger" strong>
              报错：
            </Text>
            {lines(result.stderr).map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 输出的行没有身份，顺序就是它的身份。
              <Text key={i} size="meta" mono>
                {l}
              </Text>
            ))}
          </Stack>
        ) : null}
        {!result.stdout && !result.stderr ? (
          <Text size="meta" tone="muted">
            这次没产出任何输出。
          </Text>
        ) : null}
      </Stack>
    </div>
  );
}

/** 描述列表里的四行事实 + 发版进度（只读）。 */
function releaseItems(
  card: ReleaseCard,
  release: UseQueryResult<FranceReleaseState>,
  now: number,
): DescriptionsItem[] {
  const { mainline, deployed, gap, lastDone, action } = card;
  const train = release.data ? trainState(release.data) : null;
  const items: DescriptionsItem[] = [
    {
      label: '主线最新',
      value:
        mainline.state === 'unreadable' ? (
          <UnreadValue reason={mainline.why} />
        ) : (
          <Stack gap="sm">
            <Stack direction="horizontal" gap="sm" align="center" wrap>
              <Sha short={mainline.commit.short} />
              <Text>{mainline.commit.title}</Text>
              <CiBadge ci={mainline.ci} />
            </Stack>
            <Text size="meta" tone="muted">
              {formatAgo(mainline.commit.at, now)}提交
            </Text>
            {mainline.ci.state === 'red' || mainline.ci.state === 'pending' ? (
              <Text size="meta" tone="warning">
                {mainline.ci.detail}
              </Text>
            ) : null}
            {mainline.ci.state === 'unreadable' ? <UnreadValue reason={mainline.ci.why} /> : null}
          </Stack>
        ),
    },
    {
      label: '法国在用',
      value:
        deployed.state === 'unreadable' ? (
          <UnreadValue reason={deployed.why} />
        ) : (
          <Stack gap="sm">
            <Stack direction="horizontal" gap="sm" align="center" wrap>
              <Sha short={deployed.short} />
              {deployed.title !== null ? (
                <Text>{deployed.title}</Text>
              ) : (
                <UnreadValue reason={deployed.titleWhy ?? '标题没读到'} />
              )}
            </Stack>
            {deployed.deployedAt !== null ? (
              <Text size="meta" tone="muted">
                发于 {formatAgo(deployed.deployedAt, now)}
              </Text>
            ) : (
              <UnreadValue reason={deployed.deployedAtWhy ?? '发于何时没读到'} />
            )}
          </Stack>
        ),
    },
    {
      label: '和主线',
      value:
        gap.state === 'unreadable' ? (
          <UnreadValue reason={gap.why} />
        ) : gap.state === 'same' ? (
          <span data-entry-gap="same">
            <Stack direction="horizontal" gap="sm" align="center" wrap>
              <StatusBadge status="machine:version:current" />
              <Text>和主线一样，没有要发的</Text>
            </Stack>
          </span>
        ) : (
          <span data-entry-gap="ahead">
            <Stack gap="sm">
              <Tag tone="warning">落后主线 {gap.count} 个提交</Tag>
              <Collapse title={`展开 ${gap.count} 个提交`}>
                <Stack gap="sm">
                  {gap.prs.map((p) => (
                    <Text key={p.number} size="meta">
                      <Text size="meta" tone="muted" mono>
                        #{p.number}
                      </Text>
                      {'　'}
                      {p.title}
                    </Text>
                  ))}
                  {gap.nonPr > 0 ? (
                    <Text size="meta" tone="muted">
                      另有 {gap.nonPr} 个提交不是 PR 合并的
                    </Text>
                  ) : null}
                </Stack>
              </Collapse>
            </Stack>
          </span>
        ),
    },
    {
      label: '最近做完的任务',
      value:
        lastDone.state === 'unreadable' ? (
          <UnreadValue reason={lastDone.why} />
        ) : (
          <Stack gap="sm">
            <Text>
              <Text tone="muted" mono>
                PR #{lastDone.pr.number}
              </Text>{' '}
              {lastDone.pr.title}
            </Text>
            <Text size="meta" tone="muted">
              {formatAgo(lastDone.pr.mergedAt, now)}合并
            </Text>
            {lastDone.issue.state === 'ok' ? (
              <Text size="meta">
                关了{' '}
                <Text size="meta" tone="muted" mono>
                  #{lastDone.issue.number}
                </Text>{' '}
                {lastDone.issue.title}
                {lastDone.issue.alsoCloses.length > 0
                  ? `（还关了 ${lastDone.issue.alsoCloses.map((n) => `#${n}`).join('、')}）`
                  : ''}
              </Text>
            ) : lastDone.issue.state === 'none' ? (
              <Text size="meta" tone="muted">
                这个 PR 没写关哪张单
              </Text>
            ) : (
              <Text size="meta" tone="warning">
                关的单 #{lastDone.issue.number} 没查成：{lastDone.issue.why}
              </Text>
            )}
          </Stack>
        ),
    },
  ];
  items.push({
    label: '发版进度',
    value: release.error ? (
      <UnreadValue reason={errorText(release.error)} />
    ) : train ? (
      <Stack gap="sm">
        <StatusBadge status={train.status} />
        <Text size="meta" tone="muted">
          {train.text}
        </Text>
      </Stack>
    ) : (
      <Text tone="muted">正在读…</Text>
    ),
    hint: 'release-train',
  });
  if (action.last.check) {
    items.push({ label: '发布后检查', value: <ReleaseCheck check={action.last.check} /> });
  }
  return items;
}

/**
 * 「版本」卡。card 是发版卡（主线、法国在用、差几个、能不能发、上次结果），release 是 release-train 此刻的状态，
 * facts 是本台的六项事实（只用在用版本那一项：发版卡读不到时，这里仍写本台自己查到的版本）。
 */
export function VersionCard({
  card,
  release,
  facts,
  now,
}: {
  card: UseQueryResult<ReleaseCard>;
  release: UseQueryResult<FranceReleaseState>;
  facts: EnvFacts | undefined;
  now: number;
}) {
  const preflight = useFrancePreflight();
  // 同一帧里的第二下：isPending 还没画上去，只靠 loading 挡不住，这里先记一笔。
  const preflightSent = useRef(false);
  const data = card.data;
  const blocked = data?.action.state === 'blocked' ? data.action.reasons : [];
  const last = data ? lastLine(data.action.last, now) : null;
  const envVersion = facts?.version;
  const envProblems = envVersion?.ok ? envVersion.value.problems : [];
  const envBehind = envVersion?.ok ? versionStatus(envVersion.value) : undefined;
  return (
    <Section
      title="版本"
      actions={
        <>
          <Button
            size="sm"
            variant="secondary"
            aria-label="发版预检"
            loading={preflight.isPending}
            onClick={() => {
              if (preflightSent.current || preflight.isPending) return;
              preflightSent.current = true;
              return preflight.mutate(undefined, {
                onSettled: () => {
                  preflightSent.current = false;
                },
              });
            }}
          >
            发版预检
          </Button>
          {data ? <PublishButton card={data} /> : null}
        </>
      }
    >
      <Stack>
        {card.error ? (
          <LoadError what="发版卡" error={card.error} onRetry={() => void card.refetch()} />
        ) : null}
        {card.isLoading || (!card.data && !card.error) ? <LoadingRows rows={4} /> : null}
        {blocked.length > 0 && data?.gap.state !== 'same' ? (
          <div data-release-reasons>
            <Notice tone="stall" title="现在不能发">
              {blocked.map((r) => (
                <div key={r}>{r}</div>
              ))}
            </Notice>
          </div>
        ) : blocked.length > 0 ? (
          <div data-release-reasons>
            {blocked.map((r) => (
              <Text key={r} size="meta" tone="muted" block>
                {r}
              </Text>
            ))}
          </div>
        ) : null}
        {envVersion && !envVersion.ok ? (
          <Descriptions
            columns={1}
            items={[{ label: '在用版本', value: <UnreadValue reason={envVersion.reason} /> }]}
          />
        ) : null}
        {envProblems.length > 0 ? (
          <Notice tone="stall" title="本台在用版本有问题">
            {envProblems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </Notice>
        ) : null}
        {data ? <Descriptions columns={1} items={releaseItems(data, release, now)} /> : null}
        {!data && envBehind === 'machine:version:behind' && envVersion?.ok && envVersion.value.behind ? (
          <Text tone="warning">落后主线 {envVersion.value.behind} 个提交</Text>
        ) : null}
        {last ? (
          <span data-release-last={data?.action.last.state}>
            <Text tone={LAST_TONE[last.tone]} block>
              {last.text}
            </Text>
          </span>
        ) : null}
        {preflight.isError ? (
          <Notice tone="fail">预检请求没发出去：{errorText(preflight.error)}</Notice>
        ) : null}
        {preflight.data ? <PreflightResult result={preflight.data} /> : null}
        {data &&
        (data.action.last.state === 'running' ||
          data.action.last.state === 'blocked' ||
          data.action.last.state === 'failed') ? (
          <ReleaseTimeline last={data.action.last} now={now} />
        ) : null}
        {data?.action.recover ? <ReleaseRecoverButtons recover={data.action.recover} /> : null}
      </Stack>
    </Section>
  );
}
