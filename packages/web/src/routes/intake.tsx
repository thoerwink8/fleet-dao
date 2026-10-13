// 提需求（第三版，版面评审用的假数据页，不连后端）：对话是主角，流程是配角。
// 电脑：左边会话列表、中间居中一列对话、右边单子面板按需滑出；手机：列表 → 全屏聊天。同一个路由响应式切换。
// 状态用查询串切：?demo=discuss|pending|closed；?as=cxy|fxc188 换视角；?panel=1|0 单子面板开关；
// 手机：?screen=list|chat、?sheet=1 打开只读单子；?fail=1 让第一次写回评论失败。
import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { brand } from '#brand';
import { ChatPane } from '../components/intake/chat-pane';
import { ConvList, type ListFilter, waitCount } from '../components/intake/conv-list';
import {
  type Draft,
  type DraftField,
  DUPLICATE,
  draftOf,
  type Human,
  type Msg,
  messagesOf,
  type Option,
  REPOS,
  reqList,
  type Scene,
  type Status,
} from '../components/intake/data';
import { DraftPane, type DupView } from '../components/intake/draft-pane';
import { PhoneChat } from '../components/intake/phone';
import type { AskState } from '../components/intake/stream';
import { useLocalState, useMediaQuery } from '../lib/hooks';
import { cn } from '../lib/utils';
import { usePhone } from '../lib/viewport';

function sceneOf(v: string | null): Scene {
  return v === 'pending' || v === 'closed' ? v : 'discuss';
}

export default function Intake() {
  const [params] = useSearchParams();
  const scene = sceneOf(params.get('demo'));
  const as = params.get('as');
  const viewer: Human = as === 'cxy' || as === 'fxc188' ? as : scene === 'discuss' ? 'fxc188' : 'cxy';
  const panel = params.get('panel');
  return (
    <IntakeDemo
      key={`${scene}-${viewer}`}
      scene={scene}
      viewer={viewer}
      failFirst={params.get('fail') === '1'}
      startScreen={params.get('screen') === 'chat' ? 'chat' : 'list'}
      startSheet={params.get('sheet') === '1'}
      startPanel={panel === null ? null : panel === '1'}
    />
  );
}

