// worker.mjs 的 spawnDetached 里两块纯逻辑，拆出来是因为 worker.mjs 顶层直接跑 runWorker（有副作用：真的
// 读 argv、真的起子进程），测试没法直接 import 它——和 windows-quote.mjs 一个道理。
//
// 09-28 晚上真活撞出的坑（细节和复现方式写在 PR 正文）：spawnSync 调 powershell.exe 用默认的管道 stdio 时，
// 这个管道是个可继承的句柄，Start-Process 底下的 CreateProcess 会把它整个传给孙进程（cmd.exe -> grok/codex），
// 哪怕孙进程自己的 stdout/stderr 已经另外重定向到文件——于是 Node 这边读这个管道会一直等到每一个拿着这个句柄
// 的进程都退出才算完，对一个跑好几分钟的模型会话来说就是一直卡到超时（ETIMEDOUT），哪怕 Start-Process 早就
// 成功起来了。修法：powershellSpawnOptions 钉死 stdio:'ignore'（压根不开管道，没什么可以被继承），pid 和出错
// 信息改成让 launch-detached.ps1 写进一个结果文件（路径由 worker.mjs 用 -Result 参数直接传给它，不靠解析
// spec 文件，这样连 spec 本身解析失败这种极端情况都还能设法留下一点线索——虽然多半还是留不下，见下面）。
//
// interpretLaunchResult 认三种结果，绝不能把「不确定」当成「确认起不来」说出去（09-28 真撞过：进程其实已经在
// 跑，报的却是「起不了」）：
// - 确认成功：launch-detached.ps1 从 Start-Process 拿到了 pid，写进结果文件。
// - 确认失败（confirmed:true，可以说「起不了」）：powershell.exe 这个进程本身都没能起来（spawnError 有值，
//   说明 Start-Process 从没被调用过），或者 launch-detached.ps1 自己在结果文件里报了「Start-Process 抛出来
//   了、没拿到 pid」——这两种情况都能证明确实什么都没起来。
// - 不确定（confirmed:false，绝不能说「起不了」）：除上面两种之外的任何情况——没读到结果文件、结果文件不是
//   合法 JSON、结果文件里既没有 pid 也没有 error。Start-Process 完全可能已经成功起来了，只是这条链路上更后面
//   的某一步（写结果文件、读结果文件）没能确认给我们看。

/**
 * spawnSync 调 launch-detached.ps1 时必须用的选项。stdio:'ignore' 是关键（见文件头），钉在这独立测，回归了
 * 在这测破，不用每次改完再靠真跑一个长活才能发现。
 */
export function powershellSpawnOptions({ timeoutMs }) {
  return { stdio: 'ignore', windowsHide: true, timeout: timeoutMs };
}

/**
 * @param {{ spawnError: string | null, spawnStatus: number | null, resultText: string | null }} o
 *   spawnError：spawnSync 调 powershell.exe 本身失败时的原因（r.error?.code ?? r.error?.message），没失败传 null。
 *   spawnStatus：powershell.exe 的退出码，spawnError 有值时通常是 null。
 *   resultText：读 launch-detached.ps1 该写的结果文件读到的原始文本；文件不存在或读不了就传 null。
 * @returns {{ ok: true, pid: number } | { ok: false, confirmed: boolean, why: string }}
 */
export function interpretLaunchResult({ spawnError, spawnStatus, resultText }) {
  if (spawnError) {
    return { ok: false, confirmed: true, why: `起不了 powershell.exe（${spawnError}）` };
  }
  let result = null;
  if (typeof resultText === 'string') {
    try {
      result = JSON.parse(resultText);
    } catch {
      result = null;
    }
  }
  if (result && Number.isInteger(result.pid) && result.pid > 0) {
    return { ok: true, pid: result.pid };
  }
  if (result && typeof result.error === 'string' && result.error) {
    return { ok: false, confirmed: true, why: `launch-detached.ps1 里 Start-Process 没成：${result.error}` };
  }
  return {
    ok: false,
    confirmed: false,
    why:
      `powershell.exe 退出码 ${spawnStatus}，没读到有效的 launch-result.json（不确定 Start-Process 成没成，` +
      '进程可能已经在跑、没记上）',
  };
}
