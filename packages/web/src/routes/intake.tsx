// 提需求（版面评审用的假数据页，不连后端）：左「我的需求」、中「和指挥官聊」、右「单子草稿」。
// 状态用 ?demo=a|b|c 切：a 聊到一半、b 草稿齐了、c 开单之后；?fail=1 让第一次写回评论失败，看「重试」。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type AskState, ChatPane } from '../components/intake/chat-pane';
import { ConvList } from '../components/intake/conv-list';
import {
  convList,
  type Draft,
  type DraftField,
  DUPLICATE,
  draftOf,
  type Msg,
  messagesOf,
  type Option,
  REPOS,
  type Scene,
} from '../components/intake/data';
import { DraftPane, type DupView, missingOf } from '../components/intake/draft-pane';
import { useMediaQuery } from '../lib/hooks';

function sceneOf(v: string | null): Scene {
  return v === 'b' || v === 'c' ? v : 'a';
}

export default function Intake() {
  const [params] = useSearchParams();
  const scene = sceneOf(params.get('demo'));
  const failFirst = params.get('fail') === '1';
  return <IntakeDemo key={scene} scene={scene} failFirst={failFirst} />;
}

function IntakeDemo({ scene, failFirst }: { scene: Scene; failFirst: boolean }) {
  const wide = useMediaQuery('(min-width: 1536px)');
  const [picked, setPicked] = useState<boolean | null>(null);
  const collapsed = picked ?? !wide;

  const [repo, setRepo] = useState<string>(REPOS[0]);
  const [msgs, setMsgs] = useState<Msg[]>(() => messagesOf(scene));
  const [draft, setDraft] = useState<Draft>(() => draftOf(scene));
  const [edited, setEdited] = useState<ReadonlySet<DraftField>>(() =>
    scene === 'b' ? new Set<DraftField>(['want']) : new Set<DraftField>(),
  );
  const [opened, setOpened] = useState(scene === 'c');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<DraftField | null>(null);
  const [dup, setDup] = useState<DupView | null>(scene === 'b' ? { kind: 'found', ...DUPLICATE } : null);
  const [askState, setAskState] = useState<AskState>('pending');
  const [askFail, setAskFail] = useState('');
  const [pendingAnswer, setPendingAnswer] = useState<string | null>(null);
  const failed = useRef(false);
  const seq = useRef(100);
  const nid = () => `n${seq.current++}`;

  // B：草稿刚补齐，右栏滚到「怎么算做完」
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时滚一次
  useEffect(() => {
    if (scene !== 'b') return;
    const t = window.setTimeout(() => jump('done'), 300);
    return () => window.clearTimeout(t);
  }, [scene]);

  const convs = useMemo(() => {
    const list = convList(scene);
    const first = list[0];
    if (first && scene === 'a' && missingOf(draft).length === 0) first.status = 'ready';
    return list;
  }, [scene, draft]);

  const stage = opened ? 'opened' : missingOf(draft).length === 0 ? 'ready' : 'chatting';

  const jump = (f: DraftField) => {
    document.getElementById(`draft-${f}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlash(f);
    window.setTimeout(() => setFlash(null), 1400);
  };

  const patch = (p: Partial<Draft>, f: DraftField) => {
    setDraft((d) => ({ ...d, ...p, version: d.version + 1 }));
    setEdited((s) => new Set(s).add(f));
  };

  // 脚本回复：A 里回答第一问后，指挥官补验收并补齐草稿；之后随便说什么都收下。
  const reply = (userText: string) => {
    setBusy(true);
    window.setTimeout(() => {
      setBusy(false);
      setMsgs((m) => {
        const ready = missingOf(draft).length === 0;
        if (ready) {
          return [
            ...m,
            { kind: 'ai', id: nid(), text: `收到：${userText.slice(0, 20)}。我记进草稿的「要什么」了。` },
          ];
        }
        return [
          ...m,
          {
            kind: 'ai',
            id: nid(),
            text: '好。那「怎么算做完」我先写三条，你看看。\n\n另外你提到「从旧机器抄过来」，我没有往里加自动导入，放进了「不做什么」。',
          },
          { kind: 'patch', id: nid(), text: '草稿里补了：怎么算做完第 2 条', field: 'done' },
        ];
      });
      if (missingOf(draft).length > 0) {
        const full = draftOf('b');
        setDraft((d) => ({ ...d, done: full.done, not: full.not, version: d.version + 1 }));
        setDup({ kind: 'found', ...DUPLICATE });
        window.setTimeout(() => jump('done'), 100);
      }
    }, 1500);
  };

  const send = (text: string) => {
    if (askState === 'composing') {
      setAskState('writing');
      window.setTimeout(() => {
        if (failFirst && !failed.current) {
          failed.current = true;
          setAskFail('GitHub 返回 502（评论接口暂时不可用）。你的话还在，点「重试」再写一次。');
          setPendingAnswer(text);
          setAskState('failed');
          return;
        }
        setMsgs((m) => [...m, { kind: 'user', id: nid(), text }]);
        setAskState('written');
      }, 700);
      return;
    }
    setMsgs((m) => [...m, { kind: 'user', id: nid(), text }]);
    reply(text);
  };

  const pick = (id: string, o: Option) => {
    setMsgs((m) =>
      m
        .map((x) => (x.kind === 'ask' && x.id === id ? { ...x, answered: o.label } : x))
        .concat({
          kind: 'user',
          id: nid(),
          text: o.label,
        }),
    );
    reply(o.label);
  };

  const retry = () => {
    setAskState('writing');
    window.setTimeout(() => {
      setMsgs((m) => [...m, { kind: 'user', id: nid(), text: pendingAnswer ?? '' }]);
      setAskState('written');
    }, 700);
  };

  const suggest = (id: string, take: boolean) => {
    setMsgs((m) =>
      m.map((x) => (x.kind === 'suggest' && x.id === id ? { ...x, state: take ? 'taken' : 'skipped' } : x)),
    );
    if (take) {
      setDraft((d) => ({
        ...d,
        want: `${d.want}已有的密钥只显示尾 4 位，不填就不改。`,
        version: d.version + 1,
      }));
      jump('want');
    }
  };

  const confirm = () => {
    setOpened(true);
    setMsgs((m) => [...m, { kind: 'sys', id: nid(), text: `已开成 #12（第 ${draft.version} 版）` }]);
  };

  return (
    <div className="flex h-full min-h-0" data-intake-page data-stage={stage}>
      <ConvList
        convs={convs}
        selected="c1"
        onSelect={() => undefined}
        onNew={() => undefined}
        collapsed={collapsed}
        onToggle={() => setPicked(!collapsed)}
      />
      <ChatPane
        repo={repo}
        onRepo={setRepo}
        repoLocked={msgs.some((m) => m.kind === 'user')}
        msgs={msgs}
        busy={busy}
        opened={opened}
        askState={askState}
        askFail={askFail}
        onSend={send}
        onPickOption={pick}
        onJump={jump}
        onSuggest={suggest}
        onAnswerStart={() => setAskState('composing')}
        onAnswerCancel={() => setAskState('pending')}
        onRetry={retry}
      />
      <DraftPane
        draft={draft}
        edited={edited}
        flash={flash}
        opened={opened}
        partner
        dup={dup}
        onChange={patch}
        onConfirm={confirm}
        onJoin={() => setDup({ kind: 'joined', issue: DUPLICATE.issue })}
        onDismiss={() => setDup({ kind: 'dismissed' })}
      />
    </div>
  );
}
