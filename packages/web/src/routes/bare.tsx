// 不带外壳的页（#3277）：没有侧栏、顶栏、底部导航，给弹出到新窗口的会话用。登录确认、推送更新和外壳里那一份一样。
import { Outlet } from 'react-router';
import { useLiveSync, useMe } from '../api/client';
import { RepoProvider } from '../components/repo-context';
import { AuthGate } from './shell';

function Frame() {
  // 推送等确认登录之后再连（和外壳一样）：在跑的那一笔、这张单的笔照样自己更新
  const { data: me } = useMe();
  useLiveSync(Boolean(me));
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <Outlet />
    </div>
  );
}

export default function Bare() {
  return (
    <AuthGate>
      <RepoProvider>
        <Frame />
      </RepoProvider>
    </AuthGate>
  );
}
