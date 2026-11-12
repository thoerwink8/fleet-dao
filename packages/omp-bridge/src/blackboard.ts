// 会话间通信总线与同波次共享黑板（Actor Mailbox & Wave Blackboard）。
// 解决多 Agent 编排的三大协同难题：
// 1. 下行实时引导（steer）：指挥官、人类或 YSK 盯梢员随时往在跑会话塞修正指令，零中断；
// 2. 横向契约广播（publishFact）：同波次 Worker A 改了共享接口，自动通知同波次关联的 Worker B；
// 3. 跨引擎/跨模型热切换胶囊（HandoffCapsule）：从 CommonCode/DeepSeek 切到 reclaude/Opus 时，秒级交接状态而不搬运上万行废话。

export interface SteerEnvelope {
  id: string;
  from: 'founder' | 'commander' | 'ysk-watcher' | 'peer-worker';
  toSessionId: string;
  priority: 'normal' | 'urgent-jump';
  text: string;
  createdAt: string;
}

export interface BlackboardFact {
  id: string;
  waveId: string;
  authorSessionId: string;
  authorModel: string;
  touchedFiles: string[];
  fact: string;
  createdAt: string;
}

export interface HandoffCapsule {
  taskId: string;
  fromSessionId: string;
  fromModel: string;
  toModel: string;
  reason: 'model-upgrade' | 'quota-exhausted-switch' | 'stage-transition';
  completedSteps: string[];
  pendingSteps: string[];
  modifiedFiles: string[];
  lastErrorDigest?: string;
  checkCommand: string;
}

export class SessionCommunicationBus {
  private readonly mailboxes = new Map<string, SteerEnvelope[]>();
  private readonly waveFacts = new Map<string, BlackboardFact[]>();
  private readonly wavePeers = new Map<string, Set<string>>();

  /** 将一个会话登记进某个波次（Wave）。 */
  joinWave(waveId: string, sessionId: string): void {
    const peers = this.wavePeers.get(waveId) ?? new Set<string>();
    peers.add(sessionId);
    this.wavePeers.set(waveId, peers);
  }

  /** 发送下行实时引导（Steer）或插队指令（Jump）。 */
  steer(envelope: SteerEnvelope): void {
    const box = this.mailboxes.get(envelope.toSessionId) ?? [];
    if (envelope.priority === 'urgent-jump') {
      box.unshift(envelope);
    } else {
      box.push(envelope);
    }
    this.mailboxes.set(envelope.toSessionId, box);
  }

  /** Worker 在每个工具回合间隙拉取待消费的引导消息。 */
  drainSteer(sessionId: string): SteerEnvelope[] {
    const box = this.mailboxes.get(sessionId) ?? [];
    this.mailboxes.delete(sessionId);
    return box;
  }

  /**
   * 同波次 Worker 发布一条契约/接口变更事实（如：「已将 User.id 类型从 number 改为 string」），
   * 总线自动将其通过 steer 推送给同波次的所有其他并行 Worker！
   */
  publishFact(fact: BlackboardFact): { notifiedSessions: string[] } {
    const list = this.waveFacts.get(fact.waveId) ?? [];
    list.push(fact);
    this.waveFacts.set(fact.waveId, list);

    const peers = this.wavePeers.get(fact.waveId) ?? new Set<string>();
    const notified: string[] = [];
    for (const peerId of peers) {
      if (peerId === fact.authorSessionId) continue;
      this.steer({
        id: `fact-${fact.id}-to-${peerId}`,
        from: 'peer-worker',
        toSessionId: peerId,
        priority: 'normal',
        text: `[同波次黑板同步 · 来自 ${fact.authorSessionId} (${fact.authorModel})] ${fact.fact}（涉及文件：${fact.touchedFiles.join(', ')}）`,
        createdAt: fact.createdAt,
      });
      notified.push(peerId);
    }
    return { notifiedSessions: notified };
  }

  /** 读取某个波次积累的全部共享事实。 */
  listWaveFacts(waveId: string): readonly BlackboardFact[] {
    return this.waveFacts.get(waveId) ?? [];
  }

  /**
   * 构造跨模型/跨引擎（如 pi <-> reclaude）无缝热切换的交接提示词。
   */
  formatHandoffPrompt(capsule: HandoffCapsule): string {
    return [
      `# 跨模型热切换接力胶囊（${capsule.fromModel} → ${capsule.toModel}，原因：${capsule.reason}）`,
      `- 任务编号：${capsule.taskId}（原会话 ${capsule.fromSessionId}）`,
      `- 已完成步骤：${capsule.completedSteps.join('；') || '无'}`,
      `- 待完成步骤：${capsule.pendingSteps.join('；')}`,
      `- 当前工作树已改文件：${capsule.modifiedFiles.join(', ') || '暂无'}`,
      ...(capsule.lastErrorDigest ? [`- 前序模型卡住原因摘要：${capsule.lastErrorDigest}`] : []),
      `- 必跑核对命令：\`${capsule.checkCommand}\``,
      '请直接基于当前工作树已有改动继续推进，不要重复做已完成步骤。',
    ].join('\n');
  }
}
