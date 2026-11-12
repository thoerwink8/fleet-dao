import { useEffect, useRef, useState } from 'react';
import { adeGet, adeSend } from '../lib/ade';
import { checkStatusView } from '../lib/check-status';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog';
import { Textarea } from '../ui/textarea';
import { DiffView } from './diff-view';

interface GitFile {
  path: string;
  origPath?: string;
  staged: string | null;
  unstaged: string | null;
}

interface WorktreeInfo {
  path: string;
  branch: string;
  primary: boolean;
  clean: boolean;
  merged: boolean;
  idle: boolean;
  removable: boolean;
  reason: string;
}

interface Snapshot {
  git: boolean;
  branch: string;
  head?: string;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  files: GitFile[];
  worktrees: WorktreeInfo[];
  forge: string;
  ops: { key: string; kind: string; state: string }[];
  notice?: string;
}

interface FileDiff {
  path: string;
  staged: string;
  unstaged: string;
  untracked: string;
}

interface Checks {
  pr: { number: number; url: string; state: string; checks: { name: string; state: string }[] } | null;
  reason: string;
}

const KIND: Record<string, string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
  copied: '复制',
  untracked: '未跟踪',
  conflict: '冲突',
  typechange: '类型变了',
};

const OP: Record<string, string> = {
  'change.push': '推送',
  'change.pr.open': '开 PR',
  'change.merge': '合并',
};

const STATE: Record<string, string> = {
  pending: '已排上',
  claimed: '在做',
  done: '完成',
  unknown: '结果未知',
  dead: '停了',
};

function fileLabel(f: GitFile): string {
  const parts: string[] = [];
  if (f.staged) parts.push(`已暂存${KIND[f.staged] ?? f.staged}`);
  if (f.unstaged) parts.push(KIND[f.unstaged] ?? f.unstaged);
  return parts.join(' · ') || '改动';
}

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/');
}

function isSnapshot(v: unknown): v is Snapshot {
  return !!v && typeof v === 'object' && 'files' in v && 'branch' in v;
}

