// 单个工具调用一行和超长文字的截断（#3140、#3277）：过程里展开一步、会话里展开一组调用都用这一份，动词、+/-、失败红字一致。
// 只拼 components/layout 的件（ToolToggle、OutputBox、ClampedText），不写样式（#3533）。
import { toolClass } from '@fleet-dao/shared';
import { useState } from 'react';
import type { TranscriptEntry } from '../api/types';
import { callVerb } from '../lib/task-process';
import { DiffStat } from './diff-stat';
import { Button } from './layout/button';
import { Text } from './layout/text';
import { ClampedText, OutputBox, ToolToggle } from './layout/transcript';

/** 工具结果超过这个行数或字数就截断，点「显示全部」看全文。 */
export const CLAMP_LINES = 16;
export const CLAMP_CHARS = 1200;

/**
 * 超长文字：只露开头，点「显示全部」看全文。短的原样画，不带按钮。full：在会话里找命中了它，整段放出来。
 * variant：output 工具输出（默认）；body 正文。
 */
export function Clamped({
  text,
  variant = 'output',
  dataKind,
  full = false,
}: {
  text: string;
  variant?: 'output' | 'body';
  dataKind?: string;
  full?: boolean;
  /** 已作废：样式由 variant 给，页面不再传类名；留着只为还没改的调用处能编过。 */
  className?: string;
}) {
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > CLAMP_LINES || text.length > CLAMP_CHARS;
  const shown =
    long && !all && !full ? `${lines.slice(0, CLAMP_LINES).join('\n').slice(0, CLAMP_CHARS)}…` : text;
  return (
    <>
      <ClampedText variant={variant} {...(dataKind !== undefined ? { 'data-kind': dataKind } : {})}>
        {shown}
      </ClampedText>
      {long && !full ? (
        <Button size="xs" variant="text" aria-expanded={all} onClick={() => setAll((v) => !v)}>
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
    <ToolToggle
      data-call
      data-failed={failed ? '' : undefined}
      open={open}
      onToggle={() => setPicked(!open)}
      lead={verb || undefined}
      label={call.text}
      title={call.text}
      failed={failed}
      wrap
      mono
      trailing={
        <>
          {cls === 'edit' && result ? (
            <DiffStat added={metaInt(result, 'added')} removed={metaInt(result, 'removed')} />
          ) : null}
          {state === 'unknown' ? (
            <Text size="meta" tone="muted">
              没读到结果
            </Text>
          ) : exitUnknown ? (
            <Text
              size="meta"
              tone="muted"
              title="这一家的流里没有命令的退出码：只知道命令跑完了，成没成不知道"
            >
              结果未知
            </Text>
          ) : null}
        </>
      }
    >
      <OutputBox data-call-result failed={failed}>
        {result ? (
          <Clamped text={result.text || '（无输出）'} full={forceOpen} />
        ) : (
          <Text size="meta" tone="muted">
            {live ? '还没有结果' : '这一笔收场时没有记下结果'}
          </Text>
        )}
      </OutputBox>
    </ToolToggle>
  );
}
