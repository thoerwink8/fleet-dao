export {
  CHANGELOG_FILE,
  type ChangelogDeliveries,
  type ChangelogIssue,
  type ChangelogVersion,
  changelogAnchor,
  hasChangelogVersion,
  renderChangelogVersion,
  writeChangelogVersion,
} from './changelog.ts';
export { closingIssues } from './closing-issues.ts';
export {
  checkDebtDocs,
  DEBT_REPORT_HEADER,
  DEFERRAL_PATTERNS,
  type DebtProblem,
  type DebtRun,
  type Deferral,
  debtFiles,
  doneSection,
  findDeferrals,
  formatDebtProblem,
  type LiveDebt,
  liveDebt,
  type RefState,
  refStates,
  staleRefFindings,
  untrackedDeferrals,
} from './debt.ts';
// 决定索引由各份决定书头部生成（bin/decisions-index.ts）。
export {
  checkDecisionsIndex,
  type DecisionEntry,
  type DecisionsProblem,
  generateDecisionsIndex,
  readDecisions,
  renderIndex,
} from './decisions-index.ts';
export {
  checkDocPointers,
  DOCS,
  formatProblem,
  type Pointer,
  type PointerKind,
  type Problem,
  type Report,
} from './doc-pointers.ts';
export { type Outcomes, outcomesOf } from './e2e-flaky.ts';
export {
  beijingDate,
  mentionsIssue,
  planQuarantineSync,
  QUARANTINE_PASS_DAYS,
  QUARANTINE_PATH,
  type QuarantineDay,
  type QuarantineMove,
  quarantineAfter,
  shiftDay,
} from './e2e-quarantine-sync.ts';
export { FLOW_BRANCH_PATTERN, isFlowBranch } from './flow-branch.ts';
export {
  type GitHubCommenter,
  type GitHubReader,
  githubToken,
  type IssueInfo,
  liveGitHub,
  type MilestoneDetail,
  type MilestoneInfo,
  type PlanIssue,
  repoName,
  toIssue,
  toMilestoneDetail,
  toPlanIssue,
} from './github-api.ts';
export { type BranchExecutor, issueOfBranch, localBranchPrefix } from './issue-branch.ts';
export {
  CLOSE_USAGE,
  CloseRefused,
  CloseUnchecked,
  type IssueCloseDeps,
  type IssueCloseResult,
  issueClose,
} from './issue-close.ts';
export {
  type CategoryPlan,
  categoryPlan,
  categoryRemovedByHuman,
  DEFAULT_IDLE_POLICY,
  daysBetween,
  type IdleDecision,
  type IdleFacts,
  type IdlePolicy,
  idleCloseComment,
  idlePlan,
  type JevKindAnswer,
  type LabelEvent,
  type MilestoneDecision,
  milestonePlan,
  staleSinceOf,
} from './issue-groom.ts';
export {
  checkIssueBody,
  checkRequiredSections,
  type Gh,
  type GhResult,
  ghRunner,
  type IssueBodyCheck,
  type IssueNewDeps,
  type IssueNewResult,
  issueBodyTooLong,
  issueNew,
  type MissingSection,
  requiredSectionProblems,
  sectionText,
  USAGE,
} from './issue-new.ts';
export {
  type Candidate as SimilarCandidate,
  modulePaths,
  rankSimilar,
  type SimilarItem,
} from './issue-similar.ts';
export {
  currentVersion,
  DOMAIN_LABELS,
  DOMAIN_VALUES,
  type DomainValue,
  domainLabel,
  ENGINE_LABEL,
  FROZEN_LABEL,
  FULL_FLOW_LABEL,
  GROOM_PENDING_LABEL,
  GROOMED_LABEL,
  HUMAN_DECISION_LABEL,
  IDLE_LABEL,
  isDomainValue,
  isKindLabel,
  isNatureValue,
  KIND_LABELS,
  type KindLabel,
  LOCAL_LABEL,
  labelCreateFailure,
  type MilestoneRef,
  MOTHER_LABEL,
  milestonePhase,
  milestoneVersion,
  NATURE_LABELS,
  NATURE_VALUES,
  type NatureValue,
  natureLabel,
  QUERY_LABEL_SPECS,
  type QueryLabelSpec,
  queryAxisLabels,
  queryLabelCreateArgs,
  requireAxis,
  THREE_FLOW_LABEL,
} from './labels.ts';
export { claimOf } from './main-reuse.ts';
export { type MdDoc, parseMd } from './markdown.ts';
export { type GateResult, type GitHubReads, gateGitHub, gatePr, runMergeGate } from './merge-gate.ts';
export {
  COLD_VERIFY_CONTEXT,
  COLD_VERIFY_MAX_ROUND,
  type ColdVerifyNeed,
  checkColdVerify,
  coldVerifyFrom,
  coldVerifyNeed,
  GATE_CONTEXT,
  statusByContext,
} from './merge-gates.ts';
export {
  describeOffDiff,
  isDiagnosticTitle,
  isMergeGateItem,
  OFF_DIFF_REWRITE,
  type OffDiffHold,
  type OffDiffHoldAction,
  type OffDiffItem,
  offDiffAcceptanceItems,
  offDiffHoldOf,
  offDiffItems,
  offDiffWords,
  splitAcceptanceItems,
} from './off-diff-acceptance.ts';
// ops 表格由 deploy/ 生成（#140 第一片）：端口表纯函数 + 命令行（bin/ops-tables.ts）。
// 第十一片：五个区块一起认的口子（checkOpsBlocks、writeOpsBlocks、opsDocPaths）。
export {
  BLOCK_NAME_PORTS,
  checkOpsBlocks,
  checkPortsBlock,
  extractBlock,
  OPS_BLOCK_NAMES,
  type OpsTableProblem,
  type OpsWriteResult,
  opsDocPaths,
  type PortEntry,
  portsTableInner,
  readPortEntries,
  renderPortsBlock,
  replaceBlock,
  writeOpsBlocks,
} from './ops-tables.ts';
export { type PlanPhase, type PlanRef, parsePlanRefs, planPhases } from './plan.ts';
export {
  addToOrder,
  formatAt,
  type OrderAdd,
  type OrderParse,
  PLAN_USAGE,
  type Plan,
  type PlanDeps,
  PlanProblem,
  type PlanRun,
  type PlanVersion,
  parseOrder,
  planCommand,
  planNotes,
  readPlan,
  renderPlan,
} from './plan-view.ts';
export { type OpenPullRef, otherPrOnIssue, prClaimedIssues, pullsOnIssue } from './pr-claims.ts';
export {
  ISSUE_COLUMN,
  issueColumnRefs,
  LEGACY_COLUMNS,
  linkedIssue,
  OPTIONAL_COLUMNS,
  PR_COLUMNS,
  prColumns,
} from './pr-columns.ts';
export { annotation } from './pr-fields.ts';
export { FIX_ALERT_COLUMN, fixAlertRefs, prLinks } from './pr-links.ts';
export { type Prerequisites, parsePrerequisites, waitingUntil } from './prerequisites.ts';
export {
  kindOf as progressKindOf,
  NO_OWNER,
  ownerLine,
  ownerOf as progressOwnerOf,
  PENDING_TAG,
  PROGRESS_ISSUE,
  stamp as progressStamp,
} from './progress.ts';
export { declaredQueryAxes, extractQueryAxes, queryAxisProblems, resolveQueryAxes } from './query-axis.ts';
export { fsRepo, type RepoView } from './repo.ts';
export {
  type ChangedFile,
  matchesStandardPath,
  parseStandardPaths,
  STANDARD_PATHS_FILE,
  type StandardFile,
  type StandardPath,
  standardFiles,
} from './standard-paths.ts';
export { loadStandardPaths } from './standard-paths-file.ts';
export { ENGINE_SESSION_MARKER, REFUSED_FULL_RUN } from './test-changed.ts';
// 引擎自测认「拿到本机测试槽」那一行分开等槽和真跑（packages/engine/src/real/self-check.ts），它的测试真起进程占这组槽
export {
  acquireSlot,
  DEFAULT_MAX_HOLD_MIN,
  readSlotConfig,
  realSlotDeps,
  SLOT_ACQUIRED_LINE,
} from './test-slots.ts';
export { isTestFile, parseTimings, TIMINGS_FILE, type Timings } from './test-split.ts';
export {
  medianOfRuns,
  mergeTimings,
  notPullRequestRun,
  parseRunLog,
  renderTimings,
  TIMINGS_AUTO_MIN_BOXES,
  TIMINGS_AUTO_RUNS,
  TIMINGS_AUTO_SCAN,
  TIMINGS_RUN_EVENT,
  timingsSource,
} from './test-timings.ts';
export {
  implementRoundsDone,
  type RoundRunFact,
  type TotalRoundsHold,
  type TotalRoundsHoldAction,
  totalRoundsHoldOf,
} from './total-rounds-hold.ts';
export { addDays } from './version-cut.ts';
