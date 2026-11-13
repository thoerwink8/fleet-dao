/**
 * GitHub 和 GitLab 共用这一张表。PR/MR 状态和流水线状态都从这里取中文。
 * 认大小写。对不上的原样留下，点用灰色。
 */
export function checkStatusView(state: string): { label: string; dot: string } {
  switch (state.toLowerCase()) {
    case 'open':
    case 'opened':
      return { label: '开着', dot: 'bg-muted' };
    case 'merged':
      return { label: '已合并', dot: 'bg-muted' };
    case 'closed':
      return { label: '已关闭', dot: 'bg-muted' };
    case 'draft':
      return { label: '草稿', dot: 'bg-muted' };
    case 'queued':
    case 'pending':
    case 'waiting':
    case 'requested':
      return { label: '排队中', dot: 'bg-warning' };
    case 'in_progress':
    case 'running':
      return { label: '在跑', dot: 'bg-brand animate-pulse-dot' };
    case 'success':
      return { label: '通过', dot: 'bg-success' };
    case 'failure':
    case 'failed':
    case 'cancelled':
    case 'canceled':
    case 'timed_out':
    case 'action_required':
    case 'stale':
    case 'startup_failure':
    case 'error':
      return { label: '失败', dot: 'bg-danger' };
    case 'created':
    case 'preparing':
    case 'waiting_for_resource':
    case 'scheduled':
    case 'manual':
      return { label: '排队中', dot: 'bg-warning' };
    default:
      return { label: state, dot: 'bg-muted' };
  }
}
