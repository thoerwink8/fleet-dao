// 引擎内部从这里引。判断本身在 @fleet-dao/shared/task-redo：
// 驾驶舱后端和引擎同一份，后端不依赖引擎包（改引擎只测引擎自己）。

export type {
  GenerationProbe,
  GenerationView,
  RedoDeps,
  RedoOutcome,
  SeenLife,
} from '@fleet-dao/shared/task-redo';
export {
  generationLife,
  MAX_TASK_GENERATION,
  readTaskGenerations,
  redoTask,
  runningTaskWorkflowId,
  signalTaskWorkflowId,
} from '@fleet-dao/shared/task-redo';
