// 「提交拍板 / 确定，开单 / 同意做」（#2062 接 B 片 #2060）：确定和同意做会在 GitHub 上开单，后端同步开，可能慢。
// 请求没等到回话（连不上、网关超时）时不让人重点：按「需求号 + 草稿版本号」去查这一版开没开成单，照实告诉人。
// 后端明确说了不行（409、503 没接上 GitHub）就原样显示原因，不去查。
import { toast } from 'sonner';
import { ApiError, errorText, useIssueOpeningLookup, useRequestAction } from '../../api/client';

/** 这种错不代表没开成：后端可能已经开了单，只是回话没送到。 */
export function maybeOpened(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 0 || err.status === 502 || err.status === 504);
}

type OpenAction = 'submit' | 'confirm' | 'approve';

const DONE_TEXT: Record<OpenAction, string> = {
  submit: '已提交拍板',
  confirm: '已确定开单，结案',
  approve: '同意做：已开单，结案',
};

export function useOpenIssueAction() {
  const act = useRequestAction();
  const lookup = useIssueOpeningLookup();
  const run = (seq: number, action: OpenAction, draftVersion: number) =>
    act.mutate(
      { seq, body: { action, draftVersion } },
      {
        onSuccess: () => toast.success(DONE_TEXT[action]),
        onError: (err) => {
          if (action === 'submit' || !maybeOpened(err)) {
            toast.error(`没成：${errorText(err)}`);
            return;
          }
          void lookup(seq, draftVersion).then(
            (o) => {
              if (o.state === 'opened' && o.issue) {
                toast.success(`单已经开出来了：${o.issue.repo}#${o.issue.number}（刚才回话没送到）`);
              } else if (o.state === 'opening') {
                toast.message('还在开单：过一会儿刷新看结果，先别重点');
              } else if (o.state === 'failed') {
                toast.error(`没开成：${o.error ?? '后端没写原因'}`);
              } else {
                toast.error(`没成：${errorText(err)}（这一版没开过单，可以再点一次）`);
              }
            },
            (e: unknown) =>
              toast.error(`回话没送到，查开没开成也没查成：${errorText(e)}。先别重点，刷新看看`),
          );
        },
      },
    );
  return { run, isPending: act.isPending };
}
