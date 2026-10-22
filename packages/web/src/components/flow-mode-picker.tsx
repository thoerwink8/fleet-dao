// 法国页引擎卡里的「派单方式」一行（engine.flowMode，#2828；#3509 起从工作台页头挪到这里，样稿 canvas/France.dc.html 的引擎卡）：
// 三段 / 对半分（split:50）/ 全程 三个按钮，选了先弹确认框，原因必填（会记进操作记录）。写走通用的 PUT /settings/engine.flowMode（版本号、操作记录都在那条路上）。
// 只影响之后新派的单：分组记录写一次不覆盖，已分组的单、正在跑的保持原来的模式。
// 没设过按下三段、也不自己写入；别的百分比、认不出的值三个按钮都不按下，免得看成已经选了；读不到当前值同样三个都不按下，写明「当前值没查成」。
// 看远程环境的快照时不能改这台的开关。改不成：选项留在改之前的值，原因写在确认框里。
import {
  FLOW_MODE_SETTING,
  type FlowModeReading,
  flowModeSwitchText,
  formatFlowModeSetting,
  readFlowModeSetting,
} from '@fleet-dao/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { errorText, useSettings, useUpdateSetting } from '../api/client';
import { useSelectedNodeId } from '../lib/node';
import { ConfirmDialog } from './layout/confirm-dialog';
import { FilterTabs } from './layout/filter-tabs';
import { FormItem } from './layout/form';
import { Text } from './layout/text';
import { TextArea } from './layout/text-area';

const CHOICES = [
  { id: 'three', label: '三段' },
  { id: 'split:50', label: '对半分' },
  { id: 'full', label: '全程' },
] as const;

type ChoiceId = (typeof CHOICES)[number]['id'];

const DETAIL: Record<ChoiceId, string> = {
  three: '之后新派的单都走三段（对题、动手、验收各一段）。',
  'split:50': '之后新派的单大约一半走全程（split:50），其余走三段。',
  full: '之后新派的单都走全程（一个会话自己走到合并）。',
};

function choiceLabel(id: ChoiceId): string {
  return CHOICES.find((c) => c.id === id)?.label ?? id;
}

function isChoice(value: string): value is ChoiceId {
  return CHOICES.some((c) => c.id === value);
}

/** 按下哪一个：没设过按下三段；认得出且就是这三档之一才按下；别的百分比、认不出的都不按下。 */
function selectedChoice(reading: FlowModeReading): ChoiceId | undefined {
  if (reading.state === 'unrecognized') return undefined;
  if (reading.state === 'never_set') return 'three';
  const formatted = formatFlowModeSetting(reading.setting);
  return isChoice(formatted) ? formatted : undefined;
}

export function FlowModePicker() {
  const remote = useSelectedNodeId() !== null;
  const settings = useSettings();
  const update = useUpdateSetting();
  const row = settings.data?.settings.find((s) => s.key === FLOW_MODE_SETTING);
  const reading = settings.data ? readFlowModeSetting(row?.value) : null;
  const choice = reading && !remote ? selectedChoice(reading) : undefined;
  const blocked = remote || reading === null;
  const [ask, setAsk] = useState<ChoiceId | null>(null);
  const [reason, setReason] = useState('');
  const why = reason.trim();

  let text = '正在读流程模式';
  if (remote) text = '这是别的环境的快照，派单方式改不了';
  else if (settings.isError) text = `当前值没查成：${errorText(settings.error)}`;
  else if (reading) text = flowModeSwitchText(reading);

  const pick = (id: ChoiceId) => {
    if (blocked || update.isPending || id === choice) return;
    setReason('');
    setAsk(id);
  };

  const confirm = async () => {
    if (!ask || why === '') throw new Error('先写一句原因');
    try {
      await update.mutateAsync({
        key: FLOW_MODE_SETTING,
        body: { value: ask, version: row?.version ?? 0, reason: why },
      });
      setReason('');
      toast.success(`已改成${choiceLabel(ask)}。之后新派的单按这个走`);
    } catch (e) {
      const message = errorText(e);
      toast.error('没改成', { description: message });
      throw e instanceof Error ? e : new Error(message);
    }
  };

  const askLabel = ask ? choiceLabel(ask) : '';

  return (
    <FormItem
      label="派单方式"
      help={
        <>
          只影响之后新派的单，已分组的单不变。改要写原因。{' '}
          <span data-flow-mode-current>
            <Text size="meta" tone="muted">
              {text}
            </Text>
          </span>
        </>
      }
    >
      <div data-flow-mode-switch>
        <fieldset disabled={blocked}>
          <FilterTabs
            mode="toggle"
            variant="segmented"
            aria-label="派单方式"
            items={CHOICES}
            value={choice}
            onChange={pick}
          />
        </fieldset>
      </div>
      <ConfirmDialog
        open={ask !== null}
        onOpenChange={(open) => {
          if (open || update.isPending) return;
          setAsk(null);
          setReason('');
        }}
        title={`把派单方式改成「${askLabel}」？`}
        description={`${ask ? DETAIL[ask] : ''}已经分过组的单、正在跑的保持原来的模式。`}
        confirmText={`确认改成${askLabel}`}
        {...(why === '' ? { confirmDisabled: true } : {})}
        onConfirm={confirm}
      >
        <FormItem label="原因" required layout="vertical" htmlFor="flow-mode-reason" help="会记进操作记录。">
          <TextArea
            id="flow-mode-reason"
            value={reason}
            onChange={setReason}
            maxLength={500}
            placeholder="写一句为什么改"
          />
        </FormItem>
      </ConfirmDialog>
    </FormItem>
  );
}
