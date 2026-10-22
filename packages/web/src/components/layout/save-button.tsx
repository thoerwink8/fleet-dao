// 保存按钮：能存时是主按钮（品牌实色），不能存（没改动、正在存、校验没过）时是 Arco 的禁用样子（fill-1 底、ink-3 字）；
// 正在存再加转圈（#2009）。设置页每一项都用它，一眼分得清「现在能点」和「没东西可存」；旧的整块深灰半透明像一个能点的按钮（#1904）。
// variant="secondary"（#3533）：一页里好几个保存键并列时（设置页），能存时也是灰底次按钮，不和页面的主操作抢；能不能点靠 disabled 和 data-state 分。
import type { ReactNode } from 'react';
import { Button } from '../ui/button';

export function SaveButton({
  canSave,
  pending = false,
  variant = 'primary',
  children = '保存',
}: {
  /** 有改动、也过了校验。 */
  canSave: boolean;
  /** 正在存：按钮转圈、不可点（aria-busy，焦点留着，#2009），底色和「没东西可存」一样灰。 */
  pending?: boolean;
  /** primary（默认）：能存时品牌实色；secondary：一直是灰底次按钮。 */
  variant?: 'primary' | 'secondary';
  children?: ReactNode;
}) {
  const enabled = canSave && !pending;
  return (
    <Button
      type="submit"
      size="sm"
      variant={enabled && variant === 'primary' ? 'primary' : 'secondary'}
      loading={pending}
      disabled={!enabled}
      data-state={enabled ? 'ready' : 'disabled'}
      // bg-muted、text-muted-foreground 是 fill-1、ink-3 的旧名（app.css 别名）：忙时（aria-busy）按钮不走禁用样子，这里再钉一次
      className={enabled ? undefined : 'bg-muted text-muted-foreground'}
    >
      {children}
    </Button>
  );
}
