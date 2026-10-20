﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿/**
 * ForgeDesk renderer 应用状态（zustand vanilla store 工厂）。
 * - 数据一律来自注入的 ForgeDeskBridge，本层不写死任何业务数据；
 * - 引擎事件经 EventBatcher（rAF/~50ms）批量投影，防 delta 洪峰打爆渲染；
 * - "通过"判定只在组件层经 contracts.computeTaskAcceptance 驱动，store 不点亮。
 */
import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import type {
  ApprovalDecision,
  AuthStatusInfo,
  EngineEvent,
  EngineModelInfo,
  EngineStatus,
  SteerResult,
  ThreadSummary,
  TokenUsageSummary,
} from '../contracts/engine';
import type {
  CreateTaskRequest,
  PendingAuthorization,
  RunnerDiagnostics,
  RunnerEvent,
} from '../contracts/runner';
import type { AcceptanceItem, EvidenceResult, TaskOverview } from '../contracts/engineering';
import type { EnumeratedDevice } from '../contracts/device';
import type { FailureInfo } from '../contracts/common';
import type { AppInfo, AppSettings, ForgeDeskBridge, ModelProviderSummary } from '../contracts/ipc';
import {
  applyEngineEventToConversation,
  appendSteerMessage,
  emptyConversation,
  EventBatcher,
  isDroppableEngineEvent,
  storedToConversation,
  type ConversationState,
  type PatchView,
} from '../lib/events';
import {
  asBuildOutput,
  asExportOutput,
  asInspectOutput,
  asPendingAuthorization,
  asTaskOverview,
  asTestOutput,
  asVerifyOutput,
  asOperation,
  asRecord,
  parseInvokePayload,
} from '../lib/parsers';
import {
  EVIDENCE_RESULT_LABELS_ZH as EVIDENCE_LABELS,
  OPERATION_TYPE_LABELS_ZH,
  failureLabel,
} from '../lib/labels';
// ---------------------------------------------------------------- 状态类型

export interface TerminalLine {
  at: string;
  source: string;
  text: string;
  isError: boolean;
}

export interface TestResultEntry {
  at: string;
  title: string;
  result: EvidenceResult;
  detail?: string;
  logRef?: string;
}

export interface SerialLogEntry {
  at: string;
  text: string;
  ok: boolean;
}

export interface ToastItem {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
  detail?: string;
}

export interface ConfirmRequest {
  title: string;
  body: string;
  danger?: boolean;
  confirmText?: string;
  onConfirm: () => void;
}

export type BottomTab = 'terminal' | 'test' | 'serial' | 'artifacts' | 'diagnostics';
export type TaskSetupMode = 'create' | 'acceptance';

export interface SteerNotice {
  reason: SteerResult['reason'] | null;
  text: string;
}

export interface DiffPanelState {
  open: boolean;
  patch: PatchView | null;
  /** 完整 unified patch 文本；主进程未提供时为 null（仅呈现文件清单+统计） */
  content: string | null;
  loading: boolean;
  unavailableReason: string | null;
}

export interface AppState {
  ready: boolean;
  appInfo: AppInfo | null;
  settings: AppSettings | null;
  project: { root: string; name: string } | null;
  threads: ThreadSummary[];
  activeThreadId: string | null;
  liveThreadId: string | null;
  conversationMode: 'empty' | 'live' | 'restored';
  restoredComplete: boolean;
  conversation: ConversationState;
  turnRunning: boolean;
  stopPhase: 'idle' | 'stopping' | 'stopped';
  steerNotice: SteerNotice | null;
  draft: string;
  engineStatus: EngineStatus;
  engineDetail: string | null;
  connectionGeneration: number;
  authStatus: AuthStatusInfo | null;
  /** 模型提供方目录状态（keyConfigured/active；不含 key 本体） */
  modelProviders: ModelProviderSummary[];
  models: EngineModelInfo[];
  selectedModel: string | null;
  tasks: TaskOverview[];
  /** profile 摘要（listProfiles 缓存；Z3 远程目标呈现用） */
  profileSummaries: import('../contracts/runner').ProfileSummary[];
  /** 已配置 SSH 凭据的变量名集合（不含值；Z3） */
  sshCredentialNames: string[];
  activeTaskId: string | null;
  devices: EnumeratedDevice[];
  pendingAuths: PendingAuthorization[];
  diagnostics: RunnerDiagnostics | null;
  /** runner 控制面可达性：null=尚未探测（不假造） */
  runnerReachable: boolean | null;
  bottomTab: BottomTab;
  settingsOpen: boolean;
  taskSetupOpen: false | TaskSetupMode;
  confirm: ConfirmRequest | null;
  terminal: TerminalLine[];
  testResults: TestResultEntry[];
  serialLogs: SerialLogEntry[];
  toast: ToastItem | null;
  busyTools: string[];
  /** 洪峰下被丢弃的可替代 UI 中间投影条数（审批/终态/工程证据不丢弃） */
  droppedEvents: number;
  /** 当前线程 token 用量（thread/tokenUsage/updated 投影；无会话为 null） */
  tokenUsage: TokenUsageSummary | null;
  diffPanel: DiffPanelState;
}

// ---------------------------------------------------------------- 动作类型

