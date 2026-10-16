// 提需求（母单 #2047，D 片 #2062；方案 specs/2047-提需求/方案.md 第三、四、七节）：和指挥官聊清楚一件事，确定后开成单。
// 电脑：左边需求列表（≥1536 展开，更窄收成窄条，人选的记在本机）、中间居中一列对话、右边单子面板按需滑出（开关记在本机）。
// 手机（<768）：列表 → 对话两个画面，同一个路由。
// 地址：?r=<需求号> 打开一条，?r=new 提新的（&from=<号> 接着那条提）；?view=archived|deleted、?filter=todo|all|mine、?q= 搜。
// 接的是 A 片（#2049）的列表、详情、动作接口，B 片（#2060）的开单回显、进度卡、引擎提问回答，
// C 片（#2061）的指挥官流式回话、选项、建议改、模型芯片、「让指挥官接着问」、让别家挑错。
import { MessageSquarePlus } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { brand } from '#brand';
import { useMe, useRequestDetail } from '../api/client';
import type { RequestDraftField, RequestFilter, RequestView } from '../api/types';
import { DraftPanel } from '../components/intake/draft-panel';
import { NewRequest } from '../components/intake/new-request';
import { RequestChat } from '../components/intake/request-chat';
import { RequestList } from '../components/intake/request-list';
import { EmptyState } from '../components/layout/empty-state';
import { Button } from '../components/ui/button';
import { useLocalState, useMediaQuery } from '../lib/hooks';
import { cn } from '../lib/utils';
import { usePhone } from '../lib/viewport';

function viewOf(v: string | null): RequestView {
  return v === 'archived' || v === 'deleted' ? v : 'active';
}
function filterOf(v: string | null): RequestFilter {
  return v === 'todo' || v === 'mine' ? v : 'all';
}
function seqOf(v: string | null): number | 'new' | null {
  if (v === 'new') return 'new';
  return v && /^[1-9]\d{0,8}$/.test(v) ? Number(v) : null;
}

export default function Intake() {
  const [params, setParams] = useSearchParams();
  const phone = usePhone();
  const wide = useMediaQuery('(min-width: 1536px)');
  const { data: me } = useMe();
  const meId = me?.user.id;
  const [pickedCollapse, setPickedCollapse] = useLocalState<boolean | null>(
    `${brand.storagePrefix}intake-list-collapsed`,
    null,
  );
  const collapsed = pickedCollapse ?? !wide;
  const [panelOpen, setPanelOpen] = useLocalState<boolean>(`${brand.storagePrefix}intake-panel`, false);
  const editN = useRef(0);
  const [draftEdit, setDraftEdit] = useState<{ field: RequestDraftField; n: number } | null>(null);

  const view = viewOf(params.get('view'));
  const filter = filterOf(params.get('filter'));
  const q = params.get('q') ?? '';
  const target = seqOf(params.get('r'));
  const seq = typeof target === 'number' ? target : null;
  const fromRaw = seqOf(params.get('from'));
  const from = typeof fromRaw === 'number' && !phone ? fromRaw : null;

  // 按当前网址合并：react-router 交给 setParams 回调的是建回调那次渲染的参数，防抖、异步回来的晚一步调用会拿旧网址把别的改动盖掉
  const latest = useRef(params);
  latest.current = params;
  const patch = useCallback(
    (next: Record<string, string | null>) => {
      setParams(
        () => {
          const p = new URLSearchParams(latest.current);
          for (const [k, v] of Object.entries(next)) {
            if (v === null || v === '') p.delete(k);
            else p.set(k, v);
          }
          return p;
        },
        { replace: false },
      );
    },
    [setParams],
  );

  const detail = useRequestDetail(!phone && panelOpen ? seq : null);

  const openPanel = (open: boolean, field?: RequestDraftField) => {
    setPanelOpen(open);
    if (open && field) {
      editN.current += 1;
      setDraftEdit({ field, n: editN.current });
      window.setTimeout(
        () =>
          document.getElementById(`draft-${field}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
        300,
      );
    }
  };

  const list = (
    <RequestList
      view={view}
      filter={filter}
      q={q}
      meId={meId}
      selected={seq}
      phone={phone}
      collapsed={collapsed}
      onToggle={() => setPickedCollapse(!collapsed)}
      onSelect={(s) => patch({ r: String(s), from: null })}
      onNew={() => patch({ r: 'new', from: null })}
      onView={(v) => patch({ view: v === 'active' ? null : v, filter: null })}
      onFilter={(f) => patch({ filter: f === 'all' ? null : f })}
      onQ={(v) => patch({ q: v })}
    />
  );

  const chat =
    target === 'new' ? (
      <NewRequest
        phone={phone}
        from={from}
        onBack={() => patch({ r: null, from: null })}
        onCreated={(s) => patch({ r: String(s), from: null, view: null })}
      />
    ) : seq !== null ? (
      <RequestChat
        key={seq}
        seq={seq}
        meId={meId}
        phone={phone}
        panelOpen={panelOpen}
        onPanel={openPanel}
        onBack={() => patch({ r: null })}
        onContinue={(s) => patch({ r: 'new', from: String(s) })}
        onGone={() => patch({ r: null })}
      />
    ) : null;

  if (phone) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-intake-page data-phone>
        {list}
        {chat}
      </div>
    );
  }

  const panelOn = panelOpen && seq !== null && detail.data !== undefined;
  return (
    <div className="flex h-full min-h-0" data-intake-page>
      {list}
      {chat ?? (
        <section
          className="flex min-w-0 flex-1 items-center justify-center bg-background"
          aria-label="需求对话"
        >
          <EmptyState
            icon={MessageSquarePlus}
            title="选一条需求接着聊，或者提一条新的"
            hint="和指挥官聊清楚要什么，草稿齐了提交拍板或确定开单。"
            action={
              <Button variant="brand" onClick={() => patch({ r: 'new', from: null })}>
                提新需求
              </Button>
            }
          />
        </section>
      )}
      <div
        className={cn(
          'shrink-0 overflow-hidden bg-panel transition-[width] duration-300',
          panelOn ? 'w-84 border-l' : 'w-0',
        )}
        data-intake-panel-wrap
        data-open={panelOn}
        inert={!panelOn}
      >
        {detail.data && seq !== null ? (
          <DraftPanel
            d={detail.data}
            meId={meId}
            edit={draftEdit}
            onClose={() => setPanelOpen(false)}
            onContinue={() => patch({ r: 'new', from: String(seq) })}
          />
        ) : null}
      </div>
    </div>
  );
}
