// 本机装法的三块页面（#3858）：待我、宿主、设置。宿主页可以登记 SSH 宿主（#3928）。
import { useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import { Chip } from '../components/chip';
import { LoginPrompt } from '../components/login-prompt';
import { PageBar } from '../components/shell';
import { adeGet, adeSend } from '../lib/ade';
import { formatRelative, shortId } from '../lib/format';
import { useSessions } from '../lib/hooks';
import { LEVEL_LABEL, useLocalStatus } from '../lib/local-status';
import { deriveWorkerState } from '../lib/session-state';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { AccountsPanel } from './accounts-page';

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface">
      <h2 className="border-b border-line px-4 py-3 text-sm font-medium">{title}</h2>
      <div className="p-4 text-sm text-ink-2">{children}</div>
    </section>
  );
}

/** 待我：卡住的排最前，其次是做完还没看的；待拍板、待验收等验收闸接进来再出。 */
export function InboxPage() {
  const { sessions, unauthorized, error } = useSessions();
  const now = Date.now();
  const rows = (sessions ?? [])
    .map((s) => ({ s, state: deriveWorkerState(s.tail ?? [], now) }))
    .filter((r) => r.state === 'stuck' || r.state === 'done')
    .sort((a, b) => (a.state === b.state ? b.s.lastEventId - a.s.lastEventId : a.state === 'stuck' ? -1 : 1))
    .slice(0, 50);
  return (
    <>
      <PageBar title="待我" />
      <div className="flex flex-col gap-3 p-3 md:p-6">
        {unauthorized ? <LoginPrompt /> : null}
        {error && !unauthorized ? (
          <p role="alert" className="text-sm text-warning">
            读不到会话（{error}）。
          </p>
        ) : null}
        {!unauthorized && sessions && rows.length === 0 ? (
          <Card title="没有要你处理的事">
            <p>卡住的会话和做完的会话会出现在这里。待拍板、待验收等验收闸接进来后也排在这里。</p>
          </Card>
        ) : null}
        {rows.length > 0 ? (
          <ul aria-label="待我列表" className="overflow-hidden rounded-lg border border-line bg-surface">
            {rows.map(({ s, state }) => (
              <li key={s.id} data-state={state} className="border-b border-line last:border-b-0">
                <NavLink
                  to={`/s/${encodeURIComponent(s.id)}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-subtle"
                >
                  <Chip tone={state === 'stuck' ? 'danger' : 'neutral'}>
                    {state === 'stuck' ? '卡住' : '做完没看'}
                  </Chip>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={s.id}>
                    {shortId(s.id, 28)}
                  </span>
                  <span className="num text-2xs text-muted">{formatRelative(s.lastAt, now)}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </>
  );
}

interface SshHostRow {
  alias: string;
  target: string;
  keyPath: string;
}

/** 登记远端宿主：别名、ssh 目标、密钥路径。没有端口转发。 */
function SshHostForm() {
  const [hosts, setHosts] = useState<SshHostRow[]>([]);
  const [alias, setAlias] = useState('');
  const [target, setTarget] = useState('');
  const [keyPath, setKeyPath] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let dead = false;
    adeGet<{ hosts: SshHostRow[] }>('/ssh-hosts')
      .then((r) => {
        if (!dead) setHosts(r.hosts);
      })
      .catch((err: unknown) => {
        if (!dead) setMsg(err instanceof Error ? err.message : '读不到宿主');
      });
    return () => {
      dead = true;
    };
  }, []);
  const add = async () => {
    setBusy(true);
    setMsg('');
    try {
      const res = await adeSend<{ hosts: SshHostRow[] }>('/ssh-hosts', 'POST', { alias, target, keyPath });
      setHosts(res.hosts);
      setAlias('');
      setTarget('');
      setKeyPath('');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '没加上');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="SSH 宿主">
      <form
        className="flex flex-col gap-2"
        aria-label="添加 SSH 宿主"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label htmlFor="ssh-alias" className="flex flex-col gap-1">
          <span className="text-ink">别名</span>
          <Input
            id="ssh-alias"
            data-testid="ssh-alias"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder="例如 desk"
            autoComplete="off"
          />
        </label>
        <label htmlFor="ssh-target" className="flex flex-col gap-1">
          <span className="text-ink">SSH 目标</span>
          <Input
            id="ssh-target"
            data-testid="ssh-target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="user@host"
            autoComplete="off"
          />
        </label>
        <label htmlFor="ssh-key" className="flex flex-col gap-1">
          <span className="text-ink">密钥路径</span>
          <Input
            id="ssh-key"
            data-testid="ssh-key"
            value={keyPath}
            onChange={(e) => setKeyPath(e.target.value)}
            placeholder="私钥文件的路径，不填正文"
            autoComplete="off"
          />
        </label>
        <div>
          <Button data-testid="ssh-add" type="submit" disabled={busy || !alias || !target || !keyPath}>
            添加
          </Button>
        </div>
        {msg ? (
          <p role="alert" className="text-warning">
            {msg}
          </p>
        ) : null}
      </form>
      {hosts.length === 0 ? <p className="mt-3">还没有登记远端宿主。</p> : null}
      {hosts.length > 0 ? (
        <ul aria-label="已登记的 SSH 宿主" className="mt-3 flex flex-col gap-2">
          {hosts.map((h) => (
            <li key={h.alias} data-host={h.alias} className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium text-ink">{h.alias}</span>
              <span className="font-mono text-2xs">{h.target}</span>
              <span className="font-mono text-2xs text-muted">{h.keyPath}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

export function HostsPage() {
  const { status, error, unauthorized } = useLocalStatus();
  return (
    <>
      <PageBar title="宿主" />
      <div className="flex flex-col gap-3 p-3 md:p-6">
        {unauthorized ? <LoginPrompt /> : null}
        <SshHostForm />
        {error ? (
          <p role="alert" className="text-sm text-warning">
            读不到本机状态（{error}）。
          </p>
        ) : null}
        {status ? (
          <>
            <Card title="工人在哪跑">
              <ul aria-label="宿主列表" className="flex flex-col gap-2">
                {status.hosts.map((h) => (
                  <li key={h.id} className="flex items-center gap-3" data-host={h.id}>
                    <span className="font-medium text-ink">{h.label}</span>
                    <Chip>{h.kind === 'local' ? '本机' : 'SSH'}</Chip>
                    <span className="text-2xs text-muted">隔离档位</span>
                    <Chip tone={h.isolation === 'weak' ? 'warning' : 'neutral'} className="isolation-level">
                      {LEVEL_LABEL[h.isolation]}
                    </Chip>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="隔离档位怎么读出来的">
              <ul className="list-disc pl-5">
                {status.isolation.facts.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </Card>
            <Card title="对外写">
              <p>
                GitHub 写：{status.externalWrites.github ? '开' : '无'}；出网关口：
                {status.externalWrites.egressGateway ? '有' : '无'}。本机进程里没有任何推送凭据。
              </p>
            </Card>
          </>
        ) : null}
      </div>
    </>
  );
}

export function LocalSettingsPage() {
  const { status, error, unauthorized } = useLocalStatus();
  return (
    <>
      <PageBar title="设置" />
      <div className="flex flex-col gap-3 p-3 md:p-6">
        <AccountsPanel />
        {unauthorized ? <LoginPrompt /> : null}
        {error ? (
          <p role="alert" className="text-sm text-warning">
            读不到本机状态（{error}）。
          </p>
        ) : null}
        {status ? (
          <Card title="当前配置（只读，改要重启后生效）">
            <table className="w-full text-left text-xs">
              <tbody>
                {status.settings.map((r) => (
                  <tr key={r.key} className="border-b border-line last:border-b-0" data-setting={r.key}>
                    <th className="w-56 py-2 pr-3 align-top font-mono font-normal text-ink">{r.key}</th>
                    <td className="py-2 pr-3 align-top font-mono break-all">{r.value}</td>
                    <td className="py-2 align-top text-muted">{r.note}</td>
                  </tr>
                ))}
                <tr className="border-b border-line">
                  <th className="py-2 pr-3 align-top font-normal text-ink">监听</th>
                  <td className="py-2 pr-3 align-top font-mono">{status.listen}</td>
                  <td className="py-2 align-top text-muted">只听回环地址</td>
                </tr>
              </tbody>
            </table>
          </Card>
        ) : null}
      </div>
    </>
  );
}
