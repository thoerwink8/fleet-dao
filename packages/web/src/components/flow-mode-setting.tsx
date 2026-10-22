// 设置页的全程模式开关（engine.flowMode，#2828）：三段 / 对半分（split:50）/ 全程。
// 点了先二次确认，原因必填。写走通用的 PUT /settings/engine.flowMode（版本号、操作记录都在那条路上）。
// 改不成：选项留在改之前的值，原因写在这一行上。
import {
  FLOW_MODE_SETTING,
  type FlowModeReading,
  flowModeSwitchText,
  formatFlowModeSetting,
  readFlowModeSetting,
} from '@fleet-dao/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { errorText, useUpdateSetting } from '../api/client';
import type { Setting } from '../api/types';
import { settingLabel } from '../lib/audit';
import { ConfirmDialog } from './layout/confirm-dialog';
import { FilterTabs } from './layout/filter-tabs';
import { Form, FormItem } from './layout/form';
import { Input, Label } from './layout/input';
import { Stack } from './layout/stack';
import { Text } from './layout/text';

const CHOICES = [
  { id: 'three', label: '三段' },
  { id: 'split:50', label: '对半分' },
  { id: 'full', label: '全程' },
] as const;

type ChoiceId = (typeof CHOICES)[number]['id'];

const DETAIL: Record<ChoiceId, string> = {
  three: '写成 three。之后新分组的单都走三步单。',
  'split:50': '写成 split:50。之后新分组的单大约一半走全程，其余走三步单。',
  full: '写成 full。之后新分组的单都走全程。',
};

function isChoice(value: string): value is ChoiceId {
  return CHOICES.some((c) => c.id === value);
}

function choiceLabel(id: ChoiceId): string {
  return CHOICES.find((c) => c.id === id)?.label ?? id;
}

/** 认得出、并且就是这三个档位之一，才把对应的按钮按下。别的百分比、认不出的值都不按下，免得看成「对半分」或「三段」。 */
function selectedChoice(reading: FlowModeReading): ChoiceId | undefined {
  if (reading.state === 'unrecognized') return undefined;
  const formatted = formatFlowModeSetting(reading.setting);
  return isChoice(formatted) ? formatted : undefined;
}

export function FlowModeSetting({ s }: { s: Setting | undefined }) {
  const update = useUpdateSetting();
  const reading = readFlowModeSetting(s?.value);
  const selected = selectedChoice(reading);
  const [ask, setAsk] = useState<ChoiceId | null>(null);
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const why = reason.trim();

  const pick = (id: ChoiceId) => {
    if (update.isPending) return;
    if (id === selected) return;
    setFailure(null);
    setReason('');
    setAsk(id);
  };

  const confirm = async () => {
    if (!ask || why === '') throw new Error('先写一句原因');
    try {
      await update.mutateAsync({
        key: FLOW_MODE_SETTING,
        body: { value: ask, version: s?.version ?? 0, reason: why },
      });
      setFailure(null);
      setReason('');
      setAsk(null);
      toast.success(`已保存：${settingLabel[FLOW_MODE_SETTING]}`);
    } catch (e) {
      const text = errorText(e);
      setFailure(text);
      toast.error('没改成', { description: text });
      throw e instanceof Error ? e : new Error(text);
    }
  };

  const askLabel = ask ? choiceLabel(ask) : '';

  return (
    <Form aria-label={settingLabel[FLOW_MODE_SETTING]}>
      <FormItem
        label={settingLabel[FLOW_MODE_SETTING]}
        error={failure ?? undefined}
        help={
          <>
            新开的单走哪一种。三段是对题、动手、验收各一段；对半分是大约一半走全程（split:50）；全程是一个会话自己走到合并。已经分过组的单保持分组时定下的模式。改的时候要写原因。
            <span data-flow-mode-current>
              <Text size="meta" tone="muted" block>
                {flowModeSwitchText(reading)}
              </Text>
            </span>
          </>
        }
      >
        <FilterTabs mode="toggle" aria-label="全程模式" items={CHOICES} value={selected} onChange={pick} />
      </FormItem>
      <ConfirmDialog
        open={ask !== null}
        onOpenChange={(open) => {
          if (open || update.isPending) return;
          setAsk(null);
          setReason('');
        }}
        title={`改成「${askLabel}」？`}
        description={`${ask ? DETAIL[ask] : ''}已经分过组的单保持分组时定下的模式。`}
        confirmText={`确认改成${askLabel}`}
        confirmDisabled={why === ''}
        onConfirm={confirm}
      >
        <Stack gap="sm">
          <Label htmlFor="flow-mode-reason">原因</Label>
          <Input
            id="flow-mode-reason"
            value={reason}
            maxLength={500}
            placeholder="为什么改"
            onChange={(e) => setReason(e.target.value)}
          />
        </Stack>
      </ConfirmDialog>
    </Form>
  );
}
