// 保存按钮：能存时是品牌实色，不能存（没改动、正在存、校验没过）时是灰底灰字的禁用样子；正在存再加转圈（#2009）。
// 设置页每一项都用它，一眼分得清「现在能点」和「没东西可存」；旧的整块深灰半透明像一个能点的按钮（#1904）。
import type { ReactNode } from 'react';
import { Button } from '../ui/button';

export function SaveButton({
  canSave,
  pending = false,
  children = '保存',
}: {
  /** 有改动、也过了校验。 */
  canSave: boolean;
  /** 正在存：按钮转圈、不可点（aria-busy，焦点留着，#2009），底色和「没东西可存」一样灰。 */
  pending?: boolean;
  children?: ReactNode;
}) {
  const enabled = canSave && !pending;
  return (
    <Button
      type="submit"
      size="sm"
      variant={enabled ? 'brand' : 'outline'}
      loading={pending}
      disabled={!enabled}
      data-state={enabled ? 'ready' : 'disabled'}
      className={enabled ? undefined : 'bg-muted text-muted-foreground shadow-none'}
    >
      {children}
    </Button>
  );
}
