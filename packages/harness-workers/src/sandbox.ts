// 工人以会话用户跑（#3814）：内核以 fleet 跑，工人经 fleet-agent-scope 以 fleet-agent-carpool 跑进 fleet2-shadow.slice。
// 内核建的目录要交给会话用户（adopt）才读写得了；会话用户的目录 fleet 删不掉，按 adopt 回执的身份经帮手删；
// 工人的进程归会话用户，运行层按 FLEET_RUN_ID 认不到，跑完按编号收掉整个 scope（stop）。
// 这里只定接口；真实现（经 sudo 调帮手）在 harness-dispatch/src/scope-sandbox.ts：起子进程只走 runProcess，runCommand 在那一层。

export interface AdoptedDir {
  /** 按 adopt 回执的身份删掉这个目录。 */
  release(): Promise<void>;
}

export interface WorkerSandbox {
  /** 把目录交给会话用户（不在就建，在就改属主，里面的一起）。 */
  adopt(dir: string): Promise<AdoptedDir>;
  /** 收掉这个工人的 scope；不在也算收好。 */
  stop(runId: string): Promise<void>;
}
