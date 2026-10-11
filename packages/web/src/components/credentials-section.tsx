// 设置页「账密登录」一节：看现状、第一次设、改用户名和密码（#120 前端那一半，缺陷 D1）。
// 规矩全在后端（api/src/credentials.ts、password.ts），这里只照契约（shared/web-api/auth.ts）说人话：
// - 第一次设（还没设过密码）：要在飞书登录后 10 分钟内（canSetWithoutCurrent），同时给用户名和新密码，不用当前密码；
// - 已经设过：改什么都要带当前密码；改了密码，别处已登的会话全部作废，这一处不掉线；
// - 错误按 details.field 落在对应那一栏；锁了（429）、没资格（403）是整体错误。
// 密码的规则只提示后端明说的最低长度，不替人定别的（NIST SP 800-63B 3.1.1.2 / OWASP：不加字符类型要求）；密码不写日志、不进地址。
import { type FormEvent, useRef, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { brand } from '#brand';
import { useCredentials, useUpdateCredentials } from '../api/client';
import type { Credentials } from '../api/types';
import {
  type CredentialField,
  credentialFailure,
  PASSWORD_MAX,
  PASSWORD_MIN_LENGTH,
} from '../lib/credentials';
import { formatAgo } from '../lib/format';
import { useNow } from '../lib/hooks';
import { FieldRow } from './field-row';
import { LoadError, LoadingRows } from './page';
import { PasswordField } from './password-field';
import { Button } from './ui/button';
import { Input } from './ui/input';

/** 用户名栏的提示：就是后端 checkUsername 的规则，原话照抄，不另编。 */
const USERNAME_HINT = '3–32 位，字母或数字开头，可以用字母、数字、点、下划线、连字符；大小写不区分。';

type Errors = Partial<Record<CredentialField | 'confirm' | 'form', string>>;

/** 后端校验密码长度时先做 NFKC 规范化再按字符数（api/src/password.ts checkNewPassword）：这里同一个算法，只为少一次往返。 */
function passwordLength(p: string): number {
  return [...p.normalize('NFKC')].length;
}

function Status({ c }: { c: Credentials }) {
  const now = useNow();
  if (!c.hasPassword) {
    return <p className="text-sm text-muted-foreground">还没设过账密：现在只能用飞书登录。</p>;
  }
  return (
    <p className="text-sm">
      已设账密：用户名 <span className="num font-medium">{c.username ?? '（没有用户名）'}</span>
      {c.passwordChangedAt ? (
        <span className="text-muted-foreground">
          {' '}
          · 上次改密码 <span className="num">{formatAgo(c.passwordChangedAt, now)}</span>
        </span>
      ) : null}
    </p>
  );
}

function CredentialsForm({ c, setDone }: { c: Credentials; setDone: (text: string | null) => void }) {
  const update = useUpdateCredentials();
  const [username, setUsername] = useState(c.username ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const currentRef = useRef<HTMLInputElement>(null);

  const first = !c.hasPassword;
  // 第一次设要 10 分钟内飞书登录过：不满足就别让人白填一遍再被拒，先说清怎么办
  const blocked = first && !c.canSetWithoutCurrent;
  const name = username.trim();
  const usernameChanged = name !== (c.username ?? '');
  const wantsPassword = newPassword !== '';
  const nothingToChange = first ? false : !usernameChanged && !wantsPassword;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (update.isPending) return;
    const next: Errors = {};
    if (first && !name) next.username = '第一次设账密要同时设用户名。';
    if (first && !wantsPassword) next.newPassword = '请填新密码。';
    if (!first && !currentPassword) next.currentPassword = '改之前要输入当前密码。';
    if (wantsPassword && passwordLength(newPassword) < PASSWORD_MIN_LENGTH)
      next.newPassword = `密码至少 ${PASSWORD_MIN_LENGTH} 位。`;
    if (wantsPassword && confirm !== newPassword) next.confirm = '两次输入的新密码不一样。';
    if (!first && nothingToChange) next.form = '用户名和新密码都没有改动。';
    setDone(null);
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    try {
      await update.mutateAsync({
        ...(first || usernameChanged ? { username: name } : {}),
        ...(wantsPassword ? { newPassword } : {}),
        ...(first ? {} : { currentPassword }),
      });
    } catch (err) {
      const f = credentialFailure(err);
      setErrors({ [f.field ?? 'form']: f.message });
      // 当前密码输错：清掉重输，光标回到那一栏（后端也把这次计入输错次数，5 次会锁）
      if (f.field === 'currentPassword') {
        setCurrentPassword('');
        currentRef.current?.focus();
      }
      return;
    }
    toast.success(first ? '已设账密' : '已保存账密');
    setCurrentPassword('');
    setNewPassword('');
    setConfirm('');
    if (wantsPassword) {
      setDone(
        `密码已${first ? '设好' : '改好'}。这个浏览器的登录还在；这个账号在别处（其他浏览器、手机）的登录都已作废，要重新登录（用飞书或账密都行）。`,
      );
    } else {
      setDone(`用户名已改成 ${name}，下次登录用新的；密码没动，别处的登录也还在。`);
    }
  };

  const busy = update.isPending;
  return (
    <form onSubmit={submit} method="post" className="mt-3" aria-label={first ? '设账密' : '改账密'}>
      {/* 密码管理器 / 无障碍：密码表单要有 autocomplete=username 的用户名字段；看得见的那一栏另写，这里藏一份兜底。 */}
      <input
        type="text"
        name="username"
        autoComplete="username"
        value={name || (c.username ?? '')}
        readOnly
        hidden
        tabIndex={-1}
        aria-hidden
      />
      {blocked ? (
        <p role="status" className="mb-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          第一次设账密要在飞书登录后 10 分钟内设：请先退出，用飞书重新登录一次，再回到这里。
        </p>
      ) : null}
      {first ? null : (
        <PasswordField
          id="cred-current"
          label="当前密码"
          value={currentPassword}
          onChange={setCurrentPassword}
          autoComplete="current-password"
          maxLength={PASSWORD_MAX}
          error={errors.currentPassword}
          readOnly={busy}
          inputRef={currentRef}
          hint="改用户名或密码都要先输入当前密码；输错 5 次会被临时锁住。"
          layout="row"
        />
      )}
      <FieldRow
        label={first ? '用户名' : '用户名（不改就别动）'}
        htmlFor="cred-username"
        hint={USERNAME_HINT}
        hintId="cred-username-hint"
        error={errors.username}
        errorId="cred-username-error"
      >
        <Input
          id="cred-username"
          name="username-visible"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={200}
          readOnly={busy}
          aria-invalid={errors.username ? true : undefined}
          aria-describedby={`cred-username-hint${errors.username ? ' cred-username-error' : ''}`}
          className="max-w-sm"
        />
      </FieldRow>
      <PasswordField
        id="cred-new"
        label={first ? '密码' : '新密码（不改就留空）'}
        value={newPassword}
        onChange={setNewPassword}
        autoComplete="new-password"
        maxLength={PASSWORD_MAX}
        error={errors.newPassword}
        readOnly={busy}
        hint={`至少 ${PASSWORD_MIN_LENGTH} 位，别的不限：长一点的一句话、密码管理器生成的都可以。`}
        layout="row"
      />
      <PasswordField
        id="cred-confirm"
        label="再输一遍新密码"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
        maxLength={PASSWORD_MAX}
        error={errors.confirm}
        readOnly={busy}
        layout="row"
      />
      {errors.form ? (
        <p role="alert" className="mt-2 rounded-lg bg-st-fail/10 px-3 py-2 text-sm text-ink-fail">
          {errors.form}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 pt-3">
        <Button type="submit" size="sm" disabled={busy || blocked}>
          {busy ? '保存中…' : first ? '设账密' : '保存修改'}
        </Button>
        <span className="text-xs text-muted-foreground">
          改动会记进
          <Link
            to="/audit"
            className="underline underline-offset-2 max-md:inline-flex max-md:min-h-10 max-md:items-center"
          >
            操作记录
          </Link>
          （只记改了什么，不记密码）。
        </span>
      </div>
    </form>
  );
}

export function CredentialsSection() {
  const creds = useCredentials();
  // 「做完了」的说明放在表单外面：设成功后表单会换成「改」的样子（下面的 key），说明不能跟着丢
  const [done, setDone] = useState<string | null>(null);
  if (creds.error)
    return <LoadError what="账密状态" error={creds.error} onRetry={() => void creds.refetch()} />;
  if (!creds.data) return <LoadingRows rows={2} />;
  // key 随服务端状态变：设成功后（没有密码 → 有密码）整张表单换成「改」的样子，旧的输入不残留
  const c = creds.data;
  return (
    <div>
      <Status c={c} />
      <p className="mt-1 text-xs text-muted-foreground">
        {`用用户名和密码登录${brand.product}，和飞书登录并列；随时可以改。`}
      </p>
      {done ? (
        <p role="status" className="mt-3 max-w-md rounded-lg bg-muted px-3 py-2 text-sm">
          {done}
        </p>
      ) : null}
      <CredentialsForm key={`${c.hasPassword}:${c.username ?? ''}`} c={c} setDone={setDone} />
    </div>
  );
}
