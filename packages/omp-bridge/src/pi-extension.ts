// 可直接加载到 pi (omp) 的轻量级扩展入口（方案 2 右臂底座）。
// 职责：
// 1. 在每次工具执行后自动做省 Token 大输出折叠（foldToolOutput）；
// 2. 在每次文件修改（edit/write）后异步触发免费的 Devin swe-2 跑 YSK (Heads up · 主 agent) 旁路挑错；
// 3. 注入跨会话黑板通信与根据模型动态拼装的 Prompt Overlay。
import type { SessionCommunicationBus } from './blackboard.ts';
import { foldToolOutput } from './token-compactor.ts';
import { runYskCheck, type YskAlert } from './ysk-watcher.ts';

export interface OmpBridgeRuntimeOptions {
  sessionId: string;
  waveId: string;
  taskGoal: string;
  allowedScope: readonly string[];
  mustNotDo: readonly string[];
  bus: SessionCommunicationBus;
  onYskAlert?: (alert: YskAlert) => void;
}

export function createOmpBridgeHook(opts: OmpBridgeRuntimeOptions) {
  opts.bus.joinWave(opts.waveId, opts.sessionId);

  return {
    /** 工具执行完毕后：先做大输出省 Token 折叠，再对写操作跑 YSK 旁路盯梢。 */
    async onToolExecutionEnd(event: {
      toolName: string;
      exitCode?: number;
      output: string;
      changedFiles?: ReadonlyArray<{
        path: string;
        addedLines: number;
        removedLines: number;
        diffPreview: string;
      }>;
    }) {
      const folded = foldToolOutput(event.toolName, event.output, event.exitCode ?? 0);
      let yskAlert: YskAlert | undefined;

      if (
        (event.toolName === 'edit' || event.toolName === 'write' || event.toolName === 'bash') &&
        event.changedFiles &&
        event.changedFiles.length > 0
      ) {
        yskAlert = await runYskCheck({
          taskGoal: opts.taskGoal,
          allowedScope: opts.allowedScope,
          mustNotDo: opts.mustNotDo,
          changedFiles: event.changedFiles,
        });
        if (yskAlert.triggered) {
          opts.onYskAlert?.(yskAlert);
          if (yskAlert.steerInstruction) {
            opts.bus.steer({
              id: `ysk-${Date.now()}`,
              from: 'ysk-watcher',
              toSessionId: opts.sessionId,
              priority: yskAlert.severity === 'critical' ? 'urgent-jump' : 'normal',
              text: yskAlert.steerInstruction,
              createdAt: new Date().toISOString(),
            });
          }
        }
      }

      return {
        output: folded.foldedText,
        savedTokensEstimate: folded.savedTokensEstimate,
        yskAlert,
        pendingSteers: opts.bus.drainSteer(opts.sessionId),
      };
    },
  };
}
