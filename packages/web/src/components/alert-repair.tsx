// 看门狗提醒卡上的受控修复（#3034，后端 #3033）：后端现算能点的动作和实际后果，点了原卡写排队 → 执行 → 核验中 → 已修复 / 没修成 / 结果未知。
// 页面只送服务端给的动作编号 + incident + 幂等身份，不拼命令、不扩权限；点之前先重读一次列表，按钮已经不是现在的就不发。
// 依据：Temporal 消息与结果（发出去只代表收到，结果另查）——受理只写核验中，后端核验过（verified）才写已修复；
// AWS Automation 批准步骤（要人批的由人本人点准或拒）——只有带 choice 的动作写「要你本人拍」，拒了、自己写一句都不执行。
import { ExternalLink, ScrollText, Wrench } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ApiError, errorText, useExecuteAlertRepair } from '../api/client';
import type { ExecuteAlertRepairBody, ExecuteAlertRepairResult, Me, Notification } from '../api/types';
import {
  isWatchdogAlert,
  KIND_LABEL,
  PHASE_META,
  type RepairAction,
  type RepairPhase,
  type RepairRecord,
  recommendation,
  recordPhase,
  STALE_CODES,
  shownRecord,
  targetLines,
  whyYouDecide,
} from '../lib/alert-repair';
import { formatAgo, formatDateTime } from '../lib/format';
import { isMine } from '../lib/status';
import { DecisionPicker } from './decision-picker';
import { Notice, type NoticeTone } from './layout/notice';
import { StatusBadge } from './layout/status-badge';
import { Tag } from './layout/tag';
import { RepoLink } from './repo-link';
import { Button } from './ui/button';

/** 点之前重读一次列表：读成了回这一条现在的样子（不在列表里是 undefined），没读成回原因。 */
export type RepairRefresh = (
  id: string,
) => Promise<{ ok: true; n: Notification | undefined } | { ok: false; why: string }>;

/** 卡上已经有一件在途或已了结的事：不再摆新的动作按钮（后端同样拒）。 */
const BLOCKING: readonly RepairPhase[] = ['executing', 'verifying', 'unknown', 'verified', 'handed'];

const NOTICE_TONE: Record<RepairPhase, NoticeTone> = {
  queued: 'info',
  'no-receipt': 'stall',
  executing: 'info',
  verifying: 'info',
  verified: 'done',
  failed: 'fail',
  unknown: 'stall',
  declined: 'info',
  handed: 'info',
};

function newRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function resultToast(r: ExecuteAlertRepairResult): void {
  const phase = recordPhase(r.repair);
  const title = `${PHASE_META[phase].label}：${KIND_LABEL[r.repair.kind]}`;
  const description = `${r.repair.text}${r.replayed ? '（同一次请求的原结果，没有再执行）' : ''}`;
  if (phase === 'verified') toast.success(title, { description });
  else if (phase === 'failed') toast.error(title, { description });
  else if (phase === 'unknown') toast.warning(title, { description });
  else toast.info(title, { description });
}

