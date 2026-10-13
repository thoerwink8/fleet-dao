// 设置页「提醒」一节里的 APP 状态（#2050）：能不能安装、系统通知权限、角标支不支持。三样都是现读，读不到就写「读不到」。
// 通知权限只在这里点「打开系统通知」才请求，页面加载和收到提醒时都不弹。
import { useEffect, useState } from 'react';
import { badgeSupported } from '../lib/pwa/badge';
import { useInstallState } from '../lib/pwa/hooks';
import { type InstallState, promptInstall } from '../lib/pwa/install';
import { type NotifyPermission, notifyPermission, requestNotifyPermission } from '../lib/pwa/notify';
import { FieldGroup, FieldRow } from './layout/field-row';
import { StatusBadge } from './layout/status-badge';
import type { LayoutTone } from './layout/tone';
import { Button } from './ui/button';

const INSTALL_VIEW: Record<InstallState, { tone: LayoutTone; label: string; hint: string }> = {
  installed: { tone: 'done', label: '已装成 APP', hint: '现在就在独立窗口里运行。' },
  available: { tone: 'done', label: '可以安装', hint: '装好后有独立窗口和图标，角标和系统通知也在那里用。' },
  unavailable: {
    tone: 'stop',
    label: '现在不能安装',
    hint: '浏览器没给出可安装的信号：已经装过（在浏览器页里打开）、不是 Chrome 或 Edge，或还没满足安装条件。',
  },
  unreadable: {
    tone: 'doubt',
    label: '读不到',
    hint: '这个浏览器没有 service worker（要 https 或 localhost 打开），读不到能不能装。',
  },
};

const PERMISSION_VIEW: Record<NotifyPermission, { tone: LayoutTone; label: string; hint: string }> = {
  granted: {
    tone: 'done',
    label: '已允许',
    hint: 'APP 开着、窗口不在前台时，新的「要你拍」和卡住报警会弹一条系统通知，点一下回对应页。',
  },
  default: {
    tone: 'stop',
    label: '还没打开',
    hint: '点「打开系统通知」，浏览器会问一次要不要允许。',
  },
  denied: {
    tone: 'fail',
    label: '已被拒绝',
    hint: '浏览器记着你拒绝过，网页没法再问。到浏览器的网站设置里把本站的通知改成允许。',
  },
  unsupported: { tone: 'doubt', label: '读不到', hint: '这个浏览器没有通知功能。' },
};

/** 通知权限：现读，并跟着浏览器里改权限（网站设置）更新。 */
function useNotifyPermission() {
  const [permission, setPermission] = useState<NotifyPermission>(() => notifyPermission());
  useEffect(() => {
    let status: PermissionStatus | undefined;
    let stopped = false;
    const sync = () => setPermission(notifyPermission());
    navigator.permissions
      ?.query({ name: 'notifications' })
      .then((s) => {
        if (stopped) return;
        status = s;
        s.addEventListener('change', sync);
      })
      .catch(() => {});
    return () => {
      stopped = true;
      status?.removeEventListener('change', sync);
    };
  }, []);
  return [permission, setPermission] as const;
}

export function PwaStatus() {
  const install = useInstallState();
  const [permission, setPermission] = useNotifyPermission();
  const [asking, setAsking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const badge = badgeSupported();
  const installView = INSTALL_VIEW[install];
  const permissionView = PERMISSION_VIEW[permission];

  return (
    <FieldGroup aria-label="APP 状态" data-pwa-status>
      <FieldRow label="安装" hint={installView.hint}>
        <StatusBadge tone={installView.tone} label={installView.label} />
        {install === 'available' ? (
          <Button
            size="sm"
            variant="outline"
            loading={installing}
            onClick={async () => {
              setInstalling(true);
              try {
                await promptInstall();
              } finally {
                setInstalling(false);
              }
            }}
          >
            安装
          </Button>
        ) : null}
      </FieldRow>
      <FieldRow label="系统通知" hint={permissionView.hint}>
        <StatusBadge tone={permissionView.tone} label={permissionView.label} />
        {permission === 'default' ? (
          <Button
            size="sm"
            loading={asking}
            onClick={async () => {
              setAsking(true);
              try {
                setPermission(await requestNotifyPermission());
              } finally {
                setAsking(false);
              }
            }}
          >
            打开系统通知
          </Button>
        ) : null}
      </FieldRow>
      <FieldRow
        label="图标角标"
        hint={
          badge
            ? '待处理的件数显示在应用图标上，只在装好的 APP 里看得见。'
            : '这个浏览器没有角标功能（Chrome、Edge 81 以上才有）。'
        }
      >
        <StatusBadge tone={badge ? 'done' : 'stop'} label={badge ? '支持' : '不支持'} />
      </FieldRow>
    </FieldGroup>
  );
}
