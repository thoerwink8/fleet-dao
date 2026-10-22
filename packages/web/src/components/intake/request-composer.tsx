// 输入区（#2062）：一块输入框，右下角发送；电脑上 Enter 发送、Shift+Enter 换行，手机上 Enter 是换行。
// 打 @ 弹出候选：指挥官，和这条需求里出现过的人（发起人、说过话的、拍板人）。@ 了谁按人的编号带给后端。
// 发没成：字留在框里，框下面写原因（不丢人打的字）。模型芯片、「让指挥官接着问」由页面经 tools 放进左下角。
// 结案后输入框换成一条细栏「已结案，内容不再改 · 接着这条提」（手机上没有「接着这条提」）。
import { AtSign } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { RequestPerson } from '../../api/types';
import { Button } from '../layout/button';
import { Composer as ComposerBox } from '../layout/chat';
import { Notice } from '../layout/notice';
import { Text } from '../layout/text';

/** 发出去的话里 @ 了哪些人（按名字找回编号；指挥官不是人，不带编号）。 */
export function mentionIds(text: string, people: readonly RequestPerson[]): string[] {
  return people.filter((p) => text.includes(`@${p.name}`)).map((p) => p.id);
}

export function Composer({
  people,
  phone,
  busy,
  error,
  placeholder,
  onSend,
  inputId = 'intake-input',
  tools,
}: {
  /** 输入框左下角的东西（模型芯片、「让指挥官接着问」）。 */
  tools?: ReactNode;
  /** @ 的候选人（不含自己）。 */
  people: readonly RequestPerson[];
  phone: boolean;
  busy: boolean;
  error?: string | undefined;
  placeholder?: string;
  /** 发出去：成了返回 true（清空输入框），没成返回 false（字留着）。 */
  onSend: (text: string, mentions: string[]) => Promise<boolean>;
  inputId?: string;
}) {
  const [text, setText] = useState('');
  const pending = /(^|\s)@([^\s]*)$/.exec(text);
  const names = ['指挥官', ...people.map((p) => p.name)];
  const candidates = pending ? names.filter((c) => c.startsWith(pending[2] ?? '')) : [];
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    if (await onSend(t, mentionIds(t, people))) setText('');
  };
  const focusInput = () => document.getElementById(inputId)?.focus();
  return (
    <div data-intake-composer>
      <ComposerBox
        value={text}
        onChange={setText}
        onSend={send}
        sending={busy}
        label="消息"
        inputId={inputId}
        placeholder={placeholder ?? '说说你想要什么，大白话就行……'}
        enterToSend={!phone}
        hint={phone ? '' : 'Enter 发送，Shift+Enter 换行'}
        suggestions={candidates.map((c) => `@${c}`)}
        onPickSuggestion={(c) => {
          setText((t) => `${t.replace(/@[^\s]*$/, '')}${c} `);
          focusInput();
        }}
        tools={
          <>
            {tools}
            <Button
              size="xs"
              iconOnly
              variant="secondary"
              aria-label="@ 提到某人"
              title="@ 提到某人"
              onClick={() => {
                setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}@`);
                focusInput();
              }}
            >
              <AtSign />
            </Button>
          </>
        }
      />
      {error ? (
        <div data-send-error>
          <Text size="meta" tone="danger">
            没发出去：{error}（你写的话还在框里）
          </Text>
        </div>
      ) : null}
    </div>
  );
}

/** 结案后的细栏。 */
export function ClosedBar({ phone, onContinue }: { phone: boolean; onContinue: () => void }) {
  return (
    <div data-intake-lock>
      <Notice
        tone="info"
        action={
          phone ? undefined : (
            <Button size="xs" variant="outline" onClick={onContinue} data-continue="">
              接着这条提
            </Button>
          )
        }
      >
        已结案，内容不再改
      </Notice>
    </div>
  );
}
