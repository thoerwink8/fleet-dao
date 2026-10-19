// 单个工具调用一行和超长文字的截断（#3140、#3277）：过程里展开一步、会话里展开一组调用都用这一份，动词、+/-、失败红字一致。
import { toolClass } from '@fleet-dao/shared';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { TranscriptEntry } from '../api/types';
import { callVerb } from '../lib/task-process';
import { cn } from '../lib/utils';
import { DiffStat } from './diff-stat';
import { Button } from './ui/button';

/** 工具结果超过这个行数或字数就截断，点「显示全部」看全文。 */
export const CLAMP_LINES = 16;
export const CLAMP_CHARS = 1200;

/** 超长文字：只露开头，点「显示全部」看全文。短的原样画，不带按钮。full：在会话里找命中了它，整段放出来。 */
export function Clamped({
  text,
  className,
  dataKind,
  full = false,
}: {
  text: string;
  className: string;
  dataKind?: string;
  full?: boolean;
}) {
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > CLAMP_LINES || text.length > CLAMP_CHARS;
  const shown =
    long && !all && !full ? `${lines.slice(0, CLAMP_LINES).join('\n').slice(0, CLAMP_CHARS)}…` : text;
  return (
    <>
      <p className={className} data-kind={dataKind}>
        {shown}
      </p>
      {long && !full ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="mt-1 -ml-1.5"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
        >
          {all ? '收起' : '显示全部'}
        </Button>
      ) : null}
    </>
  );
}

const metaInt = (e: TranscriptEntry, key: string): number | undefined => {
  const v = e.meta?.[key];
  return typeof v === 'number' ? v : undefined;
};

/**
 * 单个调用一行：灰色动词 + 对象，改文件带 +/-，失败标红；点开看工具回的结果。没成的自动展开，人点过一次就听人的；
 * forceOpen：在会话里找命中了它，展开并放出全文。live：这一笔还在跑（没结果写「还没有结果」而不是没记下）。
 */
export function CallRow({
  call,
  result,
  live,
  forceOpen = false,
}: {
  call: TranscriptEntry;
  result: TranscriptEntry | undefined;
  live: boolean;
  forceOpen?: boolean;
}) {
  const failed = result?.ok === false;
  const state = failed ? 'failed' : result ? 'ok' : live ? 'pending' : 'unknown';
  const cls = toolClass(call.tool);
  const verb = cls === 'agent' ? '' : callVerb(call.tool, state === 'unknown' ? 'ok' : state);
  const [picked, setPicked] = useState<boolean | undefined>(undefined);
  const open = forceOpen || (picked ?? failed);
  // 命令没有可信的退出码（Mirasim 的流里没有）：结果是「完成」，不是「成功」
  const exitUnknown = cls === 'command' && result?.meta?.exitKnown === false;
  return (
    <div className="min-w-0 text-body" data-call data-failed={failed ? '' : undefined}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setPicked(!open)}
        className="flex min-h-8 w-full min-w-0 items-baseline gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-md:min-h-10 max-md:items-center"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 translate-y-0.5 text-muted-foreground max-md:translate-y-0',
            open && 'rotate-90',
          )}
          aria-hidden
        />
        {verb ? (
          <span className={cn('shrink-0', failed ? 'font-medium text-ink-fail' : 'text-muted-foreground')}>
            {verb}
          </span>
        ) : null}
        <span
          className={cn('num min-w-0', open ? 'break-words' : 'truncate', failed && 'text-ink-fail')}
          title={call.text}
        >
          {call.text}
        </span>
        {cls === 'edit' && result ? (
          <DiffStat added={metaInt(result, 'added')} removed={metaInt(result, 'removed')} />
        ) : null}
        {state === 'unknown' ? (
          <span className="shrink-0 text-meta text-muted-foreground">没读到结果</span>
        ) : exitUnknown ? (
          <span
            className="shrink-0 text-meta text-muted-foreground"
            title="这一家的流里没有命令的退出码：只知道命令跑完了，成没成不知道"
          >
            结果未知
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className={cn(
            'mt-1 mb-1 ml-5 rounded-md border px-2.5 py-1.5',
            failed ? 'border-st-fail-line bg-st-fail-soft' : 'bg-muted',
          )}
          data-call-result
        >
          {result ? (
            <Clamped
              text={result.text || '（无输出）'}
              full={forceOpen}
              className="num min-w-0 text-meta break-words whitespace-pre-wrap"
            />
          ) : (
            <span className="text-meta text-muted-foreground">
              {live ? '还没有结果' : '这一笔收场时没有记下结果'}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
