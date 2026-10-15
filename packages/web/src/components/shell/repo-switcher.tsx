// 顶栏「当前项目」切换器（#1989 后补，#1998）：常驻「现在看的是哪个仓」，点开列出所有接进来的仓，
// 每个带在跑 / 卡住的计数；点一下切过去（记在浏览器本地，下次打开还是它）。
//
// 为什么加回来：顶栏这里 #1065 之前本来就是「切换仓」，当时只有一个仓、被「环境切换器」替掉了；
// 现在仓不止一个，切仓的需求回来了 —— 和「环境切换器」并排，两个都要（一个是哪台机器，一个是哪个仓）。
//
// 首屏不拉看板（first-screen.test 守着）：每个仓的在跑/卡住计数来自 useAllBoards（一个仓一份看板），
// 只在**下拉打开时**才挂载那一段去拉（Counts 单独成组件、放进 DropdownMenuContent 里），
// 下拉没打开就一份都不读。
//
// 下拉底部两行是常驻入口：加仓 / 管理项目跳到设置页「仓库」那一节（加仓要连本人的 GitHub 授权、
// 删仓要确认没挂着活，都是重操作，不在下拉里直接做）。
import { Check, ChevronsUpDown, FolderPlus, Settings2, TriangleAlert } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import { errorText, useAllBoards } from '../../api/client';
import { taskTone } from '../../lib/status';
import { StatusDot } from '../layout/status-badge';
import { useRepo } from '../repo-context';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

export function RepoSwitcher() {
  const { repo, repos, setRepoId, error: reposError } = useRepo();
  const navigate = useNavigate();
  const location = useLocation();
  const goManage = () => navigate('/settings#repos');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-10 min-w-0 shrink gap-1.5 px-2 text-body md:h-8"
          aria-label="切换项目"
        >
          <span className="num hidden text-muted-foreground lg:inline">{repo?.owner}/</span>
          {repo ? (
            <span className="num min-w-0 max-w-40 truncate font-semibold">{repo.name}</span>
          ) : reposError ? (
            <span className="text-ink-fail">仓列表没读成</span>
          ) : (
            <span className="num font-semibold">…</span>
          )}
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-meta text-muted-foreground">
          切换项目（看板按项目显示）
        </DropdownMenuLabel>
        {reposError ? (
          <DropdownMenuItem disabled className="text-meta text-ink-fail">
            仓列表没读成{repos.length ? '，下面是上次读到的' : ''}：{errorText(reposError)}
          </DropdownMenuItem>
        ) : null}
        {repos.length === 0 && !reposError ? (
          <DropdownMenuItem disabled className="text-meta text-muted-foreground">
            还没有接进来的项目
          </DropdownMenuItem>
        ) : null}
        {/* 列表放在这里：它一挂载才去拉每个仓的看板（拉到计数）。下拉没打开就不挂载、一份都不读。 */}
        <RepoList
          currentId={repo?.id}
          onPick={(id) => {
            setRepoId(id);
            // 人正在看板上切项目：留在这一页，画布和抽屉按新项目重画。别的页仍回主页。
            if (location.pathname !== '/board') navigate('/');
          }}
        />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={goManage}>
          <FolderPlus />从 GitHub 加仓
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={goManage}>
          <Settings2 />
          管理项目（加 / 移出）
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 仓列表加每个仓的在跑 / 卡住计数（这一段单开：只在被挂载时拉看板，也就是下拉打开的那一刻）。 */
function RepoList({ currentId, onPick }: { currentId: string | undefined; onPick(id: string): void }) {
  const { repos } = useRepo();
  const { boards, failed } = useAllBoards();
  const countFor = (repoId: string) => {
    const list = boards.find((b) => b.repo.id === repoId)?.tasks ?? [];
    return {
      run: list.filter((t) => taskTone(t) === 'run').length,
      stuck: list.filter((t) => ['stall', 'fail', 'human'].includes(taskTone(t))).length,
    };
  };
  return (
    <>
      {repos.map((r) => {
        const c = countFor(r.id);
        return (
          <DropdownMenuItem key={r.id} onSelect={() => onPick(r.id)}>
            <span className="num min-w-0 flex-1 truncate">
              <span className="text-muted-foreground">{r.owner}/</span>
              {r.name}
            </span>
            {failed.some((f) => f.id === r.id) ? (
              <span className="text-meta text-ink-fail">没读成</span>
            ) : null}
            {c.run ? (
              <span className="num flex items-center gap-1 text-meta text-muted-foreground">
                <StatusDot tone="run" className="size-1.5" />
                {c.run}
              </span>
            ) : null}
            {c.stuck ? (
              <span className="num flex items-center gap-1 text-meta text-ink-stall">
                <TriangleAlert className="size-3" />
                {c.stuck}
              </span>
            ) : null}
            {r.id === currentId ? <Check className="size-4" /> : null}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