/** 一条修复记录：哪一段、谁点的、后端的原话，核验结果、开出的单、具体操作（目标、请求编号、操作记录链接）。 */
function RepairRecordBox({
  n,
  rec,
  me,
  now,
}: {
  n: Notification;
  rec: RepairRecord;
  me: Me | undefined;
  now: number;
}) {
  const phase = recordPhase(rec);
  const meta = PHASE_META[phase];
  const who = isMine(rec.by, me) ? '我' : rec.by;
  return (
    <Notice
      tone={NOTICE_TONE[phase]}
      role="status"
      className="mt-3 md:max-w-3xl"
      title={
        <span
          className="flex min-w-0 flex-wrap items-center gap-x-2"
          data-testid="repair-record"
          data-phase={phase}
        >
          <StatusBadge tone={meta.tone} label={meta.label} variant="dot" />
          <span>
            {KIND_LABEL[rec.kind]} · {who}点的
          </span>
          <span className="num font-normal opacity-80" title={formatDateTime(rec.at)}>
            {formatAgo(rec.at, now)}
          </span>
        </span>
      }
    >
      <p className="break-words" data-testid="repair-text">
        {rec.text}
      </p>
      {rec.check && phase !== 'verified' ? (
        <p className="mt-1 break-words text-meta" data-testid="repair-check">
          核验（{formatAgo(rec.check.at, now)}）：{rec.check.text}
        </p>
      ) : null}
      {phase === 'verifying' ? (
        <p className="mt-1 text-meta">
          收到了不等于修好：后端重读原检测条件恢复了才写「已修复」，卡由看门狗自己撤。
        </p>
      ) : null}
      {phase === 'unknown' ? (
        <p className="mt-1 text-meta">结果未知不会自动重试，也不给新按钮：先看操作记录和现场，核实了再说。</p>
      ) : null}
      {phase === 'failed' ? <p className="mt-1 text-meta">这条还开着，下面按现在能点的再选。</p> : null}
      {rec.issue ? (
        <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-meta" data-testid="repair-issue">
          <span>修复单</span>
          <RepoLink
            repo={rec.issue.repo}
            kind="issues"
            n={rec.issue.number}
            className="inline-flex items-center gap-0.5 underline underline-offset-2"
            icon={<ExternalLink className="size-3" aria-hidden />}
          >
            {`${rec.issue.repo.owner}/${rec.issue.repo.name}#${rec.issue.number}`}
          </RepoLink>
          <span>
            {rec.issue.created ? '这次开的' : '同一次事故原有的那张'} · 处理人：
            {n.handling?.who ?? '还没登记谁接手（看上面「谁在处理」）'}
          </span>
        </p>
      ) : null}
      <details className="mt-1 text-meta" data-testid="repair-detail">
        <summary className="cursor-pointer underline-offset-2 hover:underline">具体操作</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          <li>动作：{KIND_LABEL[rec.kind]}</li>
          {targetLines(rec.target).map((t) => (
            <li key={t}>目标：{t}</li>
          ))}
          <li>
            {who} · {formatDateTime(rec.at)} · 请求 <span className="num">{rec.requestId.slice(0, 8)}</span>
          </li>
          <li>
            <Link
              to={`/audit?target=${encodeURIComponent(`notification:${n.id}`)}`}
              className="inline-flex items-center gap-1 underline underline-offset-2"
            >
              <ScrollText className="size-3" aria-hidden />
              查这条的操作记录
            </Link>
          </li>
        </ul>
      </details>
    </Notice>
  );
}

/** 没有能直接点的修复：照实说为什么，留去现场和自己写一句的出口。 */
function NoRepair({
  title,
  lines,
  link,
}: {
  title: string;
  lines: readonly string[];
  link: string | undefined;
}) {
  return (
    <Notice tone="stall" role="status" className="mt-3 md:max-w-3xl" title={title}>
      <div data-testid="repair-none">
        {lines.map((l) => (
          <p key={l} className="break-words text-meta">
            {l}
          </p>
        ))}
        <p className="mt-1 text-meta">
          {link ? '点右边「打开」去现场看；' : ''}
          要换个办法：
          <Link to="/intake" className="underline underline-offset-2">
            到「提需求」写一句
          </Link>
          ，这里不替你执行别的。
        </p>
      </div>
    </Notice>
  );
}

