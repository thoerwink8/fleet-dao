import { useEffect, useState } from 'react';
import { adeGet, adeSend } from '../lib/ade';
import { summarizeDiff } from '../lib/chat-view';
import { Button } from '../ui/button';

interface Changes {
  git: boolean;
  status: string;
  diff: string;
  branch?: string;
}

export function ChangesPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [data, setData] = useState<Changes | null>(null);
  const [msg, setMsg] = useState('');
  const [openDiff, setOpenDiff] = useState(false);
  useEffect(() => {
    let dead = false;
    adeGet<Changes>(`/sessions/${encodeURIComponent(sessionId)}/changes`)
      .then((r) => {
        if (!dead) setData(r);
      })
      .catch((err: unknown) => {
        if (!dead) setMsg(err instanceof Error ? err.message : '读不到改动');
      });
    return () => {
      dead = true;
    };
  }, [sessionId]);
  const summary = summarizeDiff(data?.diff ?? '');
  const deliver = async () => {
    setMsg('');
    try {
      await adeSend(`/sessions/${encodeURIComponent(sessionId)}/deliver`, 'POST', {});
      setMsg('已交出去');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '没交成');
    }
  };
  return (
    <aside
      className="absolute inset-0 z-20 flex flex-col bg-panel md:static md:z-auto md:w-80 md:shrink-0 md:border-l md:border-edge"
      data-testid="changes-panel"
    >
      <div className="flex h-10 items-center justify-between border-b border-line px-3">
        <span className="text-xs font-medium">改动{data?.branch ? ` · ${data.branch}` : ''}</span>
        <Button variant="ghost" size="sm" onClick={onClose}>
          收起
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-xs">
        {data ? (
          <>
            <p className="text-ink-2">
              {summary.files > 0
                ? `改了 ${summary.files} 个文件 +${summary.add} -${summary.del}`
                : data.status.trim()
                  ? '工作区有状态，补丁里没有已跟踪的改动'
                  : '没有改动'}
            </p>
            {data.status.trim() ? (
              <pre className="mt-2 font-mono text-2xs whitespace-pre-wrap text-muted">{data.status}</pre>
            ) : null}
            {data.diff.trim() ? (
              <>
                <Button className="mt-2" variant="ghost" size="sm" onClick={() => setOpenDiff((v) => !v)}>
                  {openDiff ? '收起 diff' : '展开 diff'}
                </Button>
                {openDiff ? (
                  <pre className="mt-2 overflow-x-auto font-mono text-2xs whitespace-pre">{data.diff}</pre>
                ) : null}
                <Button className="mt-3" size="sm" onClick={() => void deliver()}>
                  交付
                </Button>
              </>
            ) : null}
          </>
        ) : (
          <p className="text-muted">{msg || '正在读改动…'}</p>
        )}
        {msg && data ? <p className="mt-2 text-2xs text-danger">{msg}</p> : null}
      </div>
    </aside>
  );
}
