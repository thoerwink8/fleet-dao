// 首页进度栏（#199）：要你定的、在做的、最近动态。标题从品牌读。
import type { ReactNode } from 'react';
import { brand } from '#brand';
import { errorText, useAnswerSeatNeed, useSeatBoard } from '../api/client';
import { Button } from '../components/ui/button';
import { formatAgo } from '../lib/format';
import { useNow } from '../lib/hooks';

const STATUS: Record<string, string> = {
  done: '做完了',
  doing: '在做',
  waiting: '排着',
  needs: '等你拍',
  blocked: '卡住了',
};

/** 读失败整栏写「没读到」和原因，三块都不渲染。读成功但空，各块写「没有」。 */
export function SeatBar() {
  const board = useSeatBoard();
  const answer = useAnswerSeatNeed();
  const now = useNow();
  return (
    <section aria-label={brand.seatBarTitle} className="border-b bg-card px-3 py-2 text-sm">
      <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground">{brand.seatBarTitle}</h2>
      {board.isLoading ? <p className="text-muted-foreground">在读…</p> : null}
      {board.error ? (
        <p role="alert" className="text-ink-fail">
          没读到：{errorText(board.error)}
        </p>
      ) : null}
      {board.data ? (
        <>
          <p className="mb-2 text-xs text-muted-foreground">
            {board.data.seat
              ? `${brand.seatBarTitle}：第 ${board.data.seat.term} 任 ${board.data.seat.holder}，最后活动 ${formatAgo(board.data.seat.lastActivityAt, now)}`
              : `${brand.seatBarTitle}：还没人接班`}
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            <Block title="要你定的">
              {board.data.projects.every((p) => p.needs.length === 0) ? <Empty>没有要你定的</Empty> : null}
              {board.data.projects.flatMap((p) =>
                p.needs.map((n) => (
                  <div key={n.id} className="mb-2">
                    <p>
                      {p.project} · {n.question}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {n.options.map((option) => (
                        <Button
                          key={option}
                          size="sm"
                          variant={option === n.recommended ? 'default' : 'outline'}
                          className="h-7 px-2 text-xs"
                          disabled={answer.isPending}
                          onClick={() => answer.mutate({ needId: n.id, option })}
                        >
                          {option}
                        </Button>
                      ))}
                    </div>
                  </div>
                )),
              )}
            </Block>
            <Block title="在做的">
              {board.data.projects.every((p) => p.steps.length === 0) ? <Empty>没有在做的</Empty> : null}
              {board.data.projects.flatMap((p) =>
                [...p.steps]
                  .sort((a, b) => a.order - b.order)
                  .map((s) => (
                    <p key={`${p.project}-${s.id}`}>
                      {p.project} · {STATUS[s.status] ?? s.status} · {s.title}
                      <span className="text-muted-foreground"> · {formatAgo(s.updatedAt, now)}</span>
                    </p>
                  )),
              )}
            </Block>
            <Block title="最近动态">
              {board.data.projects.every((p) => p.log.length === 0) ? <Empty>没有动态</Empty> : null}
              {board.data.projects.flatMap((p) =>
                p.log.map((e) => (
                  <p key={`${p.project}-${e.at}-${e.text}`}>
                    {e.text}
                    <span className="text-muted-foreground"> · {formatAgo(e.at, now)}</span>
                  </p>
                )),
              )}
            </Block>
          </div>
        </>
      ) : null}
    </section>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-xs text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="text-muted-foreground">{children}</p>;
}