export function ChangesPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [message, setMessage] = useState('');
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [checks, setChecks] = useState<Checks | null>(null);
  const [preview, setPreview] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeHead, setMergeHead] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    let dead = false;
    const load = () => {
      if (busyRef.current) return;
      adeGet<Snapshot>(`/sessions/${encodeURIComponent(sessionId)}/changes`)
        .then((r) => {
          if (!dead) setData(r);
        })
        .catch((e: unknown) => {
          if (!dead) setErr(e instanceof Error ? e.message : '读不到改动');
        });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [sessionId]);

  const act = async (op: string, extra?: Record<string, unknown>): Promise<boolean> => {
    busyRef.current = true;
    setBusy(true);
    setErr('');
    setNote('');
    const openPath = diff?.path;
    try {
      const res = await adeSend<Snapshot>(`/sessions/${encodeURIComponent(sessionId)}/git`, 'POST', {
        op,
        ...extra,
      });
      if (isSnapshot(res)) setData(res);
      if (res.notice) setNote(res.notice);
      // 打开着的 diff 跟这次结果对不上就收起。提交后文件从名单消失，暂存后要重读，不然还显示旧的「未跟踪」。
      if (openPath && isSnapshot(res)) {
        const still = res.files.some((f) => f.path === openPath);
        if (!still) {
          setDiff(null);
        } else if (op === 'stage' || op === 'unstage') {
          try {
            setDiff(
              await adeSend<FileDiff>(`/sessions/${encodeURIComponent(sessionId)}/git`, 'POST', {
                op: 'diff',
                path: openPath,
              }),
            );
          } catch {
            setDiff(null);
          }
        }
      }
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : '没做成');
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const openFile = async (path: string) => {
    setErr('');
    try {
      const res = await adeSend<FileDiff>(`/sessions/${encodeURIComponent(sessionId)}/git`, 'POST', {
        op: 'diff',
        path,
      });
      setDiff(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '读 diff 没成');
    }
  };

  const loadChecks = async () => {
    setErr('');
    setBusy(true);
    try {
      setChecks(
        await adeSend<Checks>(`/sessions/${encodeURIComponent(sessionId)}/git`, 'POST', { op: 'checks' }),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : '读 CI 没成');
    } finally {
      setBusy(false);
    }
  };

  const removable = data?.worktrees.filter((w) => w.removable) ?? [];
  const tracked = data?.upstream ? `领先 ${data.ahead ?? 0} · 落后 ${data.behind ?? 0}` : '没有上游';

  return (
    <aside
      className="absolute inset-0 z-20 flex flex-col overflow-hidden bg-panel md:static md:z-auto md:w-[28rem] md:shrink-0 md:border-l md:border-edge"
      data-testid="changes-panel"
    >
      <div className="flex h-10 items-center justify-between border-b border-line px-3">
        <span className="truncate text-xs font-medium" data-testid="git-branch">
          Git{data?.branch ? ` · ${data.branch}` : ''}
        </span>
        <Button variant="ghost" size="sm" onClick={onClose}>
          收起
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-xs">
        {!data ? (
          <p className="text-muted">{err || '正在读改动…'}</p>
        ) : !data.git ? (
          <p className="text-ink-2">这个目录不是 git 仓</p>
        ) : (
          <>
            <p className="text-ink-2">
              <span className="font-mono">{data.branch || '游离'}</span>
              {data.head ? <span className="text-muted"> · {data.head.slice(0, 7)}</span> : null}
              <span className="text-muted"> · {tracked}</span>
              {data.forge ? <span className="text-muted"> · {data.forge}</span> : null}
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void act('pull')}>
                拉取
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void act('push')}>
                推送
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void act('pr')}>
                开 PR
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || (data.forge === 'github' && !data.head)}
                onClick={() => {
                  if (data.forge === 'github') {
                    setMergeHead(data.head ?? '');
                    setMergeOpen(true);
                    return;
                  }
                  void act('merge');
                }}
              >
                合并
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void loadChecks()}>
                看 CI
              </Button>
            </div>
            {checks ? (
              <div className="mt-2 text-2xs text-ink-2" data-testid="git-checks">
                {checks.pr ? (
                  <>
                    <p>
                      PR #{checks.pr.number} {checks.pr.state}
                      {checks.pr.url ? (
                        <>
                          {' '}
                          <a className="underline" href={checks.pr.url}>
                            打开
                          </a>
                        </>
                      ) : null}
                    </p>
                    {checks.pr.checks.length === 0 ? (
                      <p className="text-muted">没有检查</p>
                    ) : (
                      <ul>
                        {checks.pr.checks.map((c) => {
                          const view = checkStatusView(c.state);
                          return (
                            <li key={c.name} className="mt-1 flex items-center gap-1.5">
                              <span className={`size-1.5 shrink-0 rounded-full ${view.dot}`} />
                              <span>
                                {c.name} · {view.label}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </>
                ) : (
                  <p className="text-muted">{checks.reason || '没有 PR'}</p>
                )}
              </div>
            ) : null}
            {data.ops.length > 0 ? (
              <ul className="mt-2 text-2xs text-muted">
                {data.ops.map((o) => (
                  <li key={o.key}>
                    {OP[o.kind] ?? o.kind} · {STATE[o.state] ?? o.state}
                  </li>
                ))}
              </ul>
            ) : null}

            <Textarea
              className="mt-3 text-xs"
              placeholder="提交说明"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <div className="mt-1 flex flex-wrap gap-1">
              <Button
                size="sm"
                disabled={busy || message.trim() === ''}
                onClick={() => void act('commit', { message })}
              >
                提交
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || data.files.every((f) => !f.unstaged)}
                onClick={() =>
                  void act('stage', { paths: data.files.filter((f) => f.unstaged).map((f) => f.path) })
                }
              >
                全部暂存
              </Button>
            </div>

            <div className="mt-3" data-testid="git-files">
              {data.files.length === 0 ? (
                <p className="text-muted">没有改动</p>
              ) : (
                data.files.map((f) => (
                  <div key={f.path} className="mt-1 flex flex-wrap items-center gap-1" data-testid="git-file">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-w-0 shrink justify-start"
                      onClick={() => void openFile(f.path)}
                    >
                      <span className="truncate font-mono">{f.path}</span>
                    </Button>
                    <Badge title={fileLabel(f)}>{fileLabel(f)}</Badge>
                    {f.unstaged ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void act('stage', { paths: [f.path] })}
                      >
                        暂存
                      </Button>
                    ) : null}
                    {f.staged ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void act('unstage', { paths: [f.path] })}
                      >
                        取消暂存
                      </Button>
                    ) : null}
                  </div>
                ))
              )}
            </div>

            {diff ? (
              <div className="mt-3" data-testid="git-diff">
                <p className="font-mono text-2xs text-ink-2">{diff.path}</p>
                {diff.staged ? (
                  <>
                    <p className="mt-1 text-2xs text-muted">已暂存</p>
                    <DiffView text={diff.staged} />
                  </>
                ) : null}
                {diff.unstaged ? (
                  <>
                    <p className="mt-1 text-2xs text-muted">未暂存</p>
                    <DiffView text={diff.unstaged} />
                  </>
                ) : null}
                {diff.untracked ? (
                  <>
                    <p className="mt-1 text-2xs text-muted">未跟踪</p>
                    <DiffView text={diff.untracked} />
                  </>
                ) : null}
                {!diff.staged && !diff.unstaged && !diff.untracked ? (
                  <p className="text-muted">没有 diff</p>
                ) : null}
              </div>
            ) : null}
          </>
        )}

        {data && data.worktrees.length > 0 ? (
          <div className="mt-4 border-t border-line pt-3" data-testid="worktrees">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">工作树</span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || removable.length === 0}
                onClick={() => setPreview(true)}
              >
                清理可删的
                <span className="num">{removable.length}</span>
              </Button>
            </div>
            {data.worktrees.map((w) => (
              <div
                key={w.path}
                className="mt-2"
                data-testid="worktree-row"
                data-removable={w.removable ? '1' : '0'}
              >
                <p className="truncate font-mono" title={w.path}>
                  {w.branch || '游离'} · {shortPath(w.path)}
                </p>
                <p className="text-2xs text-muted">{w.reason}</p>
              </div>
            ))}
          </div>
        ) : null}

        {note ? <p className="mt-2 text-2xs text-ink-2">{note}</p> : null}
        {err && data ? <p className="mt-2 text-2xs text-danger">{err}</p> : null}
      </div>

      <Dialog open={preview} onOpenChange={setPreview}>
        <DialogContent
          title="要删这些工作树"
          description="只删目录，不删分支。确认时再查一遍：有没提交的改动、还在跑的会话、没合并的，都不会删。"
        >
          <ul className="max-h-48 overflow-y-auto text-2xs">
            {removable.map((w) => (
              <li key={w.path} className="mt-1 font-mono break-all text-ink-2">
                {w.branch || '游离'} · {w.path}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm">
                取消
              </Button>
            </DialogClose>
            <Button
              variant="danger"
              size="sm"
              disabled={busy || removable.length === 0}
              onClick={() => {
                void act('worktree-remove', { paths: removable.map((w) => w.path), confirm: true }).then(
                  (ok) => {
                    if (ok) setPreview(false);
                  },
                );
              }}
            >
              删除
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <DialogContent
          title="合并这个 PR"
          description="按你看到的这次提交合并。确认时再对一次：分支上又有新提交就不会合。"
        >
          <p className="break-all font-mono text-2xs text-ink-2" data-testid="merge-head">
            {mergeHead}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm">
                取消
              </Button>
            </DialogClose>
            <Button
              variant="danger"
              size="sm"
              disabled={busy || mergeHead === ''}
              onClick={() => {
                void act('merge', { confirm: true, head: mergeHead }).then((ok) => {
                  if (ok) setMergeOpen(false);
                });
              }}
            >
              合并
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
