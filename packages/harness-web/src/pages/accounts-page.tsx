// 设置里的模型与账号（#3925）。控件来自 src/ui，颜色只用令牌。
import { useCallback, useEffect, useState } from 'react';
import {
  type AccountsView,
  createAccount,
  createRelay,
  deleteAccount,
  deleteRelay,
  loadAccountsView,
  loadQuota,
  quotaText,
  saveActive,
  saveSelection,
  TIERS,
} from '../lib/accounts';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog, DialogContent } from '../ui/dialog';
import { Input } from '../ui/input';

export function AccountsPanel() {
  const [view, setView] = useState<AccountsView | null>(null);
  const [quota, setQuota] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [relayOpen, setRelayOpen] = useState(false);
  const [accountFor, setAccountFor] = useState<string | null>(null);

  const reload = useCallback(() => {
    let dead = false;
    loadAccountsView()
      .then((next) => {
        if (!dead) setView(next);
      })
      .catch((err: unknown) => {
        if (!dead) setError(err instanceof Error ? err.message : '读不到账号');
      });
    loadQuota()
      .then((next) => {
        if (!dead) setQuota(next);
      })
      .catch(() => {
        if (!dead) setQuota({});
      });
    return () => {
      dead = true;
    };
  }, []);

  useEffect(() => reload(), [reload]);

  const run = async (fn: () => Promise<AccountsView>): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      setView(await fn());
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : '没写上');
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!view) {
    return (
      <section className="flex flex-col gap-2" data-testid="accounts-panel">
        <h2 className="text-sm font-medium text-ink">模型与账号</h2>
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : (
          <p className="text-xs text-muted">正在读本机账号…</p>
        )}
      </section>
    );
  }

  return (
    <section className="flex min-w-0 flex-col gap-3" data-testid="accounts-panel">
      <header>
        <h2 className="text-sm font-medium text-ink">模型与账号</h2>
        <p className="mt-1 text-2xs text-muted">密钥只留在本机。额度读不到就写读不到。</p>
      </header>
      <fieldset className="flex min-w-0 flex-wrap gap-1 border-0 p-0" aria-label="当前 agent">
        {view.agents.map((a) => (
          <Button
            key={a.id}
            size="sm"
            variant={view.agent === a.id ? 'default' : 'outline'}
            aria-pressed={view.agent === a.id}
            disabled={busy}
            data-testid={`accounts-agent-${a.id}`}
            onClick={() => void run(() => saveSelection(a.id, view.tier))}
          >
            {a.id}
          </Button>
        ))}
      </fieldset>
      <fieldset className="flex min-w-0 flex-wrap gap-1 border-0 p-0" aria-label="档位">
        {TIERS.map((t) => (
          <Button
            key={t.id}
            size="sm"
            variant={view.tier === t.id ? 'default' : 'outline'}
            aria-pressed={view.tier === t.id}
            disabled={busy}
            data-testid={`accounts-tier-${t.id}`}
            onClick={() => void run(() => saveSelection(view.agent, t.id))}
          >
            {t.label}
          </Button>
        ))}
      </fieldset>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        {view.agents.map((a) => (
          <article
            key={a.id}
            data-testid={`account-card-${a.id}`}
            className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium text-ink">{a.id}</h3>
              <Badge tone={a.login === '已登录' ? 'success' : a.login === '未登录' ? 'neutral' : 'warning'}>
                {a.login}
              </Badge>
            </div>
            <p className="text-xs break-all text-ink-2">
              账号 <span className="text-ink">{a.account}</span>
            </p>
            <div className="flex min-w-0 flex-wrap gap-1">
              {a.models.length ? (
                a.models.map((m) => (
                  <Badge key={m} mono title={m}>
                    <span className="max-w-full break-all">{m}</span>
                  </Badge>
                ))
              ) : (
                <span className="text-2xs text-muted">没有型号</span>
              )}
            </div>
            {a.modelsNote ? <p className="text-2xs text-muted">{a.modelsNote}</p> : null}
            <p className="text-xs text-ink-2" data-testid={`quota-${a.id}`}>
              额度 {quotaText(quota[a.id])}
            </p>
            {a.saved.length ? (
              <div className="flex flex-col gap-1">
                {a.saved.map((s) => (
                  <div key={s.id} className="flex min-w-0 flex-wrap items-center gap-1">
                    <Button
                      size="sm"
                      variant={s.active ? 'default' : 'ghost'}
                      disabled={busy}
                      onClick={() => void run(() => saveActive(a.id, s.active ? null : s.id))}
                    >
                      <span className="max-w-40 truncate">{s.label}</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void run(() => deleteAccount(a.id, s.id))}
                    >
                      移除
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setAccountFor(a.id)}>
              添加账号
            </Button>
          </article>
        ))}
      </div>
      <section className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-ink">中转</h3>
          <Button
            size="sm"
            data-testid="accounts-add-relay"
            disabled={busy}
            onClick={() => setRelayOpen(true)}
          >
            添加中转
          </Button>
        </div>
        {view.relays.length ? (
          view.relays.map((r) => (
            <div key={r.id} className="flex min-w-0 flex-wrap items-center gap-2 border-t border-line pt-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-ink">{r.name}</p>
                <p className="text-2xs break-all text-muted">{r.baseUrl}</p>
                <p className="text-2xs break-all text-ink-2">{r.models.join('、')}</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void run(() => deleteRelay(r.id))}
              >
                删除
              </Button>
            </div>
          ))
        ) : (
          <p className="text-2xs text-muted">还没有中转。OpenAI 兼容的地址和密钥。</p>
        )}
      </section>
      <RelayDialog
        open={relayOpen}
        onOpenChange={setRelayOpen}
        busy={busy}
        onAdd={(input) => run(() => createRelay(input))}
      />
      <AccountDialog
        agent={accountFor}
        onOpenChange={(open) => {
          if (!open) setAccountFor(null);
        }}
        busy={busy}
        onAdd={(agent, label, envKey, envValue) => run(() => createAccount(agent, label, envKey, envValue))}
      />
    </section>
  );
}

function RelayDialog({
  open,
  onOpenChange,
  busy,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onAdd: (input: { name: string; baseUrl: string; key: string; models: string }) => Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [models, setModels] = useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="添加中转" description="OpenAI 兼容。密钥只写在本机数据目录。">
        <div className="flex flex-col gap-2">
          <Input value={name} placeholder="名字" onChange={(e) => setName(e.target.value)} />
          <Input
            data-testid="relay-base-url"
            value={baseUrl}
            placeholder="https://example.com/v1"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <Input
            data-testid="relay-key"
            type="password"
            value={key}
            placeholder="密钥"
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
          />
          <Input
            data-testid="relay-models"
            value={models}
            placeholder="模型名，逗号分开"
            onChange={(e) => setModels(e.target.value)}
          />
          <Button
            data-testid="relay-save"
            disabled={busy}
            onClick={() => {
              void onAdd({ name, baseUrl, key, models }).then((ok) => {
                if (!ok) return;
                setName('');
                setBaseUrl('');
                setKey('');
                setModels('');
                onOpenChange(false);
              });
            }}
          >
            保存
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AccountDialog({
  agent,
  onOpenChange,
  busy,
  onAdd,
}: {
  agent: string | null;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onAdd: (agent: string, label: string, envKey: string, envValue: string) => Promise<boolean>;
}) {
  const [label, setLabel] = useState('');
  const [envKey, setEnvKey] = useState('');
  const [envValue, setEnvValue] = useState('');
  return (
    <Dialog open={agent !== null} onOpenChange={onOpenChange}>
      <DialogContent title="添加账号" description="换号时把这个环境变量写进进程。值不进仓。">
        <div className="flex flex-col gap-2">
          <Input value={label} placeholder="名字" onChange={(e) => setLabel(e.target.value)} />
          <Input value={envKey} placeholder="环境变量名" onChange={(e) => setEnvKey(e.target.value)} />
          <Input
            type="password"
            value={envValue}
            placeholder="值"
            autoComplete="off"
            onChange={(e) => setEnvValue(e.target.value)}
          />
          <Button
            disabled={busy || !agent}
            onClick={() => {
              if (!agent) return;
              void onAdd(agent, label, envKey, envValue).then((ok) => {
                if (!ok) return;
                setLabel('');
                setEnvKey('');
                setEnvValue('');
                onOpenChange(false);
              });
            }}
          >
            保存
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
