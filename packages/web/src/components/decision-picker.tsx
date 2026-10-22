// 「要你拍」的选项区（#1915；#2353 起直接摆在详情里）：通知中心的「要你拍」和看门狗提醒里要本人拍的修复动作（#3034）共用这一份。
// #3533 照样稿 Inbox.dc.html：一个选项一行——左边按钮（推荐的描边、别的灰底），中间一句真实效果和推荐理由，右边「推荐」「上次选的」标；
// 下面是「都不合适？自己写一句」的多行框加「提交」，框下一行灰字写自己写的去向（effect）。没有选项的只给输入框。
// 一块只有一个主按钮：这里没有主按钮，提交是灰底次按钮。页面只拼 components/layout 的件。
import { Send } from 'lucide-react';
import type { DecisionOption } from '../api/types';
import { Button } from './layout/button';
import { Form, FormItem } from './layout/form';
import { Textarea } from './layout/input';
import { List, ListRow } from './layout/list';
import { Section } from './layout/section';
import { Stack } from './layout/stack';
import { Tag } from './layout/tag';
import { Text } from './layout/text';

/** 回答一条「要你拍」：点一个选项，或自己写一段。 */
export type AnswerInput = { optionId: string } | { text: string };

export function DecisionPicker({
  id,
  options,
  lastOptionId,
  pending,
  text,
  onText,
  onAnswer,
  effect,
}: {
  id: string;
  options: readonly DecisionOption[];
  /** 上次选的那项（带「上次选的」）。 */
  lastOptionId?: string | undefined;
  pending: boolean;
  /** 自己写的草稿放在详情上：答了没做成、再答时还在。 */
  text: string;
  onText: (text: string) => void;
  onAnswer: (input: AnswerInput) => void;
  /** 自己写的一句去哪：框下那行灰字。 */
  effect: string;
}) {
  const trimmed = text.trim();
  const blocked = pending ? '正在提交，等它回话' : trimmed ? undefined : '先写一句再提交';
  return (
    <Section variant="plain" id={id} data-testid="decision-picker">
      <Stack gap="md">
        {options.length > 0 ? (
          <List aria-label="选一个">
            {options.map((o) => (
              <ListRow
                key={o.id}
                summary={
                  <Stack direction="horizontal" gap="md" align="start" wrap>
                    <Button
                      size="sm"
                      variant={o.recommended ? 'outline' : 'secondary'}
                      aria-label={o.label}
                      aria-describedby={`${id}-${o.id}`}
                      {...(pending ? { disabledReason: '正在提交，等它回话' } : {})}
                      onClick={() => onAnswer({ optionId: o.id })}
                    >
                      {o.label}
                    </Button>
                    <Stack gap="sm">
                      <Text id={`${id}-${o.id}`} size="meta" tone="muted">
                        {o.detail}
                      </Text>
                      {o.recommended ? (
                        <Text size="meta" tone="muted">
                          推荐理由：{o.recommended}
                        </Text>
                      ) : null}
                    </Stack>
                    {o.recommended ? <Tag>推荐</Tag> : null}
                    {lastOptionId === o.id ? <Tag>上次选的</Tag> : null}
                  </Stack>
                }
              />
            ))}
          </List>
        ) : null}
        <Form
          onSubmit={() => {
            if (trimmed && !pending) onAnswer({ text: trimmed });
          }}
        >
          <FormItem
            label={options.length > 0 ? '都不合适？自己写一句' : '写你的决定'}
            layout="vertical"
            htmlFor={`${id}-free`}
            help={effect}
          >
            <Textarea
              id={`${id}-free`}
              aria-label="自己写一句"
              placeholder="写一句，交给指挥官去办"
              value={text}
              maxLength={2000}
              disabled={pending}
              onChange={(e) => onText(e.target.value)}
            />
          </FormItem>
          <Stack direction="horizontal" gap="sm">
            <Button
              type="submit"
              size="sm"
              {...(blocked ? { disabledReason: blocked } : {})}
              loading={pending}
            >
              <Send aria-hidden />
              提交
            </Button>
          </Stack>
        </Form>
      </Stack>
    </Section>
  );
}
