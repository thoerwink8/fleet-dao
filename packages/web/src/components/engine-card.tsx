// 法国页的「引擎」卡（#1086 引擎总开关，设置 engine.master；#3509 起「派单方式」也在这里，样稿 canvas/France.dc.html）：
// 总开关一行（开关、现在开着还是关着、谁什么时候改的），派单方式一行（三段 / 对半分 / 全程，在 flow-mode-picker.tsx）。
// 总开关和顶栏的引擎状态（shell/engine-status.tsx）分在两个文件：这张卡只有法国页用，文案里有命令名；顶栏、设置页用的 engine-master.tsx 里不放命令名。
// 写走通用的 PUT /settings/engine.master（登录门、CSRF、版本冲突回 409、操作记录都在那条路上），带上改之前看到的版本，别人先改了回
// 409、确认框里写原因；选了远程环境、读不到：不给能点的开关，各写各的原因（本机 WSL 的开关只管那台自己的库，要去那台上用命令行）。
import { describeEngineMaster, ENGINE_MASTER_SETTING } from '@fleet-dao/shared';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { errorText, useSettings, useUpdateSetting } from '../api/client';
import type { EnvMaster } from '../api/types';
import { formatDateTime, localizeIsoTimes } from '../lib/format';
import { useMasterView } from './engine-master';
import { FlowModePicker } from './flow-mode-picker';
import { ConfirmDialog } from './layout/confirm-dialog';
import { Form, FormItem } from './layout/form';
import { Section } from './layout/section';
import { Stack } from './layout/stack';
import { Switch } from './layout/switch';
import { Text } from './layout/text';

/** 谁、什么时候改的（没设过、认不出就没有这一句）。 */
function changedBy(m: EnvMaster): string | null {
  if (m.by === undefined || m.at === undefined) return null;
  return `${formatDateTime(m.at)} 由 ${m.by.replace(/^user:/, '')} ${m.on ? '打开' : '关上'}`;
}

export function EngineCard({ standbyNote }: { standbyNote?: ReactNode }) {
  const { view, remote, nodeId } = useMasterView();
  const settings = useSettings();
  const update = useUpdateSetting();
  const [asking, setAsking] = useState(false);

  const row = settings.data?.settings.find((s) => s.key === ENGINE_MASTER_SETTING);
  const master = view.kind === 'ok' ? view.master : null;
  const target = master === null ? null : !master.on;
  const verb = target ? '开启' : '关闭';
  // 确认框等它：成功框关、弹成功；失败弹 toast 并抛给框——框留着写原因、能再点（#2009）
  const confirm = async () => {
    if (target === null) return;
    try {
      await update.mutateAsync({
        key: ENGINE_MASTER_SETTING,
        body: {
          value: target,
          version: row?.version ?? 0,
          reason: `法国页上点了${verb}引擎总开关`,
        },
      });
      toast.success(`已${verb}引擎总开关`);
    } catch (e) {
      toast.error(`没能${verb}`, { description: errorText(e) });
      throw e;
    }
  };

  const who = master === null ? null : changedBy(master);
  const note =
    view.kind === 'loading'
      ? '正在读…'
      : view.kind === 'error'
        ? `没读到：${view.reason}，先不显示开或关`
        : view.kind === 'absent'
          ? '这个环境的版本还不带引擎总开关（它升级后会有这一项）。'
          : master === null
            ? ''
            : who === null
              ? localizeIsoTimes(master.detail)
              : // 谁、什么时候改的已经在开关旁边（本地化时间）：这一句只说现在是什么状态，不再把同一件事和 ISO 时间写第二遍（#1903）
                describeEngineMaster(master.on ? { on: true } : { on: false, why: master.why });

  const state =
    master === null ? (view.kind === 'loading' ? '读取中' : '没读到') : master.on ? '开着' : '关着';

  return (
    <Section
      title="引擎"
      id="engine-master"
      data-testid="engine-master"
      data-engine-master={master === null ? view.kind : master.on ? 'on' : 'off'}
    >
      <Form>
        <FormItem
          label="总开关"
          help={
            <>
              <span data-testid="engine-master-note">{note}</span>
              {master !== null && remote ? (
                <span data-testid="engine-master-remote-note">
                  {' '}
                  这是远程环境的快照，只读。要开关请去那台上用 <Text mono>fleet-api engine on</Text> /{' '}
                  <Text mono>fleet-api engine off</Text>。
                </span>
              ) : null}
              {standbyNote ? <> {standbyNote}</> : null}
            </>
          }
        >
          <Stack direction="horizontal" gap="md" align="center" wrap>
            {master !== null ? (
              <Switch
                checked={master.on}
                aria-label="引擎总开关"
                onCheckedChange={() => setAsking(true)}
                disabled={remote || update.isPending || settings.isLoading}
              />
            ) : null}
            <span data-testid="engine-master-state">
              <Text strong tone={master === null ? 'muted' : 'default'}>
                {state}
              </Text>
            </span>
            {who ? (
              <span data-testid="engine-master-who">
                <Text size="meta" tone="muted">
                  {who}
                </Text>
              </span>
            ) : null}
            {remote && nodeId ? (
              <Text size="meta" tone="muted">
                {nodeId} 的快照
              </Text>
            ) : null}
          </Stack>
        </FormItem>
        <FlowModePicker />
      </Form>
      <ConfirmDialog
        open={asking && master !== null && !remote}
        onOpenChange={setAsking}
        title={`${verb}引擎总开关？`}
        description={
          target
            ? '开启后引擎开始运转：下一轮拉单就往「让 AI 接活」开着的项目派活、起 AI 会话（会花额度）。并记一条操作记录。'
            : '关闭后引擎全停：不再拉单、不派活、不起新的干活会话；已经在跑的会话做完这一步就停，不会被腰斩；探针和健康检查照跑。并记一条操作记录。'
        }
        confirmText={verb}
        onConfirm={confirm}
      />
    </Section>
  );
}
