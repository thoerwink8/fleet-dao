// 通知中心右边的详情（#3533，样稿 Inbox.dc.html 的 aside）：标题、类型、正文全文、处理情况，
// 「要你拍」下面直接是选项和自己写一句，看门狗的卡住报警下面是受控修复区；最后是「处理了」「打开」。页面只拼 components/layout 的件。
import { answerResolves, NO_OPTIONS_TEXT } from '@fleet-dao/shared';
import { Check, X } from 'lucide-react';
import { useId, useState } from 'react';
import type { Me, Notification } from '../../api/types';
import { decisionResult } from '../../lib/decision-result';
import { formatAgo, formatClock, formatDateTime } from '../../lib/format';
import { readFail } from '../../lib/read';
import { isMine, noticeLevelMeta } from '../../lib/status';
import { AlertRepairPanel, type RepairRefresh } from '../alert-repair';
import { type AnswerInput, DecisionPicker } from '../decision-picker';
import { Button } from '../layout/button';
import { Descriptions, type DescriptionsItem } from '../layout/descriptions';
import { Section } from '../layout/section';
import { Stack } from '../layout/stack';
import { Tag } from '../layout/tag';
import { Text } from '../layout/text';
import { DecisionAnswerLine, Deliveries, HandlingValue } from './notice-parts';

export interface NoticeActions {
  resolvePending: boolean;
  resolveId: string | undefined;
  /** 正在回答的那一条（#1915）；没有在答的是 undefined。 */
  answeringId: string | undefined;
  onDone: (n: Notification) => void;
  onAnswer: (n: Notification, input: AnswerInput) => void;
  /** 看门狗修复点之前重读列表（#3034）：按钮已经不是现在的就不发。 */
  onRefreshRepair: RepairRefresh;
}

export function NoticeDetail({
  n,
  now,
  me,
  handlingProblem,
  onClose,
  ...actions
}: {
  n: Notification;
  now: number;
  me: Me | undefined;
  /** 这一页谁在处理没算成的原因（整页一份）：没算成就写「没读到」，不编「没人在修」。 */
  handlingProblem: string | undefined;
  onClose: () => void;
} & NoticeActions) {
  const resolved = Boolean(n.resolvedAt);
  const level = noticeLevelMeta[n.level];
  // 待拍的「要你拍」（#2353）：选项、自己写一句直接摆在详情里，选完系统照着做、结果写回；没有「处理了」。
  // 交给引擎在做的（删工作树）先只摆结果，点「改主意」才再摆选项。
  const deciding = !resolved && n.level === 'decision';
  const queued = deciding && n.answer ? decisionResult(n.answer).kind === 'queued' : false;
  const [repick, setRepick] = useState(false);
  const [draft, setDraft] = useState('');
  const pickerId = useId();
  const options = n.options ?? [];

  const items: DescriptionsItem[] = [];
  if (!resolved && n.handling) {
    items.push({ label: '处理情况', value: <HandlingValue h={n.handling} now={now} n={n} /> });
  } else if (!resolved && n.level === 'alert' && handlingProblem) {
    items.push({ label: '处理情况', value: readFail(handlingProblem) });
  }
  if (resolved && n.resolvedAt) {
    items.push({
      label: '处理人',
      value: (
        <Text title={formatDateTime(n.resolvedAt)}>
          {n.resolvedBy ? (isMine(n.resolvedBy, me) ? '我' : n.resolvedBy) : ''}处理于{' '}
          {formatAgo(n.resolvedAt, now)}
        </Text>
      ),
    });
  }

  return (
    <Section
      aria-label="通知详情"
      title={n.title}
      actions={
        <Button size="sm" iconOnly aria-label="关闭" onClick={onClose}>
          <X aria-hidden />
        </Button>
      }
    >
      <Stack data-notice-detail data-resolved={resolved ? 'true' : undefined}>
        <Stack direction="horizontal" gap="md" align="center" wrap>
          <Tag>{level.label}</Tag>
          <Text size="meta" tone="muted" title={formatClock(n.createdAt)}>
            {formatAgo(n.createdAt, now)}
          </Text>
          <Deliveries n={n} />
        </Stack>
        <Text pre tone="secondary">
          {n.body}
        </Text>
        {items.length > 0 ? <Descriptions columns={1} items={items} /> : null}

        {n.level === 'decision' ? (
          <Stack>
            <DecisionAnswerLine n={n} me={me} now={now} plain={resolved} />
            {deciding && options.length === 0 ? (
              <Text size="meta" tone="muted" data-testid="no-options">
                {NO_OPTIONS_TEXT}
              </Text>
            ) : null}
            {deciding && queued && !repick ? (
              <Stack direction="horizontal">
                <Button
                  size="sm"
                  aria-controls={pickerId}
                  aria-expanded={false}
                  onClick={() => setRepick(true)}
                >
                  改主意
                </Button>
              </Stack>
            ) : deciding ? (
              <DecisionPicker
                id={pickerId}
                options={options}
                lastOptionId={n.answer?.optionId}
                pending={actions.answeringId === n.id}
                text={draft}
                onText={setDraft}
                onAnswer={(input) => {
                  setRepick(false);
                  actions.onAnswer(n, input);
                }}
                effect={
                  answerResolves(options, undefined)
                    ? '自己写的：交给指挥官去办，交出去了这条转已处理'
                    : '自己写的：交给指挥官去办，这条先留着'
                }
              />
            ) : null}
          </Stack>
        ) : (
          <Stack>
            <DecisionAnswerLine n={n} me={me} now={now} plain />
            {/* 看门狗的卡住报警：后端现算能点的修复、执行到哪、核验结果（#3034）；别的提醒不渲染 */}
            <AlertRepairPanel n={n} me={me} now={now} refresh={actions.onRefreshRepair} />
          </Stack>
        )}

        <Stack direction="horizontal" gap="sm" wrap data-notice-actions>
          {/* 要你拍的不给「处理了」：只标已处理解决不了卡上的问题（#2353），选一个或写一句才算拍了 */}
          {!resolved && n.level !== 'decision' ? (
            <Button
              loading={actions.resolvePending && actions.resolveId === n.id}
              onClick={() => actions.onDone(n)}
            >
              <Check aria-hidden />
              处理了
            </Button>
          ) : null}
          {n.link ? <Button href={n.link}>打开</Button> : null}
        </Stack>
      </Stack>
    </Section>
  );
}
