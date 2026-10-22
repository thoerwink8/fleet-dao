// 提新需求（#2062）：先说一句就建好一条需求，然后在对话里接着聊。
// 电脑上能选项目（默认顶栏的当前项目）；手机上不选项目，用当前项目。
// 「接着这条提」（只在电脑上）：带着原来那条的号，新的一条挂在原条下面；原条必须已结案（后端判）。
import { ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { errorText, useCreateRequest, useRequestDetail } from '../../api/client';
import { Button } from '../layout/button';
import { Form, FormItem } from '../layout/form';
import { LoadError } from '../layout/load-state';
import { NativeSelect } from '../layout/native-select';
import { Notice } from '../layout/notice';
import { Pane } from '../layout/pane';
import { Stack } from '../layout/stack';
import { Text } from '../layout/text';
import { Title } from '../layout/title';
import { useRepo } from '../repo-context';
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

  return (
    <Pane
      label="提新需求"
      size={phone ? 'screen' : 'fill'}
      column
      head={
        <Stack direction="horizontal" gap="sm" align="center" data-intake-head="">
          {phone ? (
            <Button iconOnly size="sm" aria-label="回到需求列表" onClick={onBack}>
              <ChevronLeft />
            </Button>
          ) : null}
          <Title truncate>{from !== null ? `接着 需求 ${from} 提` : '提新需求'}</Title>
        </Stack>
      }
      foot={
        <Composer
          people={[]}
          phone={phone}
          busy={create.isPending}
          error={error}
          placeholder="比如：任务列表能不能按仓筛？"
          onSend={onSend}
        />
      }
    >
      <div data-new-request>
        <Stack gap="lg">
          {from !== null ? (
            <Notice
              tone="info"
              title={parent.data ? `接着「${parent.data.request.title}」提` : `接着 需求 ${from} 提`}
            >
              原来那条已结案、内容不再改；新的这条会挂在它下面，单独聊、单独开单。
            </Notice>
          ) : null}
          <Stack gap="sm">
            <Title level={2}>想做什么？</Title>
            <Text tone="muted">先说一句，大白话就行。指挥官会接着问，把它聊成一张写全四节的单子。</Text>
          </Stack>
          {reposError ? <LoadError error={reposError} what="项目列表" /> : null}
          <div data-new-repo>
            {phone ? (
              <Text size="meta" tone="muted">
                项目{' '}
                <Text size="meta" tone="muted" mono>
                  {chosenRepo ? `${chosenRepo.owner}/${chosenRepo.name}` : '还没有'}
                </Text>
                （要换项目请在电脑上提）
              </Text>
            ) : (
              <Form>
                <FormItem
                  label="项目"
                  htmlFor="new-repo"
                  {...(from !== null ? { help: '跟原来那条同一个项目' } : {})}
                >
                  <NativeSelect
                    id="new-repo"
                    value={chosen ?? ''}
                    onChange={(e) => setRepoId(e.target.value)}
                    disabled={loading || from !== null}
                    aria-label="项目"
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
                </FormItem>
              </Form>
            )}
          </div>
        </Stack>
      </div>
    </Pane>
  );
}
