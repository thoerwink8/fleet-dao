// 设置页「提醒」一节里的 APP 状态（#2050）：能不能安装、系统通知权限。都是现读，读不到就写「没读到」。
// 图标角标支不支持并进「安装」那一行的说明（样稿：角标不单占一行）。
// 通知权限只在这里点「打开系统通知」才请求，页面加载和收到提醒时都不弹。
import { useEffect, useState } from 'react';
import { badgeSupported } from '../lib/pwa/badge';
import { useInstallState } from '../lib/pwa/hooks';
import { type InstallState, promptInstall } from '../lib/pwa/install';
import { type NotifyPermission, notifyPermission, requestNotifyPermission } from '../lib/pwa/notify';
import type { StatusKey } from '../theme/status-dict';
import { Button } from './layout/button';
import { FieldGroup, FieldRow } from './layout/field-row';
import { StatusBadge } from './layout/status-badge';

const INSTALL_VIEW: Record<InstallState, { status: StatusKey; hint: string }> = {
  installed: { status: 'machine:pwa:installed', hint: '现在就在独立窗口里运行。' },
  available: {
    status: 'machine:pwa:available',
    hint: '装好后有独立窗口和图标，角标和系统通知也在那里用。',
  },
  unavailable: {
    status: 'machine:pwa:unavailable',
    hint: '浏览器没给出可安装的信号：已经装过（在浏览器页里打开）、不是 Chrome 或 Edge，或还没满足安装条件。',
  },
  unreadable: {
    status: 'machine:pwa:unreadable',
    hint: '这个浏览器没有 service worker（要 https 或 localhost 打开），读不到能不能装。',
  },
};

const PERMISSION_VIEW: Record<NotifyPermission, { status: StatusKey; hint: string }> = {
  granted: {
    status: 'machine:notify:granted',
    hint: 'APP 开着、窗口不在前台时，新的「要你拍」和卡住报警会弹一条系统通知，点一下回对应页。',
  },
  default: {
    status: 'machine:notify:default',
    hint: '点「打开系统通知」，浏览器会问一次要不要允许。',
  },
  denied: {
    status: 'machine:notify:denied',
    hint: '浏览器记着你拒绝过，网页没法再问。到浏览器的网站设置里把本站的通知改成允许。',
  },
  unsupported: { status: 'machine:notify:unsupported', hint: '这个浏览器没有通知功能。' },
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
  const badgeHint = badge
    ? '待处理的件数显示在应用图标上，只在装好的 APP 里看得见。'
    : '这个浏览器没有角标功能（Chrome、Edge 81 以上才有）。';

  return (
    <FieldGroup aria-label="APP 状态" data-pwa-status>
      <FieldRow label="安装" hint={`${installView.hint}${badgeHint}`}>
        <StatusBadge status={installView.status} variant="dot" />
        {install === 'available' ? (
          <Button
            size="sm"
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
        <StatusBadge status={permissionView.status} variant="dot" />
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
    </FieldGroup>
  );
}
