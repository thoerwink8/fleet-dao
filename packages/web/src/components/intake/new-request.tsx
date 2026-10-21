// 提新需求（#2062）：先说一句就建好一条需求，然后在对话里接着聊。
// 电脑上能选项目（默认顶栏的当前项目）；手机上不选项目，用当前项目。
// 「接着这条提」（只在电脑上）：带着原来那条的号，新的一条挂在原条下面；原条必须已结案（后端判）。
import { ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { errorText, useCreateRequest, useRequestDetail } from '../../api/client';
import { LoadError } from '../layout/load-state';
import { NativeSelect } from '../layout/native-select';
import { Notice } from '../layout/notice';
import { useRepo } from '../repo-context';
import { Button } from '../ui/button';
import { Composer } from './request-composer';

export function NewRequest({
  phone,
  from,
  onBack,
  onCreated,
}: {
  phone: boolean;
  /** 接着哪一条提（需求号）；手机上不给。 */
  from: number | null;
  onBack: () => void;
  onCreated: (seq: number) => void;
}) {
  const { repo, repos, loading, error: reposError } = useRepo();
  const [repoId, setRepoId] = useState<string | null>(null);
  const create = useCreateRequest();
  const [error, setError] = useState<string | undefined>();
  const parent = useRequestDetail(from);
  const fromRepo = parent.data?.request.repo.id;
  const chosen = repoId ?? fromRepo ?? repo?.id ?? null;
  const chosenRepo = repos.find((r) => r.id === chosen);

  const onSend = async (text: string) => {
    setError(undefined);
    if (!chosen) {
      setError('还没选项目：只能给驾驶舱里已导入的项目提需求');
      return false;
    }
    try {
      const d = await create.mutateAsync({
        repoId: chosen,
        body: text,
        channel: phone ? 'mobile' : 'web',
        ...(from !== null ? { continuesSeq: from } : {}),
      });
      onCreated(d.request.seq);
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    }
  };

  const body = (
    <>
      <header className="flex items-center gap-2 border-b px-4 py-2" data-intake-head>
        {phone ? (
          <Button
            variant="ghost"
            className="-ml-3 size-11 shrink-0 px-0"
            onClick={onBack}
            aria-label="回到需求列表"
          >
            <ChevronLeft />
          </Button>
        ) : null}
        <h2 className="min-w-0 flex-1 truncate text-heading">
          {from !== null ? `接着 需求 ${from} 提` : '提新需求'}
        </h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" data-new-request>
        <div className="mx-auto flex max-w-chat flex-col gap-4 px-4 py-8">
          {from !== null ? (
            <Notice
              tone="info"
              title={parent.data ? `接着「${parent.data.request.title}」提` : `接着 需求 ${from} 提`}
            >
              原来那条已结案、内容不再改；新的这条会挂在它下面，单独聊、单独开单。
            </Notice>
          ) : null}
          <div>
            <p className="text-title">想做什么？</p>
            <p className="mt-1 text-body text-muted-foreground">
              先说一句，大白话就行。指挥官会接着问，把它聊成一张写全四节的单子。
            </p>
          </div>
          {reposError ? <LoadError error={reposError} what="项目列表" /> : null}
          {phone ? (
            <p className="text-meta text-muted-foreground" data-new-repo>
              项目{' '}
              <span className="font-mono">
                {chosenRepo ? `${chosenRepo.owner}/${chosenRepo.name}` : '还没有'}
              </span>
              （要换项目请在电脑上提）
            </p>
          ) : (
            <div className="flex items-center gap-2 text-meta text-muted-foreground" data-new-repo>
              <span aria-hidden>项目</span>
              <NativeSelect
                value={chosen ?? ''}
                onChange={(e) => setRepoId(e.target.value)}
                disabled={loading || from !== null}
                aria-label="项目"
                className="w-auto"
              >
                {repos.length === 0 ? (
                  <option value="">{loading ? '在读项目……' : '没有已导入的项目'}</option>
                ) : null}
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.owner}/{r.name}
                  </option>
                ))}
              </NativeSelect>
              {from !== null ? <span>（跟原来那条同一个项目）</span> : null}
            </div>
          )}
        </div>
      </div>
      <Composer
        people={[]}
        phone={phone}
        busy={create.isPending}
        error={error}
        placeholder="比如：任务列表能不能按仓筛？"
        onSend={onSend}
      />
    </>
  );

  return phone ? (
    <section className="fixed inset-0 z-40 flex min-h-0 flex-col bg-background" aria-label="提新需求">
      {body}
    </section>
  ) : (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label="提新需求">
      {body}
    </section>
  );
}