export interface AppActions {
  bootstrap(): Promise<void>;
  destroy(): void;
  refreshThreads(): Promise<void>;
  refreshTasks(): Promise<void>;
  /** profile 摘要刷新（Z3：含 sshTargets 供面板呈现） */
  refreshProfiles(): Promise<void>;
  /** SSH 板卡凭据状态刷新（Z3：仅变量名集合，不含值） */
  refreshSshCredentials(): Promise<void>;
  /** 设置板卡凭据（Z3：值不回显；保存后需重启注入 runner） */
  setSshCredential(passwordEnv: string, password: string): Promise<void>;
  /** 清除板卡凭据 */
  clearSshCredential(passwordEnv: string): Promise<void>;
  refreshTask(taskId: string): Promise<void>;
  refreshDevices(): Promise<void>;
  refreshPendingAuths(): Promise<void>;
  refreshDiagnostics(): Promise<void>;
  refreshAuth(): Promise<void>;
  /** 刷新模型提供方目录状态（keyConfigured/active） */
  refreshModelProviders(): Promise<void>;
  /** 配置提供方（key 经主进程写引擎目录 provider.env，不经过 store 持久化） */
  configureModelProvider(req: { providerId: string; apiKey: string; defaultModel?: string }): Promise<boolean>;
  /** 清除提供方 key 与激活配置 */
  clearModelProvider(providerId: string): Promise<void>;
  /** 打开提供方控制台（固定白名单外链，取 key 用） */
  openProviderConsole(providerId: string): Promise<void>;
  /** 拉取提供方模型列表（GET {base}/models，需已配置 key） */
  fetchProviderModels(providerId: string): Promise<string[]>;
  refreshModels(): Promise<void>;
  /** 认证就绪即预热引擎（免选目录/免开会话，打开客户端即可选模型、发消息） */
  prewarmEngine(): Promise<void>;
  ensureProjectSelected(): Promise<boolean>;
  openExternalTerminal(): Promise<void>;
  selectThread(threadId: string): Promise<void>;
  resumeThread(threadId: string): Promise<void>;
  startNewConversation(): Promise<void>;
  /** 会话重命名（Z1-5）：本地持久化 + 引擎在线同步；完成后刷新列表 */
  renameThread(threadId: string, name: string): Promise<void>;
  /** 会话删除（Z1-5）：删除活动会话时同时清空当前会话视图 */
  deleteThread(threadId: string): Promise<void>;
  /** 上下文压缩（Z1-5）：仅当前会话 + 引擎就绪；完成以 session/compacted 事件为准 */
  compactThread(): Promise<void>;
  /** 代码审阅（Z2B-2）：当前线程 inline 审阅未提交改动；过程走现有会话流 */
  startReview(): Promise<void>;
  setDraft(text: string): void;
  sendDraft(): Promise<boolean>;
  steerDraft(): Promise<boolean>;
  sendFromNotice(): Promise<void>;
  dismissSteerNotice(): void;
  stop(): Promise<void>;
  approve(requestId: string, decision: ApprovalDecision): Promise<void>;
  authorizeDevice(operationId: string, decision: 'approved' | 'declined'): Promise<void>;
  setActiveTask(taskId: string): void;
  createTask(req: CreateTaskRequest): Promise<boolean>;
  addAcceptanceItems(
    taskId: string,
    items: Array<{
      kind: 'executable' | 'manual';
      verifierId?: string;
      title: string;
      expected: string;
      manualRequired: boolean;
      required: boolean;
    }>,
  ): Promise<boolean>;
  adoptAcceptanceItem(taskId: string, item: AcceptanceItem): Promise<void>;
  removeAcceptanceItem(taskId: string, item: AcceptanceItem): Promise<void>;
  /** 人工验收判定（仅 manual 项；产生 manual_review 操作与 B 级证据） */
  resolveManualReview(taskId: string, itemId: string, decision: 'passed' | 'failed', note?: string): Promise<void>;
  runVerifier(taskId: string, verifierId: string | undefined, title: string): Promise<void>;
  runInspect(task: TaskOverview): Promise<void>;
  runBuild(task: TaskOverview): Promise<void>;
  runExport(task: TaskOverview): Promise<void>;
  openArtifact(path: string): Promise<void>;
  bindDevice(
    taskId: string,
    profileId: string,
    device: EnumeratedDevice,
    evidence: string,
  ): Promise<void>;
  flashArtifact(taskId: string, artifactId: string, deviceBindingId: string): Promise<void>;
  verifySerial(taskId: string, verifierId: string | undefined, deviceBindingId: string): Promise<void>;
  cancelOperation(operationId: string): Promise<void>;
  saveSettings(patch: Partial<AppSettings>): Promise<void>;
  selectModel(modelId: string): Promise<void>;
  exportDiagnostics(): Promise<void>;
  /** 打开官方登录终端（设置页）；成功后提示用户回来刷新认证状态 */
  openEngineLogin(): Promise<void>;
  setBottomTab(tab: BottomTab): void;
  setSettingsOpen(open: boolean): void;
  setTaskSetupOpen(mode: false | TaskSetupMode): void;
  requestConfirm(request: ConfirmRequest): void;
  closeConfirm(): void;
  clearToast(): void;
  openPatchDiff(patchRef: string): void;
  closePatchDiff(): void;
  applyEngineEvent(event: EngineEvent): void;
  applyRunnerEvent(event: RunnerEvent): void;
}

export type AppStore = AppState & AppActions;

export interface StoreOptions {
  /**
   * 引擎事件批量策略：默认 rAF/~50ms 合并渲染；
   * 'immediate' 逐条同步应用（测试用）。
   */
  eventBatching?:
    | 'immediate'
    | {
        intervalMs?: number;
        maxQueue?: number;
        /** 调度器注入（测试用）：控制冲刷时机 */
        schedule?: (fn: () => void) => () => void;
      };
  /**
   * patchRef → 完整 unified patch 文本。
   * 当前冻结契约未提供差异文本读取通道（见汇报"bridge 缺口"）；
   * 生产环境缺省为空 → 差异面板只呈现文件清单与统计，测试注入文本验证解析。
   */
  patchContent?: (patchRef: string) => Promise<string | null>;
}

// ---------------------------------------------------------------- 模块辅助

const MAX_TERMINAL_LINES = 500;
/** 引擎事件缓冲默认上限（settings.maxRendererEventQueue 可覆盖） */
const DEFAULT_MAX_RENDERER_QUEUE = 500;

function nowIso(): string {
  return new Date().toISOString();
}

function upsertTask(tasks: TaskOverview[], task: TaskOverview): TaskOverview[] {
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx < 0) return [...tasks, task];
  const next = [...tasks];
  next[idx] = task;
  return next;
}

function latestTaskId(tasks: TaskOverview[]): string | null {
  if (tasks.length === 0) return null;
  const sorted = [...tasks].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return sorted[0]?.id ?? null;
}

function capTerminal(lines: TerminalLine[], added: TerminalLine[]): TerminalLine[] {
  const merged = [...lines, ...added];
  return merged.length > MAX_TERMINAL_LINES ? merged.slice(merged.length - MAX_TERMINAL_LINES) : merged;
}

function detailText(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail === 'string') return detail;
  try {
    const s = JSON.stringify(detail);
    return s && s.length > 400 ? `${s.slice(0, 400)}…` : (s ?? undefined);
  } catch {
    return String(detail);
  }
}

function findDeviceBindingId(state: AppState, pending: PendingAuthorization): string | undefined {
  const task = state.tasks.find((t) => t.id === pending.taskId);
  const op = task?.operations.find((o) => o.id === pending.operationId);
  return op?.deviceBindingId;
}

const TURN_COMPLETION_LABELS_ZH: Record<'success' | 'failure' | 'interrupted', string> = {
  success: '成功',
  failure: '失败',
  interrupted: '已停止',
};

// ---------------------------------------------------------------- store 工厂

