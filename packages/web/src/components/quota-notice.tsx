// 额度页顶上只留的一条提醒：切号现状和拼车额度对账合在一起（原来是两条横幅各占一块）。
import type { CarpoolReconcileView, OrgSwitchView } from '../api/types';
import { carpoolReconcileSummary } from './carpool-reconcile';
import { Button } from './layout/button';
import { Notice, type NoticeTone } from './layout/notice';
import { Stack } from './layout/stack';
import { Text } from './layout/text';
import { orgSwitchSummary } from './org-switch';

const RANK: NoticeTone[] = ['info', 'stall', 'fail'];

/** 两个来源各自的语气合成一个：取最重的。muted、ok 都是「没事」，画成 info。 */
function worst(
  a: 'muted' | 'ok' | 'stall' | 'fail',
  b: 'muted' | 'ok' | 'stall' | 'fail' | undefined,
): NoticeTone {
  const asNotice = (t: typeof a): NoticeTone => (t === 'stall' || t === 'fail' ? t : 'info');
  const x = asNotice(a);
  const y = b ? asNotice(b) : 'info';
  return RANK.indexOf(x) >= RANK.indexOf(y) ? x : y;
}

export function QuotaNotice({
  orgSwitch,
  reconcile,
}: {
  orgSwitch: OrgSwitchView | undefined;
  reconcile: CarpoolReconcileView | undefined;
}) {
  const org = orgSwitch ? orgSwitchSummary(orgSwitch) : undefined;
  const rec = reconcile ? carpoolReconcileSummary(reconcile) : undefined;
  // 两项都没有 = 老后端，不画。
  if (!org && !rec) return null;
  const tone = worst(org?.tone ?? rec?.tone ?? 'muted', org && rec ? rec.tone : undefined);
  const title = org?.headline ?? rec?.headline;
  const lines = [
    ...(org?.details ?? []),
    ...(org && rec ? [rec.headline] : []),
    ...(rec?.detail ? [rec.detail] : []),
  ];
  return (
    <div data-testid="quota-notice">
      <Notice tone={tone} title={title}>
        {lines.length || org?.action ? (
          <Stack gap="sm">
            {lines.map((line) => (
              <Text key={line} size="meta" tone="secondary">
                {line}
              </Text>
            ))}
            {org?.action ? (
              <span>
                <Button variant="text" size="xs" href={org.action.to}>
                  {org.action.label}
                </Button>
              </span>
            ) : null}
          </Stack>
        ) : null}
      </Notice>
    </div>
  );
}
