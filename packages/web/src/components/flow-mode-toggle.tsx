// 驾驶舱上的「全程 / 三步法」全局开关（engine.flowMode）。
// 没设过显示三步法，不自己写入。点了先确认，只改之后新派的单：分组记录写一次不覆盖，正在跑的保持原来的模式。
// 对半分、认不出的值两个按钮都不按下，免得看成已经选了三步法或全程。看远程环境的快照时不能改这台的开关。
import {
  FLOW_MODE_SETTING,
  flowModeSwitchChoice,
  flowModeSwitchText,
  readFlowModeSetting,
} from '@fleet-dao/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { errorText, useSettings, useUpdateSetting } from '../api/client';
import { useSelectedNodeId } from '../lib/node';
import { FilterTabs } from './layout/filter-tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';

const CHOICES = [
  { id: 'three', label: '三步法' },
  { id: 'full', label: '全程' },
] as const;

type ChoiceId = (typeof CHOICES)[number]['id'];

const DETAIL: Record<ChoiceId, string> = {
  three: '之后新派的单都走三步法。已经在跑的、已经分过组的单保持原来的模式。',
  full: '之后新派的单都走全程。已经在跑的、已经分过组的单保持原来的模式。',
};

const REASON: Record<ChoiceId, string> = {
  three: '驾驶舱上切到三步法',
  full: '驾驶舱上切到全程',
};

function choiceLabel(id: ChoiceId): string {
  return CHOICES.find((c) => c.id === id)?.label ?? id;
}

export function FlowModeToggle() {
  const remote = useSelectedNodeId() !== null;
  const settings = useSettings();
  const update = useUpdateSetting();
  const row = settings.data?.settings.find((s) => s.key === FLOW_MODE_SETTING);
  const reading = settings.data ? readFlowModeSetting(row?.value) : null;
  const choice = reading && !remote ? flowModeSwitchChoice(reading) : undefined;
  const blocked = remote || reading === null;
  const [ask, setAsk] = useState<ChoiceId | null>(null);

  let text = '正在读流程模式';
  if (remote) text = '这是别的环境的快照，流程开关改不了';
  else if (settings.isError) text = `流程模式没读成：${errorText(settings.error)}`;
  else if (reading) text = flowModeSwitchText(reading);

  const pick = (id: ChoiceId) => {
    if (blocked || update.isPending || id === choice) return;
    setAsk(id);
  };

  const confirm = async () => {
    if (!ask) throw new Error('先选全程或三步法');
    try {
      await update.mutateAsync({
        key: FLOW_MODE_SETTING,
        body: { value: ask, version: row?.version ?? 0, reason: REASON[ask] },
      });
      setAsk(null);
      toast.success(`已改成${choiceLabel(ask)}。之后新派的单按这个走`);
    } catch (e) {
      const message = errorText(e);
      toast.error('没改成', { description: message });
      throw e instanceof Error ? e : new Error(message);
    }
  };

  const askLabel = ask ? choiceLabel(ask) : '';

  return (
    <div
      data-flow-mode-switch
      title="只改之后新派的单，正在跑的、已经分过组的不变"
      className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-lg border bg-popover p-1 shadow-overlay"
    >
      <span data-flow-mode-current className="px-2 text-meta text-muted-foreground">
        {text}
      </span>
      <fieldset disabled={blocked} className="m-0 min-w-0 border-0 p-0">
        <FilterTabs mode="toggle" aria-label="全程或三步法" items={CHOICES} value={choice} onChange={pick} />
      </fieldset>
      <AlertDialog
        open={ask !== null}
        onOpenChange={(open) => {
          if (open || update.isPending) return;
          setAsk(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>改成「{askLabel}」？</AlertDialogTitle>
            <AlertDialogDescription>{ask ? DETAIL[ask] : ''}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不</AlertDialogCancel>
            <AlertDialogAction onConfirm={confirm}>确认改成{askLabel}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