export function createAppStore(bridge: ForgeDeskBridge, options: StoreOptions = {}): StoreApi<AppStore> {
  let toastSeq = 0;
  let refreshModelsToken = 0; // R3 修复：refreshModels 并发竞态防护——只有最新调用结果可写入
  // 预热并发守卫：bootstrap 与 refreshAuth 可能同 tick 触发，防止重复 start 引发引擎无谓重启
  let prewarmInFlight = false;
  // 预热一次性标记：成功后不再预热（引擎重启走「新会话」/selectModel 重建等显式路径）
  let prewarmDone = false;
  let unsubEngine: (() => void) | null = null;
  let unsubRunner: (() => void) | null = null;
  let batcher: EventBatcher<EngineEvent> | null = null;

  const store = createStore<AppStore>()((set, get) => {
    // ---- 内部工具（闭包） ----
    const pushToast = (kind: ToastItem['kind'], text: string, detail?: string) => {
      toastSeq += 1;
      set({ toast: { id: toastSeq, kind, text, detail } });
    };
    const failureToast = (failure: FailureInfo) => {
      const detail = [failure.detail, failure.logRef ? `日志：${failure.logRef}` : undefined]
        .filter(Boolean)
        .join('\n');
      pushToast('error', `${failureLabel(failure.kind)}：${failure.message}`, detail || undefined);
    };
    const pushTerm = (source: string, text: string, isError = false) => {
      set((s) => ({ terminal: capTerminal(s.terminal, [{ at: nowIso(), source, text, isError }]) }));
    };
    const withBusy = async (key: string, fn: () => Promise<void>) => {
      set((s) => ({ busyTools: s.busyTools.includes(key) ? s.busyTools : [...s.busyTools, key] }));
      try {
        await fn();
      } finally {
        set((s) => ({ busyTools: s.busyTools.filter((k) => k !== key) }));
      }
    };
    /**
     * refreshTask 单飞状态（D-12a 根修）：SSE 事件风暴（acceptance/evidence/operation 连发）会
     * 触发多个并发 getTask；HTTP 响应乱序回达时旧快照会覆盖新状态（数据层正确、UI 停留在旧值，
     * 重跑一次即恢复——与 D-12a 症状一致）。修复：同任务同时最多一个在途 GET，飞行中到达的
     * 请求合并为一次收尾拉取；updatedAt 单调防御跨链（listTasks 全量替换）乱序。
     */
    const taskRefresh = new Map<string, { inFlight: boolean; dirty: boolean; lastAppliedUpdatedAt: string }>();

    return {
      // ---- 初始状态 ----
      ready: false,
      appInfo: null,
      settings: null,
      project: null,
      threads: [],
      activeThreadId: null,
      liveThreadId: null,
      conversationMode: 'empty',
      restoredComplete: true,
      conversation: emptyConversation(),
      turnRunning: false,
      stopPhase: 'idle',
      steerNotice: null,
      draft: '',
      engineStatus: 'stopped',
      engineDetail: null,
      connectionGeneration: 0,
      authStatus: null,
      modelProviders: [],
      models: [],
      selectedModel: null,
      tasks: [],
      profileSummaries: [],
      sshCredentialNames: [],
      activeTaskId: null,
      devices: [],
      pendingAuths: [],
      diagnostics: null,
      runnerReachable: null,
      bottomTab: 'terminal',
      settingsOpen: false,
      taskSetupOpen: false,
      confirm: null,
      terminal: [],
      testResults: [],
      serialLogs: [],
      toast: null,
      busyTools: [],
      droppedEvents: 0,
      tokenUsage: null,
      diffPanel: { open: false, patch: null, content: null, loading: false, unavailableReason: null },

      // ---- 生命周期 ----
      async bootstrap() {
        try {
          const info = await bridge.app.info();
          set({ appInfo: info });
        } catch (err) {
          pushToast('error', '读取应用信息失败', String(err));
        }
        try {
          const settings = await bridge.app.settingsGet();
          set({ settings, selectedModel: settings.defaultModel ?? null });
          batcher?.setMaxQueue(settings.maxRendererEventQueue || DEFAULT_MAX_RENDERER_QUEUE);
        } catch (err) {
          pushToast('error', '读取设置失败', String(err));
        }
        const safe = async (fn: () => Promise<void>) => {
          try {
            await fn();
          } catch (err) {
            pushToast('error', '初始化失败', String(err));
          }
        };
        // 订阅先行：预热可能在慢速刷新（设备枚举实测可达 20s+）期间就把引擎拉到 ready，
        // 晚订阅会错过 engine/status 事件，导致模型列表不刷新（认证即可用链路断裂）
        unsubEngine?.();
        unsubEngine = bridge.engine.onEvent(handleEngineEvent);
        unsubRunner?.();
        unsubRunner = bridge.runner.onEvent((ev) => get().applyRunnerEvent(ev));
        await Promise.all([
          safe(() => get().refreshThreads()),
          safe(() => get().refreshTasks()),
          safe(() => get().refreshProfiles()),
          safe(() => get().refreshSshCredentials()),
          safe(() => get().refreshDevices()),
          safe(() => get().refreshPendingAuths()),
          safe(() => get().refreshDiagnostics()),
          safe(() => get().refreshAuth()),
          // provider 目录先行完成，refreshModels 的 provider 直拉回退才能在启动时就绪
          safe(async () => {
            await get().refreshModelProviders();
            await get().refreshModels();
          }),
        ]);
        const finalStatus = bridge.engine.status();
        set({ engineStatus: finalStatus, ready: true });
        // 兜底：引擎已在刷新期间就绪（事件落在订阅前的窗口缝隙）时补拉模型/认证
        if (finalStatus === 'ready' || finalStatus === 'auth_required') {
          void get().refreshModels();
          void get().refreshAuth();
        }
        // 认证就绪（官方登录或 provider key）即预热引擎：免选目录/免开会话即可选模型、发消息
        void get().prewarmEngine();
      },

      destroy() {
        batcher?.flushPending();
        batcher?.dispose();
        batcher = null;
        unsubEngine?.();
        unsubEngine = null;
        unsubRunner?.();
        unsubRunner = null;
      },

      // ---- 数据刷新 ----
      async refreshThreads() {
        const r = await bridge.session.listThreads();
        if (!r.ok) {
          failureToast(r.failure);
          return;
        }
        set({ threads: r.value });
      },
      async refreshTasks() {
        const r = await bridge.runner.listTasks();
        if (!r.ok) {
          set({ runnerReachable: false });
          failureToast(r.failure);
          return;
        }
        const tasks = r.value.filter((t): t is TaskOverview => asTaskOverview(t) !== null);
        set((s) => ({
          runnerReachable: true,
          tasks,
          activeTaskId:
            s.activeTaskId && tasks.some((t) => t.id === s.activeTaskId) ? s.activeTaskId : latestTaskId(tasks),
        }));
      },
      async setSshCredential(passwordEnv, password) {
        const r = await bridge.app.sshCredentialSet(passwordEnv, password);
        if (r.ok) void get().refreshSshCredentials();
      },
      async clearSshCredential(passwordEnv) {
        const r = await bridge.app.sshCredentialClear(passwordEnv);
        if (r.ok) void get().refreshSshCredentials();
      },
      async refreshSshCredentials() {
        const r = await bridge.app.sshCredentialNames();
        if (r.ok) set({ sshCredentialNames: r.value });
      },
      async refreshProfiles() {
        const r = await bridge.runner.listProfiles();
        if (r.ok) set({ profileSummaries: r.value });
      },
      async refreshTask(taskId) {
        const st = taskRefresh.get(taskId) ?? { inFlight: false, dirty: false, lastAppliedUpdatedAt: '' };
        taskRefresh.set(taskId, st);
        if (st.inFlight) {
          st.dirty = true;
          return;
        }
        st.inFlight = true;
        try {
          do {
            st.dirty = false;
            const r = await bridge.runner.getTask(taskId);
            if (r.ok) {
              if (r.value.updatedAt >= st.lastAppliedUpdatedAt) {
                st.lastAppliedUpdatedAt = r.value.updatedAt;
                set((s) => ({ tasks: upsertTask(s.tasks, r.value) }));
              }
            } else {
              failureToast(r.failure);
            }
          } while (st.dirty);
        } finally {
          st.inFlight = false;
        }
      },
      async refreshDevices() {
        const r = await bridge.runner.listDevices();
        if (!r.ok) {
          failureToast(r.failure);
          return;
        }
        // 数组矫正：非数组值会令 DeviceSection map 崩溃并卸载整棵树（防御边界）
        set({ devices: Array.isArray(r.value) ? r.value : [] });
      },
      async refreshPendingAuths() {
        const r = await bridge.runner.pendingAuthorization();
        if (!r.ok) {
          failureToast(r.failure);
          return;
        }
        const list = r.value.filter((p): p is PendingAuthorization => asPendingAuthorization(p) !== null);
        set({ pendingAuths: list });
      },
      async refreshDiagnostics() {
        const r = await bridge.runner.diagnostics();
        if (!r.ok) {
          failureToast(r.failure);
          return;
        }
        set({ diagnostics: r.value });
      },
      async refreshAuth() {
        const r = await bridge.engine.authStatus();
        if (!r.ok) {
          failureToast(r.failure);
          return;
        }
        set({ authStatus: r.value });
        // 认证转 ok（官方登录完成、设置页手动刷新确认）即预热引擎——幂等守卫吸收重复调用
        if (r.value.ok) void get().prewarmEngine();
      },
      async refreshModelProviders() {
        const r = await bridge.app.listModelProviders();
        if (!r.ok) {
          failureToast(r.failure);
          return;
        }
        set({ modelProviders: r.value });
      },
      async configureModelProvider(req) {
        const r = await bridge.app.configureModelProvider(req);
        if (!r.ok) {
          failureToast(r.failure);
          return false;
        }
        pushToast('success', '模型提供方已配置', '已可在此选择该提供方的模型');
        if (req.defaultModel) await get().selectModel(req.defaultModel);
        await get().refreshModelProviders();
        void get().refreshModels();
        // 刚配好 key 即预热引擎（幂等：引擎已在运行则跳过）
        void get().prewarmEngine();
        // 引擎已在运行但未带 defaultModel（selectModel 未触发重建）时，主动重建使新提供方
        // 的 key 立即注入引擎子进程（provider 切换必须重建 adapter，见 engine-host）
        if (!req.defaultModel) {
          const s = get();
          if (s.project?.root && !s.turnRunning && bridge.engine.status() !== 'stopped') {
            const rr = await bridge.engine.start(
              s.project.root,
              s.selectedModel ? { model: s.selectedModel } : undefined,
            );
            if (rr.ok) {
              set({
                liveThreadId: rr.value.threadId,
                activeThreadId: rr.value.threadId,
                conversation: emptyConversation(),
                conversationMode: 'live',
                restoredComplete: true,
                turnRunning: false,
                stopPhase: 'idle',
              });
              void get().refreshThreads();
            }
          }
        }
        return true;
      },
      async clearModelProvider(providerId) {
        const r = await bridge.app.clearModelProvider(providerId);
        if (!r.ok) {
          failureToast(r.failure);
          return;
        }
        pushToast('info', '已清除该提供方配置', '');
        await get().refreshModelProviders();
        void get().refreshModels();
      },
      async openProviderConsole(providerId) {
        const r = await bridge.app.openProviderConsole(providerId);
        if (!r.ok) failureToast(r.failure);
      },
      async fetchProviderModels(providerId) {
        const r = await bridge.app.listProviderModels(providerId);
        if (!r.ok) {
          failureToast(r.failure);
          return [];
        }
        return r.value;
      },
      async refreshModels() {
        // R3 修复：并发调用竞态防护——只有最新调用的结果才允许写入 state
        const callToken = ++refreshModelsToken;
        const isStale = () => callToken !== refreshModelsToken;
        // 优先：活动引擎的 model/list（会话内真实可用模型）
        const r = await bridge.engine.models();
        if (isStale()) return; // 已有更新的调用完成，丢弃本次结果
        if (r.ok) {
          set((s) => ({
            models: r.value,
            selectedModel:
              s.selectedModel && r.value.some((m) => m.id === s.selectedModel)
                ? s.selectedModel
                : r.value[0]?.id ?? s.selectedModel,
          }));
          return;
        }
        // 回退：已配置 key 的激活提供方直拉 GET {base}/models
        const active = get().modelProviders.find((p) => p.active && p.keyConfigured);
        if (active) {
          const list = await bridge.app.listProviderModels(active.id);
          if (isStale()) return;
          if (list.ok && list.value.length > 0) {
            const preferred = get().settings?.defaultModel ?? get().selectedModel;
            set({
              models: list.value.map((id) => ({ id })),
              selectedModel: preferred && list.value.includes(preferred) ? preferred : list.value[0],
            });
            return;
          }
        }
        // 未认证且引擎不可用：空列表是预期状态，不弹错误
        set({ models: [] });
      },
      /**
       * 认证就绪即预热引擎（用户指令：打开客户端即可选模型/发消息，不必先选目录或开新会话）。
       * - cwd 取最近项目，无最近项目用用户主目录；用户点「新会话」选别的目录时
       *   engine.start 会重启引擎（generation 递增，协议实测支持）；
       * - 认证缺失时不预热（认证引导横幅负责引导配置）。
       */
      async prewarmEngine() {
        if (prewarmInFlight || prewarmDone) return;
        if (bridge.engine.status() !== 'stopped') return;
        const s = get();
        const providerReady = s.modelProviders.some((p) => p.active && p.keyConfigured);
        if (!providerReady && !s.authStatus?.ok) return;
        const root =
          s.settings?.recentProjects?.[0]?.projectRoot?.trim() ||
          s.appInfo?.homeDir?.trim() ||
          s.appInfo?.dataDir;
        if (!root) return;
        prewarmInFlight = true;
        try {
          // 预热不绑定模型：settings.defaultModel 可能是陈旧残留（实测 deepseek-chat 配
          // ChatGPT 认证会让线程 400 systemError"会话不可继续"）；线程用引擎默认模型，
          // 用户在下拉选择时经 selectModel 即时重建线程绑定所选模型
          const r = await bridge.engine.start(root);
          if (r.ok) {
            prewarmDone = true;
            // 同步 project 状态：顶栏显示项目名，「新会话」在同 root 直接复用引擎开新 thread
            set({ project: { root, name: root.split(/[\\/]/).filter(Boolean).pop() ?? root } });
            pushToast('info', '引擎已就绪', '可直接选择模型并发送消息；点「新会话」可切换项目目录');
            // start 返回即引擎已握手完成：直接补拉模型列表（不依赖 engine/status 事件到达）
            void get().refreshModels();
          } else {
            // 预热失败不弹错误打断用户（引擎状态仍如实展示在顶栏/横幅）
            console.warn('[store] 引擎预热失败:', r.failure?.message);
          }
        } finally {
          prewarmInFlight = false;
        }
      },

      // ---- 项目 ----
      async ensureProjectSelected() {
        const r = await bridge.app.ensureProject();
        if (!r.ok) {
          failureToast(r.failure);
          return false;
        }
        set({ project: { root: r.value.projectRoot, name: r.value.name } });
        pushToast('info', `已登记项目：${r.value.name}`);
        return true;
      },
      async openExternalTerminal() {
        const root = get().project?.root;
        if (!root) {
          pushToast('error', '尚未选择项目目录');
          return;
        }
        const r = await bridge.app.openExternalTerminal(root);
        if (!r.ok) failureToast(r.failure);
      },

      // ---- 会话 ----
      async selectThread(threadId) {
        set({ activeThreadId: threadId });
        const r = await bridge.session.loadThread(threadId);
        if (!r.ok) {
          failureToast(r.failure);
          return;
        }
        // R2 修复：竞态防护——loadThread 响应到达时，如果用户已切换到另一个会话，丢弃本响应
        if (get().activeThreadId !== threadId) return;
        const isLive = get().liveThreadId === threadId;
        set((s) => ({
          conversation: isLive ? s.conversation : storedToConversation(r.value.messages),
          restoredComplete: isLive ? true : r.value.complete,
          conversationMode: isLive ? 'live' : 'restored',
        }));
      },
      async resumeThread(threadId) {
        const thread = get().threads.find((t) => t.threadId === threadId);
        if (!thread) {
          pushToast('error', '会话线程不存在');
          return;
        }
        const model = get().selectedModel;
        const r = await bridge.engine.start(thread.projectRoot, {
          resumeThreadId: threadId,
          ...(model ? { model } : {}),
        });
        if (!r.ok) {
          failureToast(r.failure);
          void get().refreshAuth();
          return;
        }
        set({
          liveThreadId: r.value.threadId,
          activeThreadId: threadId,
          conversation: emptyConversation(),
          conversationMode: 'live',
          restoredComplete: true,
          turnRunning: false,
          stopPhase: 'idle',
        });
        pushToast('info', '已恢复会话，引擎连接就绪');
        void get().refreshModels();
        void get().refreshAuth();
      },
      async startNewConversation() {
        let root = get().project?.root;
        if (!root) {
          const ok = await get().ensureProjectSelected();
          if (!ok) return;
          root = get().project?.root;
          if (!root) return;
        }
        const model = get().selectedModel;
        const r = await bridge.engine.start(root, model ? { model } : undefined);
        if (!r.ok) {
          failureToast(r.failure);
          void get().refreshAuth();
          return;
        }
        set({
          liveThreadId: r.value.threadId,
          activeThreadId: r.value.threadId,
          conversation: emptyConversation(),
          conversationMode: 'live',
          restoredComplete: true,
          turnRunning: false,
          stopPhase: 'idle',
        });
        void get().refreshThreads();
        // 会话启动后引擎就绪：模型列表与认证状态随之可拉取（设置页下拉自动可用）
        void get().refreshModels();
        void get().refreshAuth();
      },

      // ---- 会话管理（Z1-5）----
      async renameThread(threadId, name) {
        const r = await bridge.session.renameThread(threadId, name);
        if (!r.ok) {
          failureToast(r.failure);
          return;
        }
        void get().refreshThreads();
      },
      async deleteThread(threadId) {
        const r = await bridge.session.deleteThread(threadId);
        if (!r.ok) {
          failureToast(r.failure);
          return;
        }
        // 删除的是当前查看/进行中的会话：清空会话视图，不残留已删内容
        if (get().activeThreadId === threadId || get().liveThreadId === threadId) {
          set({
            activeThreadId: null,
            liveThreadId: null,
            conversation: emptyConversation(),
            conversationMode: 'empty',
            restoredComplete: true,
            turnRunning: false,
            stopPhase: 'idle',
            tokenUsage: null,
          });
        }
        void get().refreshThreads();
      },
      async compactThread() {
        const threadId = get().liveThreadId;
        if (!threadId) {
          failureToast({ kind: 'connection_failure', message: '无进行中的会话，无法压缩上下文', occurredAt: nowIso() });
          return;
        }
        if (get().turnRunning) {
          failureToast({ kind: 'permission_denied', message: '回合进行中，请等待结束后再压缩上下文', occurredAt: nowIso() });
          return;
        }
        const r = await bridge.session.compactThread(threadId);
        if (!r.ok) failureToast(r.failure); // 完成（session/compacted）走事件流提示
      },
      async startReview() {
        if (!get().liveThreadId) {
          failureToast({ kind: 'connection_failure', message: '无进行中的会话，无法启动代码审阅', occurredAt: nowIso() });
          return;
        }
        if (get().turnRunning) {
          failureToast({ kind: 'permission_denied', message: '回合进行中，请等待结束后再审阅', occurredAt: nowIso() });
          return;
        }
        // 乐观置待归属标记：审阅回合的 turn/started 可能先于请求返回到达；
        // 失败即清除（下一个 turn/started 不会被误标为审阅）
        set((s) => ({ conversation: { ...s.conversation, reviewPending: true } }));
        const r = await bridge.engine.review();
        if (!r.ok) {
          set((s) => ({ conversation: { ...s.conversation, reviewPending: false } }));
          failureToast(r.failure); // 审阅过程以普通会话事件回流
        }
      },

      // ---- 输入 / 回合 ----
      setDraft(text) {
        set({ draft: text });
      },
      async sendDraft() {
        const text = get().draft.trim();
        if (!text) return false;
        // R2 修复：在飞守卫——IPC 往返期间禁止重复发送（双击/Enter+click 可发两次）
        if (get().turnRunning) return false;
        set({ draft: '' }); // R2 修复：同步清空草稿——await 后清空会丢弃用户在等待期间输入的内容
        const r = await bridge.engine.send(text);
        if (!r.ok) {
          set({ draft: text }); // 失败时恢复草稿
          failureToast(r.failure);
          return false;
        }
        // 用户主动发送的回合不归属审阅（清除 startReview 的待归属标记）
        set((s) => ({
          turnRunning: true,
          stopPhase: 'idle',
          conversation: { ...s.conversation, reviewPending: false },
        }));
        return true;
      },
      async steerDraft() {
        const text = get().draft.trim();
        if (!text) return false;
        // R3 修复：同步清空草稿——await 后清空会丢弃用户在等待期间输入的新内容
        set({ draft: '' });
        const r = await bridge.engine.steer(text);
        if (r.ok && r.value.delivered) {
          set((s) => ({
            conversation: appendSteerMessage(s.conversation, text, nowIso()),
          }));
          return true;
        }
        // 未送达：恢复草稿、给出原因，绝不静默重发
        set({ draft: text });
        if (!r.ok) failureToast(r.failure);
        set({ steerNotice: { reason: r.ok ? (r.value.reason ?? null) : null, text } });
        return false;
      },
      async sendFromNotice() {
        const notice = get().steerNotice;
        if (!notice) return;
        const r = await bridge.engine.send(notice.text);
        if (!r.ok) {
          failureToast(r.failure);
          return;
        }
        // R2 修复：与 sendDraft 一致——用户主动发送不归属审阅
        set((s) => ({ steerNotice: null, draft: '', turnRunning: true, stopPhase: 'idle',
          conversation: { ...s.conversation, reviewPending: false } }));
      },
      dismissSteerNotice() {
        set({ steerNotice: null });
      },
      async stop() {
        if (!get().turnRunning || get().stopPhase === 'stopping') return;
        set({ stopPhase: 'stopping' });
        const r = await bridge.engine.interrupt();
        if (!r.ok) {
          set({ stopPhase: 'idle' });
          failureToast(r.failure);
        }
        // 两段式第二段（已停止）由 turn/completed(interrupted) 事件驱动
      },

      // ---- 审批 ----
      async approve(requestId, decision) {
        const r = await bridge.engine.approve(requestId, decision);
        if (!r.ok) failureToast(r.failure);
        // 处理结果以 approval/resolved 事件为准
      },
      async authorizeDevice(operationId, decision) {
        const pending = get().pendingAuths.find((p) => p.operationId === operationId);
        if (!pending) {
          pushToast('error', '待授权操作不存在（可能已被处理）');
          void get().refreshPendingAuths();
          return;
        }
        const bindingId = findDeviceBindingId(get(), pending);
        const confirmedScope: { taskId: string; artifactSha256?: string; deviceBindingId?: string } = {
          taskId: pending.taskId,
        };
        if (pending.artifactSha256) confirmedScope.artifactSha256 = pending.artifactSha256;
        if (bindingId) confirmedScope.deviceBindingId = bindingId;
        const r = await bridge.runner.authorize(operationId, decision, confirmedScope);
        if (!r.ok) {
          failureToast(r.failure);
          return;
        }
        pushToast('info', decision === 'approved' ? '已批准设备授权' : '已拒绝设备授权');
        void get().refreshPendingAuths();
      },

      // ---- 任务与验收 ----
      setActiveTask(taskId) {
        set({ activeTaskId: taskId });
      },
      async createTask(req) {
        const r = await bridge.runner.createTask(req);
        if (!r.ok) {
          failureToast(r.failure);
          return false;
        }
        const task = r.value;
        set((s) => ({ tasks: upsertTask(s.tasks, task), activeTaskId: task.id, taskSetupOpen: false }));
        pushToast('success', `任务已创建：${task.title}`);
        return true;
      },
      async addAcceptanceItems(taskId, items) {
        // runner 的 updateAcceptance 是全量替换语义（未提交的项会被删除）——
        // 必须组装"现有项 + 新增项"整体提交；现有项不传 status（由 runner 保留真实状态）
        const existing = get().tasks.find((t) => t.id === taskId)?.acceptance ?? [];
        const payload = [
          ...existing.map((a) => ({ id: a.id, kind: a.kind, verifierId: a.verifierId, title: a.title, expected: a.expected, manualRequired: a.manualRequired, required: a.required })),
          ...items,
        ];
        const r = await bridge.runner.updateAcceptance(taskId, payload);
        if (!r.ok) {
          failureToast(r.failure);
          return false;
        }
        // runner 返回最新 AcceptanceItem[]——合并进现有任务
        const acceptance = r.value;
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, acceptance, updatedAt: new Date().toISOString() } : t)),
          taskSetupOpen: false,
        }));
        pushToast('success', '验收单已更新');
        return true;
      },
      async adoptAcceptanceItem(taskId, item) {
        // 全量替换语义：现有项（排除被采纳项）+ 该项以 pending 计入验收（采纳即生效）
        const existing = (get().tasks.find((t) => t.id === taskId)?.acceptance ?? []).filter((a) => a.id !== item.id);
        const r = await bridge.runner.updateAcceptance(taskId, [
          ...existing.map((a) => ({ id: a.id, kind: a.kind, verifierId: a.verifierId, title: a.title, expected: a.expected, manualRequired: a.manualRequired, required: a.required })),
          { id: item.id, kind: item.kind, verifierId: item.verifierId, title: item.title, expected: item.expected, manualRequired: item.manualRequired, required: true, status: 'pending' },
        ]);
        if (!r.ok) {
          failureToast(r.failure);
          return;
        }
        // runner 返回最新 AcceptanceItem[]——合并进现有任务（采纳：proposed → 计入验收）
        const adopted = r.value;
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, acceptance: adopted, updatedAt: new Date().toISOString() } : t)),
        }));
      },
      async removeAcceptanceItem(taskId, item) {
        // 全量替换语义：提交"除该项外的全部现有项"即删除（旧 remove 字段 runner 不消费，废弃）
        const rest = (get().tasks.find((t) => t.id === taskId)?.acceptance ?? []).filter((a) => a.id !== item.id);
        const r = await bridge.runner.updateAcceptance(
          taskId,
          rest.map((a) => ({ id: a.id, kind: a.kind, verifierId: a.verifierId, title: a.title, expected: a.expected, manualRequired: a.manualRequired, required: a.required })),
        );
        if (!r.ok) {
          failureToast(r.failure);
          return;
        }
        // runner 返回最新 AcceptanceItem[]——合并进现有任务（移除后）
        const after = r.value;
        set((s) => ({
          tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, acceptance: after, updatedAt: new Date().toISOString() } : t)),
        }));
      },
      async resolveManualReview(taskId, itemId, decision, note) {
        const r = await bridge.runner.manualReview(taskId, itemId, decision, note);
        if (!r.ok) {
          failureToast(r.failure);
          return;
        }
        // runner 返回的是该任务最新 AcceptanceItem[]（非 TaskOverview）——合并进现有任务，别当任务 upsert
        const acceptance = r.value;
        set((s) => ({
          tasks: s.tasks.map((t) =>
            t.id === taskId ? { ...t, acceptance, updatedAt: new Date().toISOString() } : t,
          ),
        }));
        pushToast(decision === 'passed' ? 'success' : 'info', `人工验收已记录：${decision === 'passed' ? '通过' : '不通过'}`, '已写入操作历史与证据链（B 级）');
      },

      // ---- 工程操作（runner:invoke，白名单七工具） ----
      async runVerifier(taskId, verifierId, title) {
        if (!verifierId) {
          pushToast('error', '该验收项未配置 verifierId，无法执行验证');
          return;
        }
        await withBusy(`test:${verifierId}`, async () => {
          const r = await bridge.runner.invoke('engineering.test', { taskId, verifierId });
          if (!r.ok) {
            failureToast(r.failure);
            return;
          }
          const payload = parseInvokePayload(r.value);
          if (!payload.ok) {
            pushToast(
              'error',
              `验证未通过判定：${failureLabel(payload.kind)}`,
              [payload.message, payload.detail].filter(Boolean).join('\n'),
            );
            return;
          }
          const out = asTestOutput(payload.data);
          const result: EvidenceResult = out?.result ?? 'inconclusive';
          set((s) => ({
            testResults: [
              ...s.testResults,
              {
                at: nowIso(),
                title: title || `验收验证 ${verifierId}`,
                result,
                detail: detailText(out?.detail),
                logRef: out?.logRef,
              },
            ],
          }));
          pushTerm(`测试·${verifierId}`, `结果：${EVIDENCE_LABELS[result]}`, result === 'failed');
          pushToast(
            result === 'passed' ? 'success' : result === 'failed' ? 'error' : 'info',
            `验证${EVIDENCE_LABELS[result]}（${verifierId}）`,
          );
          // D-12a 加固：runner 写入验证结果与面板读取存在竞态，即时刷新 + 2s 后静默补刷一次
          await get().refreshTask(taskId);
          setTimeout(() => {
            void get().refreshTask(taskId);
          }, 2000);
        });
      },
      async runInspect(task) {
        await withBusy('inspect', async () => {
          const r = await bridge.runner.invoke('engineering.inspect', {
            taskId: task.id,
            profileId: task.profileId,
          });
          if (!r.ok) {
            failureToast(r.failure);
            return;
          }
          const payload = parseInvokePayload(r.value);
          if (!payload.ok) {
            pushToast('error', `环境检查失败：${failureLabel(payload.kind)}`, [payload.message, payload.detail].filter(Boolean).join('\n'));
            return;
          }
          const out = asInspectOutput(payload.data);
          const missing = out?.missing ?? [];
          for (const tool of out?.toolchain ?? []) {
            pushTerm(
              '环境检查',
              `${tool.tool}：${tool.available ? `可用（${tool.version ?? '版本未知'}）` : `缺失${tool.missingHint ? `——${tool.missingHint}` : ''}`}`,
              !tool.available,
            );
          }
          pushToast(
            missing.length === 0 ? 'success' : 'info',
            missing.length === 0 ? '环境检查完成：工具链齐备' : `环境检查完成：缺失 ${missing.length} 项`,
            missing.length ? missing.join('\n') : undefined,
          );
          void get().refreshTask(task.id);
        });
      },
      async runBuild(task) {
        await withBusy('build', async () => {
          const r = await bridge.runner.invoke('engineering.build', {
            taskId: task.id,
            profileRevision: task.profileRevision,
          });
          if (!r.ok) {
            failureToast(r.failure);
            return;
          }
          const payload = parseInvokePayload(r.value);
          if (!payload.ok) {
            pushToast('error', `构建失败：${failureLabel(payload.kind)}`, [payload.message, payload.detail].filter(Boolean).join('\n'));
            void get().refreshTask(task.id);
            return;
          }
          const out = asBuildOutput(payload.data);
          pushTerm('构建', `构建完成：buildId=${out?.buildId ?? '未知'} 产物=${out?.artifactPath ?? '未知'}`);
          pushToast('success', `构建完成（buildId：${out?.buildId ?? '未知'}）`);
          void get().refreshTask(task.id);
        });
      },
      async runExport(task) {
        await withBusy('export', async () => {
          const r = await bridge.runner.invoke('engineering.export', { taskId: task.id });
          if (!r.ok) {
            failureToast(r.failure);
            return;
          }
          const payload = parseInvokePayload(r.value);
          if (!payload.ok) {
            pushToast('error', `导出失败：${failureLabel(payload.kind)}`, [payload.message, payload.detail].filter(Boolean).join('\n'));
            return;
          }
          const out = asExportOutput(payload.data);
          if (out?.bundlePath) {
            pushTerm('交付导出', `交付包已生成：${out.bundlePath}`);
            const open = await bridge.app.openPath(out.bundlePath, 'export');
            if (!open.ok) pushToast('error', `交付包已生成但打开失败：${open.failure.message}`, out.bundlePath);
            else pushToast('success', '交付包已生成', out.bundlePath);
          } else {
            pushToast('info', '导出操作已受理', detailText(payload.data));
          }
          void get().refreshTask(task.id);
        });
      },
      async openArtifact(path) {
        const r = await bridge.app.openPath(path, 'artifact');
        if (!r.ok) failureToast(r.failure);
      },
      async bindDevice(taskId, profileId, device, evidence) {
        const trimmed = evidence.trim();
        if (!trimmed) {
          pushToast('error', '请先填写身份证据：如何确认这块板就是目标板');
          return;
        }
        await withBusy(`bind:${device.identity.usbVid}:${device.identity.usbPid}`, async () => {
          const r = await bridge.runner.invoke('device.bind', {
            taskId,
            profileId,
            identity: {
              usbVid: device.identity.usbVid,
              usbPid: device.identity.usbPid,
              probeSerial: device.identity.probeSerial,
              chipTarget: device.identity.chipTarget,
              serialPort: device.identity.serialPort,
            },
            identityEvidence: trimmed,
          });
          if (!r.ok) {
            failureToast(r.failure);
            return;
          }
          const payload = parseInvokePayload(r.value);
          if (!payload.ok) {
            pushToast('error', `设备绑定失败：${failureLabel(payload.kind)}`, [payload.message, payload.detail].filter(Boolean).join('\n'));
            return;
          }
          const rec = asRecord(payload.data);
          const bindingId = typeof rec?.deviceBindingId === 'string' ? rec.deviceBindingId : undefined;
          pushTerm('设备绑定', bindingId ? `绑定已提交：${bindingId}` : '绑定操作已提交');
          pushToast('info', '设备绑定操作已提交');
          void get().refreshTask(taskId);
          void get().refreshPendingAuths();
        });
      },
      async flashArtifact(taskId, artifactId, deviceBindingId) {
        /* R2-BUG5 修复：加时间戳分量防止永久去重——同一产物+设备的重新烧录（如失败后重试
         * 或外部擦板后重烧）不再被旧结果拦截。60s 窗口内仍去重（快速双击防抖） */
        const requestKey = `gui-${taskId}-${artifactId}-${deviceBindingId}-${Math.floor(Date.now() / 60000)}`;
        await withBusy(`flash:${artifactId}`, async () => {
          const r = await bridge.runner.invoke('device.flash', {
            taskId,
            artifactId,
            deviceBindingId,
            requestKey,
          });
          if (!r.ok) {
            failureToast(r.failure);
            return;
          }
          const payload = parseInvokePayload(r.value);
          if (!payload.ok) {
            pushToast(
              'error',
              `烧录未执行：${failureLabel(payload.kind)}`,
              [payload.message, payload.detail].filter(Boolean).join('\n'),
            );
            void get().refreshPendingAuths();
            return;
          }
          const rec = asRecord(payload.data);
          const status = typeof rec?.status === 'string' ? rec.status : 'unknown';
          const summary = typeof rec?.toolSummary === 'string' ? rec.toolSummary : '烧录操作已受理';
          pushTerm('固件烧录', `${summary}（status=${status}）`);
          pushToast('info', '烧录操作已受理', `状态：${status}`);
          void get().refreshTask(taskId);
          void get().refreshPendingAuths();
        });
      },
      async verifySerial(taskId, verifierId, deviceBindingId) {
        if (!verifierId) {
          pushToast('error', '缺少串口验证定义（verifierId），无法执行');
          return;
        }
        await withBusy(`verify:${deviceBindingId}`, async () => {
          const r = await bridge.runner.invoke('device.verify', { taskId, verifierId, deviceBindingId });
          if (!r.ok) {
            failureToast(r.failure);
            return;
          }
          const payload = parseInvokePayload(r.value);
          if (!payload.ok) {
            pushToast('error', `串口验证失败：${failureLabel(payload.kind)}`, [payload.message, payload.detail].filter(Boolean).join('\n'));
            return;
          }
          const out = asVerifyOutput(payload.data);
          const nonceOk = out?.nonceMatch ?? false;
          const buildOk = out?.buildIdMatch ?? false;
          set((s) => ({
            serialLogs: [
              ...s.serialLogs,
              {
                at: nowIso(),
                text: `nonce匹配=${nonceOk} buildId匹配=${buildOk}${out?.buildId ? ` buildId=${out.buildId}` : ''}\n${out?.responsePreview ?? ''}`,
                ok: nonceOk && buildOk,
              },
            ],
          }));
          pushTerm(
            '设备验证',
            `nonce=${nonceOk ? '匹配' : '不匹配'} buildId=${buildOk ? '匹配' : '不匹配'}`,
            !(nonceOk && buildOk),
          );
          pushToast(
            nonceOk && buildOk ? 'success' : 'error',
            nonceOk && buildOk ? '串口验证通过' : '串口验证未通过（真实结果以证据为准）',
          );
          void get().refreshTask(taskId);
        });
      },
      async cancelOperation(operationId) {
        const r = await bridge.runner.cancel(operationId);
        if (!r.ok) {
          failureToast(r.failure);
          return;
        }
        pushToast('info', '已请求取消操作（副作用发生前可取消）');
        void get().refreshTasks();
      },

      // ---- 设置 / 杂项 ----
      async saveSettings(patch) {
        try {
          const settings = await bridge.app.settingsSet(patch);
          set((s) => ({ settings, selectedModel: patch.defaultModel ?? s.selectedModel }));
          pushToast('success', '设置已保存');
        } catch (err) {
          pushToast('error', '保存设置失败', String(err));
        }
      },
      async selectModel(modelId) {
        set({ selectedModel: modelId });
        // 同步每厂商模型记忆：激活提供方存在时，记住该厂商本次选择（切换厂商时恢复）
        const activeProvider = get().modelProviders.find((p) => p.active);
        const memoryPatch = activeProvider
          ? { providerModelMemory: { ...(get().settings?.providerModelMemory ?? {}), [activeProvider.id]: modelId } }
          : undefined;
        await get().saveSettings({ defaultModel: modelId, ...memoryPatch });
        // 线程模型在 thread/start 时固定，会话中换模型必须重建线程——引擎非 stopped 且无进行中
        // 回合时，同项目根以新模型重建（等价于一次静默的"新会话"）；
        // 预热线程不带模型（引擎默认），本路径是用户选择生效的唯一入口
        const s = get();
        if (s.project?.root && !s.turnRunning && bridge.engine.status() !== 'stopped') {
          const r = await bridge.engine.start(s.project.root, { model: modelId });
          if (!r.ok) {
            console.warn('[store] 模型切换重建线程失败:', r.failure?.message);
            return;
          }
          set({
            liveThreadId: r.value.threadId,
            activeThreadId: r.value.threadId,
            conversation: emptyConversation(),
            conversationMode: 'live',
            restoredComplete: true,
            turnRunning: false,
            stopPhase: 'idle',
          });
          void get().refreshThreads();
        }
      },
      async exportDiagnostics() {
        const r = await bridge.app.exportDiagnostics();
        if (!r.ok) {
          failureToast(r.failure);
          return;
        }
        pushToast('success', '诊断已导出', r.value.path);
        const open = await bridge.app.openPath(r.value.path, 'log');
        if (!open.ok) pushToast('error', `打开诊断文件失败：${open.failure.message}`);
      },
      async openEngineLogin() {
        const r = await bridge.app.openEngineLogin();
        if (!r.ok) {
          failureToast(r.failure);
          return;
        }
        pushToast('info', '已打开官方登录终端', '在终端完成登录后，回到设置页点击「刷新认证状态」');
      },
      setBottomTab(tab) {
        set({ bottomTab: tab });
      },
      setSettingsOpen(open) {
        set({ settingsOpen: open });
      },
      setTaskSetupOpen(mode) {
        set({ taskSetupOpen: mode });
      },
      requestConfirm(request) {
        set({ confirm: request });
      },
      closeConfirm() {
        set({ confirm: null });
      },
      clearToast() {
        set({ toast: null });
      },

      // ---- 代码差异面板 ----
      openPatchDiff(patchRef) {
        const patch = get().conversation.messages
          .flatMap((m) => m.patches)
          .find((p) => p.patchRef === patchRef);
        if (!patch) {
          pushToast('error', '未找到该补丁引用的文件清单', patchRef);
          return;
        }
        set({ diffPanel: { open: true, patch, content: null, loading: true, unavailableReason: null } });
        if (!options.patchContent) {
          // 契约缺口：bridge 暂无 patchRef → 差异文本通道；只呈现文件清单与统计
          set({
            diffPanel: {
              open: true,
              patch,
              content: null,
              loading: false,
              unavailableReason: '主进程尚未提供完整差异文本（等待 bridge 增补 patchRef 读取通道）',
            },
          });
          return;
        }
        void options
          .patchContent(patchRef)
          .then((content) => {
            const cur = get().diffPanel;
            if (!cur.open || cur.patch?.patchRef !== patchRef) return;
            set({
              diffPanel: {
                open: true,
                patch,
                content,
                loading: false,
                unavailableReason: content ? null : '差异文本不可用',
              },
            });
          })
          .catch((err) => {
            const cur = get().diffPanel;
            if (!cur.open || cur.patch?.patchRef !== patchRef) return;
            set({
              diffPanel: {
                open: true,
                patch,
                content: null,
                loading: false,
                unavailableReason: `读取差异文本失败：${String(err)}`,
              },
            });
          });
      },
      closePatchDiff() {
        set((s) => ({ diffPanel: { ...s.diffPanel, open: false } }));
      },

      // ---- 事件投影 ----
      applyEngineEvent(event: EngineEvent) {
        const s = get();
        if (event.type === 'engine/status') {
          set({
            engineStatus: event.status,
            engineDetail: event.detail ?? null,
            connectionGeneration: event.connectionGeneration,
          });
          // 引擎就绪后模型列表才可拉取（model/list 需活动引擎）——登录/启动后自动刷新，
          // 修复"登录后模型下拉仍显示不可用"
          if (event.status === 'ready' || event.status === 'auth_required') {
            void get().refreshModels();
            void get().refreshAuth();
          }
          return;
        }
        // token 用量（线程累计口径）：独立状态位，不进会话消息流
        if (event.type === 'usage/updated') {
          set({ tokenUsage: event.usage, connectionGeneration: event.connectionGeneration });
          return;
        }
        const conv = applyEngineEventToConversation(s.conversation, event);
        const patch: Partial<AppState> = { conversation: conv, connectionGeneration: event.connectionGeneration };
        const term: TerminalLine[] = [];
        if (event.type === 'session/started') {
          patch.liveThreadId = event.threadId;
          patch.activeThreadId = event.threadId;
          patch.conversationMode = 'live';
          // 会话切换即清上一线程的累计用量（新线程未发 tokenUsage/updated 前不显示旧值）
          patch.tokenUsage = null;
        }
        if (event.type === 'turn/started') {
          patch.turnRunning = true;
          patch.stopPhase = 'idle';
        }
        if (event.type === 'session/compacted') {
          term.push({ at: nowIso(), source: '会话', text: '上下文压缩完成（历史消息已摘要化）', isError: false });
          // 压缩改变 thread 服务端状态（消息数/活动时间）——刷新会话列表
          void get().refreshThreads();
        }
        if (event.type === 'turn/completed') {
          patch.turnRunning = false;
          patch.stopPhase = event.status === 'interrupted' ? 'stopped' : 'idle';
          term.push({
            at: nowIso(),
            source: '回合',
            text: `回合结束：${TURN_COMPLETION_LABELS_ZH[event.status]}${event.detail ? `（${event.detail}）` : ''}`,
            isError: event.status === 'failure',
          });
        }
        if (event.type === 'tool/called') {
          term.push({ at: nowIso(), source: `工具·${event.tool}`, text: event.argsPreview, isError: false });
        }
        if (event.type === 'tool/output') {
          term.push({
            at: nowIso(),
            source: `输出·${event.callId}`,
            text: event.outputPreview,
            isError: event.isError,
          });
        }
        if (event.type === 'error') {
          term.push({
            at: nowIso(),
            source: '引擎错误',
            text: `${failureLabel(event.code)}：${event.message}${event.recoverable ? '' : '（不可恢复）'}`,
            isError: true,
          });
        }
        if (term.length > 0) patch.terminal = capTerminal(s.terminal, term);
        set(patch);
        if (event.type === 'session/started') void get().refreshThreads();
      },

      applyRunnerEvent(event: RunnerEvent) {
        const s = get();
        switch (event.type) {
          case 'task/updated': {
            const task = asTaskOverview(event.payload);
            if (task) set({ tasks: upsertTask(s.tasks, task) });
            else void get().refreshTasks();
            return;
          }
          case 'acceptance/updated':
            if (event.taskId) void get().refreshTask(event.taskId);
            return;
          case 'operation/updated': {
            const op = asOperation(event.payload);
            if (op) {
              if (op.status === 'succeeded' || op.status === 'failed' || op.status === 'unknown') {
                const label = OPERATION_TYPE_LABELS_ZH[op.type];
                const text =
                  op.status === 'failed' && op.failure
                    ? `${failureLabel(op.failure.kind)}：${op.failure.message}`
                    : (op.resultSummary ?? `操作${op.status === 'succeeded' ? '成功' : '结果未知'}`);
                set({ terminal: capTerminal(s.terminal, [{ at: nowIso(), source: label, text, isError: op.status === 'failed' }]) });
              }
              void get().refreshTask(op.taskId);
              return;
            }
            if (event.taskId) void get().refreshTask(event.taskId);
            return;
          }
          case 'evidence/created':
            if (event.taskId) void get().refreshTask(event.taskId);
            return;
          case 'authorization/pending':
          case 'authorization/resolved':
            void get().refreshPendingAuths();
            return;
          case 'device/updated':
            void get().refreshDevices();
            return;
          case 'diagnostics/updated':
            void get().refreshDiagnostics();
            return;
          case 'runner/ready':
            void get().refreshTasks();
            void get().refreshDiagnostics();
            return;
        }
      },
    };
  });

  function handleEngineEvent(event: EngineEvent): void {
    if (batcher) batcher.push(event);
    else store.getState().applyEngineEvent(event);
  }

  if (options.eventBatching !== 'immediate') {
    const batching = options.eventBatching ?? {};
    batcher = new EventBatcher<EngineEvent>(
      (events) => {
        for (const e of events) store.getState().applyEngineEvent(e);
      },
      {
        intervalMs: batching.intervalMs,
        maxQueue: batching.maxQueue ?? DEFAULT_MAX_RENDERER_QUEUE,
        schedule: batching.schedule,
        // 洪峰下只淘汰可替代的 UI 中间投影并计数；审批/终态等关键事件不淘汰
        isDroppable: isDroppableEngineEvent,
        onDropped: () => {
          const n = store.getState().droppedEvents + 1;
          store.setState({ droppedEvents: n });
        },
      },
    );
  }

  return store;
}
