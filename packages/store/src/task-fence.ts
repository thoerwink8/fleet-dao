// 任务栅栏的名字：受管起代（重做）和受管纠正抢的是同一把锁。pg 与内存版共用这个名字。
export function taskFenceName(taskId: string): string {
  return `task-gen:${taskId}`;
}