function IntakeDemo({
  scene,
  viewer,
  failFirst,
  startScreen,
  startSheet,
  startPanel,
}: {
  scene: Scene;
  viewer: Human;
  failFirst: boolean;
  startScreen: 'list' | 'chat';
  startSheet: boolean;
  startPanel: boolean | null;
}) {
  const phone = usePhone();
  const wide = useMediaQuery('(min-width: 1536px)');
  const [picked, setPicked] = useState<boolean | null>(null);
  const collapsed = picked ?? !wide;
  const [screen, setScreen] = useState<'list' | 'chat'>(startScreen);
  const [sheet, setSheet] = useState(startSheet);
  // 单子面板默认收起；人选的开/关记在本机
  const [storedPanel, setStoredPanel] = useLocalState<boolean>(`${brand.storagePrefix}intake-panel`, false);
  const [panelOverride, setPanelOverride] = useState<boolean | null>(startPanel);
  const panelOpen = panelOverride ?? storedPanel;
  const setPanel = (v: boolean) => {
    setPanelOverride(v);
    setStoredPanel(v);
  };

  const base = useMemo(() => reqList(scene), [scene]);
  const [status, setStatus] = useState<Status>(base[0]?.status ?? 'discussing');
  const [noReason, setNoReason] = useState('');
  const [repo] = useState<string>(REPOS[0]);
  const [model, setModel] = useState('指挥官默认：Sonnet 5.5');
  const [msgs, setMsgs] = useState<Msg[]>(() => messagesOf(scene));
  const [draft, setDraft] = useState<Draft>(() => draftOf());
  const [edited, setEdited] = useState<ReadonlySet<DraftField>>(new Set());
  const [busy, setBusy] = useState(false);
  const [critiquing, setCritiquing] = useState(false);
  const [flash, setFlash] = useState<DraftField | null>(null);
  const [dup, setDup] = useState<DupView | null>(
    scene === 'discuss' ? { kind: 'found', ...DUPLICATE } : null,
  );
  const [askState, setAskState] = useState<AskState>('pending');
  const [askFail, setAskFail] = useState('');
  const [filter, setFilter] = useState<ListFilter>(waitCount(base, viewer) > 0 ? 'wait' : 'all');
  const failed = useRef(false);
  const lastAnswer = useRef('');
  const seq = useRef(100);
  const nid = () => `n${seq.current++}`;
  const clock = () => `22:${String(48 + (seq.current % 10)).padStart(2, '0')}`;

  const partner = base[0]?.initiator === 'fxc188';
  const closed = status === 'do' || status === 'no';
  const spoken = new Set(msgs.flatMap((m) => (m.kind === 'say' && m.who !== 'ai' ? [m.who] : [])));
  const multi = spoken.size >= 2;

  const req = useMemo(() => {
    const first = base[0];
    if (!first) throw new Error('没有当前需求');
    return {
      ...first,
      status,
      gh: status === 'do' ? ('working' as const) : undefined,
      issue: status === 'do' ? 12 : undefined,
      pr: status === 'do' ? 34 : undefined,
      mineFor: status === 'pending' || status === 'do' ? ('cxy' as const) : undefined,
      waiting:
        status === 'discussing'
          ? multi
            ? '@指挥官 它才接话'
            : '继续聊，齐了就提交'
          : status === 'pending'
            ? '等 cxy 拍板'
            : status === 'do'
              ? '等你回答引擎'
              : null,
    };
  }, [base, status, multi]);
  const reqs = useMemo(() => [req, ...base.slice(1)], [req, base]);

  const closedText =
    status === 'do'
      ? '已结案 · 22:41 cxy 同意做 · 开成 #12'
      : status === 'no'
        ? `已结案 · cxy 不做：${noReason || '理由见对话'}`
        : null;

  const jump = (f: DraftField) => {
    document.getElementById(`draft-${f}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlash(f);
    window.setTimeout(() => setFlash(null), 1400);
  };
  const openPanel = (f?: DraftField) => {
    if (phone) {
      setSheet(true);
      return;
    }
    setPanel(true);
    if (f) window.setTimeout(() => jump(f), 300);
  };
  const patch = (p: Partial<Draft>, f: DraftField) => {
    setDraft((d) => ({ ...d, ...p, version: d.version + 1 }));
    setEdited((s) => new Set(s).add(f));
  };
  const push = (...m: Msg[]) => setMsgs((x) => [...x, ...m]);

  const reply = (text: string) => {
    setBusy(true);
    window.setTimeout(() => {
      setBusy(false);
      push({
        kind: 'say',
        id: nid(),
        who: 'ai',
        at: clock(),
        text: `@${viewer} 收到：${text.replace(/@指挥官\s*/g, '').slice(0, 24)}。我记进单子的「要什么」了。`,
      });
    }, 1500);
  };

  const send = (text: string) => {
    push({ kind: 'say', id: nid(), who: viewer, at: clock(), text });
    const nowMulti = new Set([...spoken, viewer]).size >= 2;
    if (!nowMulti || text.includes('@指挥官')) reply(text);
  };

  const pick = (id: string, o: Option) => {
    setMsgs((m) => m.map((x) => (x.kind === 'ask' && x.id === id ? { ...x, answered: o.label } : x)));
    push({ kind: 'say', id: nid(), who: viewer, at: clock(), text: o.label });
    reply(o.label);
  };

  const submit = () => {
    if (partner) {
      setStatus('pending');
      push({ kind: 'submit', id: nid(), who: viewer, version: draft.version, at: clock() });
    } else {
      setStatus('do');
    }
  };
  const again = () => {
    setStatus('discussing');
    push({ kind: 'sys', id: nid(), text: 'cxy 点了「再聊聊」，退回讨论中' });
  };

  const changeModel = (m: string) => {
    setModel(m);
    push({ kind: 'divider', id: nid(), text: `以下由 ${m.replace('指挥官默认：', '')} 接着聊` });
  };
  const critique = () => {
    setCritiquing(true);
    window.setTimeout(() => {
      setCritiquing(false);
      push({
        kind: 'sys',
        id: nid(),
        text: '别家（GPT 5.6）挑了 2 处：怎么算做完第 3 条没说「失败的行里写什么」；「已知的模块」漏了测试文件。',
      });
    }, 1500);
  };
  const continueNew = () =>
    toast.success('已新开 需求 45：接着 需求 42 / #12', {
      description: '#12 还没合并：开单时指挥官会往 #12 补一条评论。',
    });

  const writeBack = (text: string) => {
    lastAnswer.current = text;
    setAskState('writing');
    window.setTimeout(() => {
      if (failFirst && !failed.current) {
        failed.current = true;
        setAskFail('GitHub 返回 502（评论接口暂时不可用）。你写的话还在，点「重试」再写一次。');
        setAskState('failed');
        return;
      }
      setAskState('written');
    }, 700);
  };

  const stream = {
    msgs,
    viewer,
    busy,
    status,
    closed,
    draft,
    dup: dup && (dup.kind === 'found' || dup.kind === 'failed') ? dup : null,
    partner,
    closedText,
    askState,
    askFail,
    onPickOption: pick,
    onOpenPanel: openPanel,
    onSuggest: (id: string, take: boolean) =>
      setMsgs((m) =>
        m.map((x) => (x.kind === 'suggest' && x.id === id ? { ...x, state: take ? 'taken' : 'skipped' } : x)),
      ),
    onSubmit: submit,
    onYes: () => setStatus('do'),
    onNo: (reason: string) => {
      setNoReason(reason);
      setStatus('no');
    },
    onAgain: again,
    onAnswerStart: () => setAskState('composing'),
    onRetry: () => writeBack(lastAnswer.current),
  } as const;

  const list = (
    <ConvList
      reqs={reqs}
      viewer={viewer}
      selected={42}
      onSelect={() => setScreen('chat')}
      onNew={() => undefined}
      filter={filter}
      onFilter={setFilter}
      collapsed={phone ? false : collapsed}
      onToggle={() => setPicked(!collapsed)}
      phone={phone}
    />
  );

  if (phone) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-intake-page data-phone data-status={status}>
        {list}
        {screen === 'chat' ? (
          <PhoneChat
            {...stream}
            req={req}
            sheet={sheet}
            onSheet={setSheet}
            onBack={() => setScreen('list')}
            muted={multi}
            onSend={send}
            onAnswerSend={writeBack}
            onAnswerCancel={() => setAskState('pending')}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0" data-intake-page data-status={status}>
      {list}
      <ChatPane
        {...stream}
        req={req}
        repo={repo}
        model={model}
        onModel={changeModel}
        muted={multi}
        panelOpen={panelOpen}
        onPanel={() => setPanel(!panelOpen)}
        onSend={send}
        onContinue={continueNew}
        onAnswerSend={writeBack}
        onAnswerCancel={() => setAskState('pending')}
      />
      <div
        className={cn(
          'shrink-0 overflow-hidden bg-panel transition-[width] duration-200',
          panelOpen ? 'w-84 border-l' : 'w-0',
        )}
        data-intake-panel-wrap
        data-open={panelOpen}
        inert={!panelOpen}
      >
        <DraftPane
          draft={draft}
          edited={edited}
          flash={flash}
          mode={closed ? 'closed' : status === 'pending' ? 'frozen' : 'edit'}
          partner={partner}
          submitted={status !== 'discussing'}
          dup={dup}
          critiquing={critiquing}
          repo={repo}
          onChange={patch}
          onSubmit={submit}
          onCritique={critique}
          onJoin={() => setDup({ kind: 'joined', issue: DUPLICATE.issue })}
          onDismiss={() => setDup({ kind: 'dismissed' })}
          onContinue={continueNew}
          onClose={() => setPanel(false)}
        />
      </div>
    </div>
  );
}
