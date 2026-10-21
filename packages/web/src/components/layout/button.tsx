// 按钮（包 ui/button，#3509 方案第三节第 2 条的 Button；页面只能从这里拿按钮，不直接引 ui/button、不写 <button>）。
// 样子照 canvas/fd3.css `.btn`：primary 品牌实色（一页最多一个，列表行里不许有）、secondary 灰底（最常用）、outline 品牌描边、
// text 品牌色字（卡头的「全部通知」这类链接、「重试」）、danger 红。尺寸 xs 24、sm 28、md 32，手机上至少 40 高。
// 给 href 就是链接（站内走路由，external 开新窗口）；给 disabledReason 就置灰并把原因放在悬停里，点不动（远程快照只读用）。
// 会发写请求的按钮传 loading（规范「会发写请求的按钮」）。不收 className 和 style。
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Button as BaseButton } from '../ui/button';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'text' | 'danger';
export type ButtonSize = 'xs' | 'sm' | 'md';

export function Button({
  variant = 'secondary',
  size = 'md',
  href,
  external,
  loading,
  disabledReason,
  onClick,
  title,
  type = 'button',
  children,
  ...aria
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 整个按钮是链接：站内路径走路由，external 时开新窗口。 */
  href?: string | undefined;
  external?: boolean | undefined;
  /** 正在发写请求：转圈、点不动。 */
  loading?: boolean | undefined;
  /** 现在点不了的原因：给了就置灰、悬停写这句话，点击不触发。 */
  disabledReason?: string | undefined;
  onClick?: (() => unknown) | undefined;
  title?: string | undefined;
  type?: 'button' | 'submit';
  children?: ReactNode;
  'aria-label'?: string;
}) {
  const blocked = disabledReason !== undefined;
  const hover = blocked ? disabledReason : title;
  if (href !== undefined && !blocked) {
    return (
      <BaseButton asChild variant={variant} size={size}>
        {external ? (
          <a href={href} target="_blank" rel="noreferrer" {...(hover ? { title: hover } : {})} {...aria}>
            {children}
          </a>
        ) : (
          <Link to={href} {...(hover ? { title: hover } : {})} {...aria}>
            {children}
          </Link>
        )}
      </BaseButton>
    );
  }
  return (
    <BaseButton
      type={type}
      variant={variant}
      size={size}
      {...(hover ? { title: hover } : {})}
      {...(blocked ? { 'aria-disabled': true } : {})}
      {...(loading !== undefined && !blocked ? { loading } : {})}
      onClick={blocked ? (e) => e.preventDefault() : onClick ? () => onClick() : undefined}
      {...aria}
    >
      {children}
    </BaseButton>
  );
}
