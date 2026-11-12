//! fleet-core：Rust 高性能多 Agent 编排核心原语（方案 2 底座）。
//!
//! 包含五大核心子系统：
//! 1. 四维路由矩阵（Role × Channel × Model × Account）与 reclaude 官方本体防封硬锁；
//! 2. 模型专属 Prompt Overlay 编译器与自进化反模式规则提炼；
//! 3. 仿 Claude Code `you-should-know` (YSK) 旁路盯梢判定器（默认绑定免费 `devin/swe-2`）；
//! 4. 波次 DAG 状态机与跨会话黑板通信（`steer` / `publish_fact` / `handoff`）；
//! 5. 四道递进式可信度验收漏斗（YSK → Rust 0-Token 机械闸 → 异族冷验收 → Wilson 95% 置信下界自适应放行）。

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// 七大核心工种。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentRole {
    Commander,
    Planner,
    WorkerCode,
    WorkerUi,
    Scout,
    Verifier,
    YskWatcher,
}

/// 模型家族（用于异族冷验收硬约束与家族级 Prompt Overlay）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelFamily {
    Claude,
    Gpt,
    Deepseek,
    Grok,
    Gemini,
    Swe,
    Kimi,
    Glm,
}

/// 方案 2 双常驻流执行器类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineRunner {
    /// 左臂：拉起官方 reclaude -> claude 本体（--input-format stream-json --output-format stream-json），绝不走 HTTP 反代。
    NativeReclaudeStream,
    /// 右臂：拉起小而美的 pi (omp) 常驻流，经本地回环网关调兼容 API。
    PiApiStream,
    /// 原生专属 CLI 常驻流（如 grok / agy）。
    NativeCliStream,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelTier {
    Flagship,
    Workhorse,
    Fast,
    Free,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelSpec {
    pub id: String,
    pub name: String,
    pub runner: EngineRunner,
    pub strict_native_client: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelSpec {
    pub id: String,
    pub display_name: String,
    pub family: ModelFamily,
    pub tier: ModelTier,
    pub forbidden_roles: Vec<AgentRole>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountSnapshot {
    pub account_id: String,
    pub channel_id: String,
    /// reclaude 一号一环境必填（如 "vps-france:fleet-agent-carpool"）。
    pub isolated_host_user: Option<String>,
    pub enabled: bool,
    pub remaining_ratio: f64,
    /// 距离 5h 拼车窗清零剩余分钟数（临近清零且有余量的优先烧满）。
    pub minutes_until_reset: Option<u32>,
}

/// 防封硬锁：任何时候企图把 reclaude 配成非官方常驻流或缺少独立宿主用户隔离，立即返回 Err。
pub fn verify_anti_ban(channel: &ChannelSpec, account: &AccountSnapshot) -> Result<(), String> {
    if channel.strict_native_client || channel.id == "reclaude" {
        if channel.runner != EngineRunner::NativeReclaudeStream {
            return Err(format!(
                "防封拦截：渠道 {} 必须走 NativeReclaudeStream 官方本体常驻流，严禁 HTTP 反代以免触发 non_cc_client 封号",
                channel.id
            ));
        }
        let valid_isolation = account
            .isolated_host_user
            .as_deref()
            .is_some_and(|u| u.contains(':'));
        if !valid_isolation {
            return Err(format!(
                "防封拦截：reclaude 账号 {} 必须绑定独立的「宿主:系统用户」(isolated_host_user)，严禁同环境混登",
                account.account_id
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteCandidate {
    pub channel: ChannelSpec,
    pub model: ModelSpec,
    pub account: AccountSnapshot,
    pub wilson_lower_bound: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectedRoute {
    pub role: AgentRole,
    pub channel_id: String,
    pub model_id: String,
    pub account_id: String,
    pub runner: EngineRunner,
    pub score: f64,
}

/// 四维选路器：综合硬禁令、异族约束、reclaude 防封校验、Magpie 5h 窗口紧迫度与 Wilson 战绩下界。
pub fn select_best_route(
    role: AgentRole,
    candidates: &[RouteCandidate],
    exclude_family: Option<ModelFamily>,
    narrow_and_checkable: bool,
) -> Result<SelectedRoute, String> {
    let mut best: Option<SelectedRoute> = None;

    for c in candidates {
        if !c.account.enabled || c.account.remaining_ratio <= 0.02 {
            continue;
        }
        if c.model.forbidden_roles.contains(&role) {
            continue;
        }
        if exclude_family.is_some_and(|f| f == c.model.family) {
            continue;
        }
        if matches!(role, AgentRole::WorkerCode | AgentRole::WorkerUi)
            && !narrow_and_checkable
            && matches!(c.model.tier, ModelTier::Fast | ModelTier::Free)
        {
            continue;
        }

        verify_anti_ban(&c.channel, &c.account)?;

        let urgency_boost = match c.account.minutes_until_reset {
            Some(mins) if mins <= 150 && c.account.remaining_ratio >= 0.15 => {
                1.35 + ((150.0 - f64::from(mins)) / 60.0) * 0.15
            }
            _ => 1.0,
        };

        let tier_score = match role {
            AgentRole::YskWatcher | AgentRole::Scout => match c.model.tier {
                ModelTier::Free => 2.0,
                ModelTier::Fast => 1.5,
                _ => 0.6,
            },
            AgentRole::Commander | AgentRole::Planner => match c.model.tier {
                ModelTier::Flagship => 1.6,
                ModelTier::Workhorse => 1.1,
                _ => 0.4,
            },
            _ => match c.model.tier {
                ModelTier::Fast if narrow_and_checkable => 1.45,
                ModelTier::Workhorse => 1.4,
                ModelTier::Flagship => 1.25,
                _ => 0.7,
            },
        };

        let score = tier_score
            * urgency_boost
            * (0.5 + 0.5 * c.account.remaining_ratio)
            * c.wilson_lower_bound;

        if best.as_ref().is_none_or(|b| score > b.score) {
            best = Some(SelectedRoute {
                role,
                channel_id: c.channel.id.clone(),
                model_id: c.model.id.clone(),
                account_id: c.account.account_id.clone(),
                runner: c.channel.runner,
                score: (score * 10000.0).round() / 10000.0,
            });
        }
    }

    best.ok_or_else(|| format!("没有找到符合工种 {:?} 的可用路由", role))
}

/// YSK (`you-should-know`) 旁路盯梢警报（对应 `✦ Heads up · 主 agent`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct YskAlert {
    pub triggered: bool,
    pub badge: String,
    pub message: String,
    pub steer_instruction: Option<String>,
    pub watcher_model: String,
}

/// 毫秒级确定性 YSK 越界与删断言检查。
pub fn evaluate_ysk_diff(
    task_goal: &str,
    allowed_prefixes: &[String],
    changed_files: &[(String, String)],
) -> YskAlert {
    let out_of_scope: Vec<&str> = changed_files
        .iter()
        .map(|(p, _)| p.as_str())
        .filter(|p| {
            !allowed_prefixes.is_empty()
                && !allowed_prefixes.iter().any(|allow| p.starts_with(allow))
        })
        .collect();

    if !out_of_scope.is_empty() {
        let joined = out_of_scope.join("、");
        let msg = format!(
            "主任务是「{}」，但顺手改了授权范围外的文件（{}），不只是改目标模块。",
            task_goal, joined
        );
        return YskAlert {
            triggered: true,
            badge: "✦ Heads up · 主 agent".to_string(),
            steer_instruction: Some(format!(
                "[YSK 旁路提醒] {} 请立即还原范围外修改。",
                msg
            )),
            message: msg,
            watcher_model: "devin/swe-2".to_string(),
        };
    }

    for (path, diff) in changed_files {
        if (path.ends_with(".test.ts") || path.ends_with(".test.tsx"))
            && diff.lines().filter(|l| l.starts_with('-') && l.contains("expect(")).count()
                > diff.lines().filter(|l| l.starts_with('+') && l.contains("expect(")).count()
        {
            let msg = format!("在测试文件 {} 中删掉了原有 expect 断言，严禁删断言凑绿。", path);
            return YskAlert {
                triggered: true,
                badge: "✦ Heads up · 主 agent".to_string(),
                steer_instruction: Some(format!("[YSK 旁路提醒] {}", msg)),
                message: msg,
                watcher_model: "devin/swe-2".to_string(),
            };
        }
    }

    YskAlert {
        triggered: false,
        badge: "✦ Heads up · 主 agent".to_string(),
        message: "未发现越界或删断言".to_string(),
        steer_instruction: None,
        watcher_model: "devin/swe-2".to_string(),
    }
}

/// 计算 Wilson 95% 置信下界（用于自适应人工/自动验收闸）。
pub fn wilson_lower_bound(successes: u32, total: u32) -> f64 {
    if total == 0 {
        return 0.0;
    }
    let n = f64::from(total);
    let phat = f64::from(successes) / n;
    let z = 1.96_f64;
    let z2 = z * z;
    let num = phat + z2 / (2.0 * n) - z * ((phat * (1.0 - phat) + z2 / (4.0 * n)) / n).sqrt();
    let den = 1.0 + z2 / n;
    ((num / den).max(0.0) * 10000.0).round() / 10000.0
}

/// 波次（Wave）DAG 子任务节点与跨会话黑板。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum WaveNodeStatus {
    Pending,
    Ready,
    Running,
    Verified,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaveNode {
    pub id: String,
    pub title: String,
    pub depends_on: Vec<String>,
    pub write_scope: Vec<String>,
    pub status: WaveNodeStatus,
}

#[derive(Debug, Default)]
pub struct WaveOrchestrator {
    pub nodes: HashMap<String, WaveNode>,
    pub blackboard_facts: Vec<String>,
    pub steer_mailboxes: HashMap<String, Vec<String>>,
}

impl WaveOrchestrator {
    pub fn add_node(&mut self, node: WaveNode) {
        self.nodes.insert(node.id.clone(), node);
    }

    /// 找出所有前置依赖已 Verified 且 write_scope 互不冲突、可立即并行派发的节点 ID。
    pub fn runnable_parallel_batch(&self) -> Vec<String> {
        let mut ready_ids = Vec::new();
        let mut claimed_scopes: HashSet<&str> = HashSet::new();

        let mut keys: Vec<&String> = self.nodes.keys().collect();
        keys.sort();

        for id in keys {
            let node = &self.nodes[id];
            if node.status != WaveNodeStatus::Pending && node.status != WaveNodeStatus::Ready {
                continue;
            }
            let deps_done = node.depends_on.iter().all(|dep| {
                self.nodes
                    .get(dep)
                    .is_some_and(|d| d.status == WaveNodeStatus::Verified)
            });
            if !deps_done {
                continue;
            }
            let scope_conflict = node
                .write_scope
                .iter()
                .any(|s| claimed_scopes.contains(s.as_str()));
            if scope_conflict {
                continue;
            }
            for s in &node.write_scope {
                claimed_scopes.insert(s.as_str());
            }
            ready_ids.push(node.id.clone());
        }
        ready_ids
    }

    /// 发布黑板事实并自动塞进同波次在跑会话的 Steer 邮箱。
    pub fn publish_fact(&mut self, author_node_id: &str, fact: &str) {
        self.blackboard_facts.push(format!("[{}] {}", author_node_id, fact));
        for (id, node) in &self.nodes {
            if id != author_node_id && node.status == WaveNodeStatus::Running {
                self.steer_mailboxes
                    .entry(id.clone())
                    .or_default()
                    .push(format!("[黑板同步 · 来自 {}] {}", author_node_id, fact));
            }
        }
    }
}

/// 模型专属三明治提示词编译输入（Rust 端与 TS 端同构）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptCompileSpec {
    pub role: AgentRole,
    pub model_id: String,
    pub family: ModelFamily,
    pub task_title: String,
    pub write_scope: Vec<String>,
    pub check_command: String,
    pub evolved_rules: Vec<String>,
}

/// 编译生成三明治提示词（1. 工种核心契约 + 2. 模型脾气专属装甲 + 3. 战绩自进化反模式护栏 + 4. 边界与核验命令）。
pub fn compile_agent_prompt(spec: &PromptCompileSpec) -> String {
    let role_kernel = match spec.role {
        AgentRole::Commander => "你是总指挥官（Commander）。只管对题、拆解无冲突的波次子任务 DAG（标明 writeScope 与机器核对命令）、居中协调黑板消息，绝不亲自下场改业务代码。",
        AgentRole::Planner => "你是架构规划师（Planner）。只读分析 Scout 给出的代码切片与需求，输出精确到文件与函数名的修改步骤、依赖关系（dependsOn）、写范围（writeScope）和一条确定性的机器验证命令。严禁修改任何文件。",
        AgentRole::WorkerCode => "你是编码主力工人（Worker-Code）。只在授权的 writeScope 内做最小化、触及根因的修改（删掉出问题的那一层，不打外围补丁）。改完必须亲自跑验证命令并核对退出码为 0 后才准交活。",
        AgentRole::WorkerUi => "你是前端与视觉工人（Worker-UI）。使用统一的 shadcn/ui + Tailwind v4 令牌构建高密度、克制工业风界面（正常态只画灰点，异常才上色；数字加 .num tabular-nums）。改完必须验证 1440px 与 390px 双屏无横滚、无错位。",
        AgentRole::Scout => "你是极速斥候（Scout）。只用只读工具（read/grep/find/codemode）在 20 秒内定位目标代码的精确文件路径、行号区间 [Lstart-Lend] 与核心类型签名，输出结构化浓缩切片供主力模型直接使用。",
        AgentRole::Verifier => "你是异族独立冷验收员（Verifier）。不听信写码模型的自述，只对照【需求验收条】、【git diff】和【机械测试回执】检查三件事：①验收条是否真达成；②是否破坏已有功能；③有无安全/丢数据隐患。推测性风格意见一律不拦。",
        AgentRole::YskWatcher => "你是旁路监督员（you-should-know）。你不写代码，只盯着主 agent 刚改出的 git diff。专门挑出：「顺手改了需求外已上线的文案/导航/接口」「漏改了同构实现」「吞掉报错返回空或 0」。正常只回 OK，异常用一句话直指要害。",
    };

    let family_overlay = match spec.family {
        ModelFamily::Claude => "【Claude / Kiro 专属装甲】\n- 善用 codemode 一次批处理多个独立文件读取，将 5 个回合压成 1 个回合。\n- 严禁过度防御（不加无意义的 fallback 空数组/空字符串掩盖错误，读不到就明确返回失败）。",
        ModelFamily::Deepseek => "【CommonCode / OpenCode · DeepSeek 编码主力装甲】\n- 严格执行三步走状态机：① 核对 Scout 预喂的代码切片行号 → ② 最小唯一 oldText 调用 edit → ③ 立即运行核对命令看真实退出码。\n- 严禁顺手修改 writeScope 以外或需求未点名的已上线文案、导航与导出接口；严禁省略代码片段用注释代替。",
        ModelFamily::Gpt => "【Recodex · GPT Codex 专属装甲】\n- 硬禁令：严禁触碰任何前端样式与视觉组件（worker-ui 硬禁令）。\n- 写修复前先构造最小复现断言，再改根因层让测试转绿；零礼貌套话直接给结论。",
        ModelFamily::Swe => "【Devin SWE-2 (Free) 极速盯梢与斥候装甲】\n- 做 Scout 时只列「文件路径 + [Lstart-Lend] 行号区间 + 关键函数签名」；做 YSK 盯梢时无越界只回 OK，有越界一句话 (<55字) 直指要害。",
        ModelFamily::Grok => "【Grok Heavy 专属装甲】\n- 专注疑难并发竞态、系统级排障与二轮盲审挑错；给出结论时必须附带精确的 文件:行号 证据。",
        ModelFamily::Gemini => "【Antigravity · Gemini 专属装甲】\n- 利用超大上下文做跨包全链路对齐，每次 edit 只改明确点名的文件；执行 UI 审查时逐一比对 1440px 与 390px 截图零横滚。",
        ModelFamily::Kimi => "【Kimi 专属装甲】\n- 长文本归纳与中文业务语义对齐优先；动手改码后必须逐条核对验收清单。",
        ModelFamily::Glm => "【GLM 专属装甲】\n- 快速执行窄范围明确指令；严格按照给定模板格式输出。",
    };

    let mut sections = vec![
        format!("# 角色与铁律\n{}", role_kernel),
        family_overlay.to_string(),
    ];

    if !spec.evolved_rules.is_empty() {
        let rules = spec
            .evolved_rules
            .iter()
            .map(|r| format!("- {}", r))
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(format!("【{} 战绩自进化反模式护栏】\n{}", spec.model_id, rules));
    }

    let scope_str = if spec.write_scope.is_empty() {
        "只读（禁止写任何文件）".to_string()
    } else {
        spec.write_scope.join(", ")
    };
    sections.push(format!(
        "# 当前任务：{}\n- 允许写范围（writeScope）：{}\n- 机器核对命令（必跑且退出码为 0）：{}",
        spec.task_title, scope_str, spec.check_command
    ));

    sections.join("\n\n")
}

/// 四道递进式可信度验收漏斗判定输入。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunnelEvalInput {
    pub worker_family: ModelFamily,
    pub verifier_family: ModelFamily,
    pub ysk_alert_triggered: bool,
    pub mechanical_passed: bool,
    pub cold_verify_passed: bool,
    pub attempt: u32,
    pub matured_successes: u32,
    pub matured_total: u32,
    pub recent_reverts: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FunnelAction {
    AutoMergeToWave,
    QueueForHumanConfirm,
    RetrySameModel,
    EscalateStrongerModel,
    RejectSameFamilyVerifier,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunnelVerdict {
    pub action: FunnelAction,
    pub wilson_lower_bound: f64,
    pub auto_gate_eligible: bool,
    pub reason: String,
}

/// 执行四道可信度验收漏斗判定。
pub fn evaluate_trust_funnel(input: &FunnelEvalInput) -> FunnelVerdict {
    let wilson = wilson_lower_bound(input.matured_successes, input.matured_total);
    let auto_gate_eligible =
        input.matured_total >= 20 && wilson >= 0.90 && input.recent_reverts == 0;

    if input.worker_family == input.verifier_family {
        return FunnelVerdict {
            action: FunnelAction::RejectSameFamilyVerifier,
            wilson_lower_bound: wilson,
            auto_gate_eligible: false,
            reason: format!(
                "异族冷验收拦截：写码模型与验收模型同属 {:?} 族，必须改派异族模型盲审",
                input.worker_family
            ),
        };
    }

    if input.ysk_alert_triggered || !input.mechanical_passed || !input.cold_verify_passed {
        let action = if input.attempt >= 2 {
            FunnelAction::EscalateStrongerModel
        } else {
            FunnelAction::RetrySameModel
        };
        return FunnelVerdict {
            action,
            wilson_lower_bound: wilson,
            auto_gate_eligible: false,
            reason: if input.attempt >= 2 {
                "连续 2 次未过机械闸/冷验收，自动提权升级到强一档模型接手".to_string()
            } else {
                "未通过 YSK/机械闸/异族冷验收，带确定性错误回执重试".to_string()
            },
        };
    }

    if auto_gate_eligible {
        FunnelVerdict {
            action: FunnelAction::AutoMergeToWave,
            wilson_lower_bound: wilson,
            auto_gate_eligible: true,
            reason: format!(
                "四道漏斗全绿，且该路由成熟样本 {} 单、Wilson 下界 {:.2}% >= 90%，自动合入波次分支",
                input.matured_total,
                wilson * 100.0
            ),
        }
    } else {
        FunnelVerdict {
            action: FunnelAction::QueueForHumanConfirm,
            wilson_lower_bound: wilson,
            auto_gate_eligible: false,
            reason: format!(
                "四道漏斗全绿（样本 {} 单，Wilson 下界 {:.2}%），呈报驾驶舱「决策」台一键拍板",
                input.matured_total,
                wilson * 100.0
            ),
        }
    }
}

/// 分布式宿主节点与跨主机协同网格（Multi-Host Cluster & Cross-Host Mesh Bus）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostNodeStatus {
    Online,
    Draining,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterHostSpec {
    pub host_id: String,
    pub display_name: String,
    pub endpoint: String,
    pub tags: Vec<String>,
    pub max_slots: u32,
    pub running_jobs: u32,
    pub status: HostNodeStatus,
    pub zero_key_on_disk: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrossHostDispatchDecision {
    pub task_title: String,
    pub selected_host_id: String,
    pub selected_host_name: String,
    pub mesh_broadcast: String,
}

/// 跨主机智能派单与协同广播器：按指定主机或能力标签 + 空闲槽位自动挑最合适的机器，并生成跨机 Mesh 广播。
pub fn select_cluster_host_for_task(
    task_title: &str,
    preferred_host_id: Option<&str>,
    required_tag: Option<&str>,
    hosts: &[ClusterHostSpec],
) -> Result<CrossHostDispatchDecision, String> {
    let mut candidates: Vec<&ClusterHostSpec> = hosts
        .iter()
        .filter(|h| h.status == HostNodeStatus::Online && h.running_jobs < h.max_slots)
        .collect();

    if let Some(pref) = preferred_host_id {
        candidates.retain(|h| h.host_id == pref);
    }
    if let Some(tag) = required_tag {
        candidates.retain(|h| h.tags.iter().any(|t| t == tag));
    }

    candidates.sort_by(|a, b| {
        let load_a = f64::from(a.running_jobs) / f64::from(a.max_slots.max(1));
        let load_b = f64::from(b.running_jobs) / f64::from(b.max_slots.max(1));
        load_a.partial_cmp(&load_b).unwrap_or(std::cmp::Ordering::Equal)
    });

    let chosen = candidates
        .first()
        .ok_or_else(|| "没有找到在线且有空闲槽位的目标主机".to_string())?;

    Ok(CrossHostDispatchDecision {
        task_title: task_title.to_string(),
        selected_host_id: chosen.host_id.clone(),
        selected_host_name: chosen.display_name.clone(),
        mesh_broadcast: format!(
            "[Cross-Host Mesh] 任务「{}」已指派至节点【{}】({})，跨机黑板实时同步已开启",
            task_title, chosen.display_name, chosen.endpoint
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anti_ban_blocks_http_proxy_for_reclaude() {
        let bad_channel = ChannelSpec {
            id: "reclaude".into(),
            name: "Reclaude".into(),
            runner: EngineRunner::PiApiStream,
            strict_native_client: true,
        };
        let acc = AccountSnapshot {
            account_id: "carpool-1".into(),
            channel_id: "reclaude".into(),
            isolated_host_user: Some("france:fleet-agent-carpool".into()),
            enabled: true,
            remaining_ratio: 0.8,
            minutes_until_reset: Some(60),
        };
        assert!(verify_anti_ban(&bad_channel, &acc).is_err());

        let good_channel = ChannelSpec {
            runner: EngineRunner::NativeReclaudeStream,
            ..bad_channel
        };
        assert!(verify_anti_ban(&good_channel, &acc).is_ok());
    }

    #[test]
    fn ysk_catches_out_of_scope_edits() {
        let alert = evaluate_ysk_diff(
            "新增结账页初稿",
            &["packages/harness-web/src/pages/checkout.tsx".to_string()],
            &[
                (
                    "packages/harness-web/src/pages/checkout.tsx".to_string(),
                    "+ export function Checkout() {}".to_string(),
                ),
                (
                    "packages/harness-web/src/components/shell.tsx".to_string(),
                    "- 首页\n+ 商城".to_string(),
                ),
            ],
        );
        assert!(alert.triggered);
        assert_eq!(alert.badge, "✦ Heads up · 主 agent");
        assert!(alert.message.contains("shell.tsx"));
    }

    #[test]
    fn wave_dag_schedules_non_conflicting_nodes_and_broadcasts_blackboard() {
        let mut dag = WaveOrchestrator::default();
        dag.add_node(WaveNode {
            id: "n1".into(),
            title: "改 API 契约".into(),
            depends_on: vec![],
            write_scope: vec!["packages/harness-api".into()],
            status: WaveNodeStatus::Pending,
        });
        dag.add_node(WaveNode {
            id: "n2".into(),
            title: "改 Store".into(),
            depends_on: vec![],
            write_scope: vec!["packages/harness-store".into()],
            status: WaveNodeStatus::Pending,
        });
        dag.add_node(WaveNode {
            id: "n3".into(),
            title: "接前端".into(),
            depends_on: vec!["n1".into(), "n2".into()],
            write_scope: vec!["packages/harness-web".into()],
            status: WaveNodeStatus::Pending,
        });

        assert_eq!(dag.runnable_parallel_batch(), vec!["n1", "n2"]);
        dag.nodes.get_mut("n1").unwrap().status = WaveNodeStatus::Running;
        dag.nodes.get_mut("n2").unwrap().status = WaveNodeStatus::Running;
        dag.publish_fact("n1", "新增了 /api/waves 路由");
        assert_eq!(dag.steer_mailboxes["n2"].len(), 1);
    }

    #[test]
    fn wilson_score_is_conservative_for_small_samples() {
        assert!(wilson_lower_bound(5, 5) < 0.60);
        assert!(wilson_lower_bound(98, 100) > 0.92);
    }
}
