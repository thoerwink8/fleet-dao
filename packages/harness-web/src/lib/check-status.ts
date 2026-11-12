/** 一条 CI 检查在面板上怎么写、点什么颜色。认大小写。对不上的状态原样留下，点用灰色。 */
export function checkStatusView(state: string): { label: string; dot: string } {
  switch (state.toLowerCase()) {
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
    case 'cancelled':
    case 'timed_out':
    case 'action_required':
    case 'stale':
    case 'startup_failure':
    case 'error':
      return { label: '失败', dot: 'bg-danger' };
    default:
      return { label: state, dot: 'bg-muted' };
  }
}