/** 看门狗提醒卡上的修复区：别的提醒不渲染。 */
export function AlertRepairPanel({
  n,
  me,
  now,
  refresh,
}: {
  n: Notification;
  me: Me | undefined;
  now: number;
  refresh: RepairRefresh;
}) {
  const exec = useExecuteAlertRepair();
  const pickerId = useId();
  // 同一张卡同一时刻只走一件：连点、双击都只发一次
  const busyRef = useRef(false);
  const [busy, setBusy] = useState<undefined | { label: string; step: 'checking' | 'sent' }>(undefined);
  /** 发了没收到回执：留着同一请求，「再问一次」用它（后端同一 requestId 回原结果，不重复执行）。 */
  const [unsent, setUnsent] = useState<undefined | { body: ExecuteAlertRepairBody; label: string }>(
    undefined,
  );
  const [local, setLocal] = useState<RepairRecord | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [choiceOpen, setChoiceOpen] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState('');

  const repair = n.repair;
  if (!repair && !isWatchdogAlert(n)) return null;
  const resolved = Boolean(n.resolvedAt);
  const rec = shownRecord(repair?.last, local);
  const recPhase = rec ? recordPhase(rec) : undefined;
  // 列表已经认得这次请求（后端收到了）：不再算「没收到回执」
  const pendingReceipt = unsent && repair?.last?.requestId !== unsent.body.requestId ? unsent : undefined;
  const blocked =
    Boolean(busy) || Boolean(pendingReceipt) || (recPhase !== undefined && BLOCKING.includes(recPhase));
  const actions = !resolved && !blocked ? (repair?.actions ?? []) : [];
  const rec2 = recommendation(actions);

  const send = async (body: ExecuteAlertRepairBody, label: string) => {
    setBusy({ label, step: 'sent' });
    try {
      const r = await exec.mutateAsync({ id: n.id, body });
      setLocal(r.repair);
      setUnsent(undefined);
      setChoiceOpen(undefined);
      setDraft('');
      resultToast(r);
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        // 超时、断网：不知道后端收没收到。不换新编号重发，留同一请求等人点「再问一次」
        setUnsent({ body, label });
        setNote(
          `没收到回执（${e.message}）：可能已经执行，也可能没有。已重读列表；要再问用同一请求，不会重复执行。`,
        );
        await refresh(n.id);
      } else if (e instanceof ApiError && e.status === 409) {
        setUnsent(undefined);
        setNote(
          STALE_CODES.has(e.code)
            ? `${e.message}。已刷新，按现在能点的重选。`
            : `${e.message}。已刷新，卡上是后端现在记的样子。`,
        );
        await refresh(n.id);
      } else {
        setUnsent(undefined);
        setNote(`没发成：${errorText(e)}`);
      }
    } finally {
      busyRef.current = false;
      setBusy(undefined);
    }
  };

  const pick = async (action: RepairAction, input?: { optionId: string } | { text: string }) => {
    if (busyRef.current || !repair) return;
    busyRef.current = true;
    setNote(undefined);
    setBusy({ label: action.label, step: 'checking' });
    // 过期先刷新：拿现在的列表核对按钮还在不在、还是不是这次事故，不沿旧按钮执行
    const fresh = await refresh(n.id);
    const cur = fresh.ok ? fresh.n?.repair : undefined;
    if (!fresh.ok) {
      setNote(`点之前重读没成（${fresh.why}），没有执行：等页面读到了再点。`);
    } else if (
      !fresh.n ||
      fresh.n.resolvedAt ||
      !cur ||
      cur.incident !== repair.incident ||
      !cur.actions.some((a) => a.id === action.id)
    ) {
      setNote('现场变了：这个按钮已经不是现在的了，没有执行。已刷新，按现在能点的重选。');
    } else {
      await send(
        { actionId: action.id, incident: cur.incident, requestId: newRequestId(), ...input },
        action.label,
      );
      return;
    }
    busyRef.current = false;
    setBusy(undefined);
  };

  const askAgain = () => {
    if (busyRef.current || !pendingReceipt) return;
    busyRef.current = true;
    setNote(undefined);
    void send(pendingReceipt.body, pendingReceipt.label);
  };

  return (
    <div data-testid="alert-repair" className="min-w-0">
      {rec ? <RepairRecordBox n={n} rec={rec} me={me} now={now} /> : null}
      {resolved && recPhase !== 'verified' ? (
        <p className="mt-1.5 text-meta text-muted-foreground" data-testid="repair-manual">
          手动标了已处理：只是不再提醒，没核实修好。
        </p>
      ) : null}
      {busy ? (
        <Notice
          tone="info"
          role="status"
          className="mt-3 md:max-w-3xl"
          title={`${PHASE_META.queued.label}：${busy.label}`}
        >
          <span data-testid="repair-busy" data-step={busy.step}>
            {busy.step === 'checking' ? '先重读一次，核对按钮还是不是现在的…' : '已发出，等后端接活和回话…'}
          </span>
        </Notice>
      ) : null}
      {pendingReceipt && !busy ? (
        <Notice
          tone="stall"
          role="status"
          className="mt-3 md:max-w-3xl"
          title={
            <span data-testid="repair-record" data-phase="no-receipt">
              {PHASE_META['no-receipt'].label}：{pendingReceipt.label}
            </span>
          }
          action={
            <Button size="sm" variant="outline" onClick={askAgain}>
              再问一次（同一请求）
            </Button>
          }
        >
          不知道后端收没收到；再问一次用同一个请求编号，执行过的只回原结果。
        </Notice>
      ) : null}
      {note ? (
        <p
          className="mt-2 break-words text-meta text-ink-stall md:max-w-3xl"
          role="status"
          data-testid="repair-note"
        >
          {note}
        </p>
      ) : null}
      {resolved ? null : !repair ? (
        <NoRepair
          title="修复能力没接上"
          lines={['后端这次没给这条算修复动作（旧版后端，或这一页没算成），这里不编按钮。']}
          link={n.link}
        />
      ) : actions.length > 0 ? (
        <div className="mt-3 md:max-w-3xl" data-testid="repair-actions">
          <p className="mb-1.5 flex items-center gap-1.5 text-meta text-muted-foreground">
            <Wrench className="size-3.5" aria-hidden />
            现在能点的修复（后端按现场算的，点之前会再核一次）
          </p>
          <ul className="divide-y divide-border rounded-md border" aria-label="修复动作">
            {actions.map((a) => {
              const why = whyYouDecide(a);
              const recommended = rec2?.id === a.id;
              return (
                <li key={a.id} data-repair-action={a.kind}>
                  <button
                    type="button"
                    aria-label={a.label}
                    aria-expanded={a.choice ? choiceOpen === a.id : undefined}
                    disabled={Boolean(busy)}
                    onClick={() =>
                      a.choice ? setChoiceOpen((v) => (v === a.id ? undefined : a.id)) : void pick(a)
                    }
                    className="flex min-h-10 w-full flex-col gap-0.5 px-3 py-2 text-left outline-none first:rounded-t-md last:rounded-b-md hover:bg-accent focus-visible:ring-focus focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 max-md:min-h-11 md:flex-row md:items-baseline md:gap-4"
                  >
                    <span className="flex shrink-0 flex-wrap items-center gap-1.5 text-body font-medium md:w-56">
                      {a.label}
                      {recommended ? <Tag tone="brand">推荐</Tag> : null}
                      {a.choice ? <Tag tone="human">要你拍</Tag> : null}
                    </span>
                    <span className="min-w-0 flex-1 text-meta text-muted-foreground">
                      {a.detail}
                      {recommended && rec2 ? (
                        <span className="text-foreground">。推荐：{rec2.why}</span>
                      ) : null}
                    </span>
                  </button>
                  {a.choice && choiceOpen === a.id ? (
                    <div className="px-3 pb-3">
                      <p className="mt-2 text-meta text-ink-human" data-testid="repair-why-you">
                        要你本人拍：{why}
                      </p>
                      <DecisionPicker
                        id={`${pickerId}-${a.kind}`}
                        options={a.choice.options}
                        pending={Boolean(busy)}
                        text={draft}
                        onText={setDraft}
                        onAnswer={(input) => void pick(a, input)}
                        effect="自己写的：只记下，不执行这个动作"
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {repair.problems.map((p) => (
            <p key={p} className="mt-1 break-words text-meta text-muted-foreground">
              {p}
            </p>
          ))}
          <p className="mt-1 text-meta text-muted-foreground">
            都不合适？
            <Link to="/intake" className="underline underline-offset-2">
              到「提需求」写一句
            </Link>
          </p>
        </div>
      ) : !blocked ? (
        <NoRepair
          title="现在没有能直接点的修复"
          lines={repair.problems.length > 0 ? repair.problems : ['后端没算出能点的动作，也没写原因。']}
          link={n.link}
        />
      ) : repair.problems.length > 0 && !busy ? (
        <div className="mt-1">
          {repair.problems.map((p) => (
            <p key={p} className="break-words text-meta text-muted-foreground">
              {p}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
