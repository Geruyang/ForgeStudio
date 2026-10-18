/**
 * ForgeDesk Electron IPC 契约：preload 白名单桥接 API。
 * 渲染进程只能通过 window.forgedesk.* 调用；通道名冻结，主进程按此注册。
 * 凭证、任意命令执行、文件系统直通一律不暴露。
 * 冻结契约 v1 —— 集成负责人维护。
 */
import type {
  ApprovalDecision,
  ApprovalRequestView,
  AuthStatusInfo,
  EngineEvent,
  EngineModelInfo,
  EngineStatus,
  StoredMessage,
  SteerResult,
  ThreadSummary,
} from './engine.ts';
import type {
  CreateTaskRequest,
  PendingAuthorization,
  ProfileSummary,
  RunnerDiagnostics,
  RunnerEvent,
} from './runner-api.ts';
import type { AcceptanceItem, TaskOverview } from './engineering.ts';
import type { EnumeratedDevice } from './device.ts';
import type { OpResult } from './common.ts';

// ---------------------------------------------------------------------------
// 通道命名（invoke: 请求-响应；on: 事件订阅）
// ---------------------------------------------------------------------------

export const IPC = {
  engine: {
    start: 'engine:start',
    send: 'engine:send',
    steer: 'engine:steer',
    interrupt: 'engine:interrupt',
    /** 代码审阅（Z2B-2）：当前线程 inline 启动 review/start（uncommittedChanges）；过程走现有会话流 */
    review: 'engine:review',
    approve: 'engine:approve',
    models: 'engine:models',
    authStatus: 'engine:auth-status',
    status: 'engine:status',
    event: 'engine:event', // on
  },
  session: {
    listThreads: 'session:list-threads',
    loadThread: 'session:load-thread',
    /** 补丁全文读取（patchRef → unified diff 文本；主进程从引擎存储目录读取） */
    loadPatch: 'session:load-patch',
    /** 会话重命名（Z1-5）：本地持久化 + 引擎在线时同步 thread/name/set */
    renameThread: 'session:rename-thread',
    /** 会话删除（Z1-5）：本地会话文件清理 + 当前线程时同步 thread/delete */
    deleteThread: 'session:delete-thread',
    /** 上下文压缩（Z1-5）：thread/compact/start，完成以 session/compacted 事件为准 */
    compactThread: 'session:compact-thread',
  },
  runner: {
    listTasks: 'runner:list-tasks',
    getTask: 'runner:get-task',
    listProfiles: 'runner:list-profiles',
    createTask: 'runner:create-task',
    updateAcceptance: 'runner:update-acceptance',
    manualReview: 'runner:manual-review',
    invoke: 'runner:invoke', // 单一入口 + tool 名白名单（见 RunnerInvokeTool）
    cancel: 'runner:cancel',
    pendingAuthorization: 'runner:pending-authorization',
    authorize: 'runner:authorize',
    listDevices: 'runner:list-devices',
    diagnostics: 'runner:diagnostics',
    event: 'runner:event', // on
  },
  app: {
    info: 'app:info',
    settingsGet: 'app:settings-get',
    settingsSet: 'app:settings-set',
    openPath: 'app:open-path', // 白名单目录内路径（产物/日志/导出包）
    openExternalTerminal: 'app:open-external-terminal', // 标注为产品受控执行边界之外
    exportDiagnostics: 'app:export-diagnostics',
    ensureProject: 'app:ensure-project', // 选择/登记项目目录
    /** SSH 板卡凭据（Z3）：设置一条（passwordEnv 名 → 密码值；值不回显不落日志） */
    sshCredentialSet: 'app:ssh-credential-set',
    /** 清除一条凭据 */
    sshCredentialClear: 'app:ssh-credential-clear',
    /** 已配置变量名列表（仅名字，不含值） */
    sshCredentialNames: 'app:ssh-credential-names',
    /** 检查更新（Z2C：读取 updateFeedUrl 指向的 JSON 并比对版本；仅告知不安装） */
    checkUpdate: 'app:check-update',
    /** 在外部终端拉起随包 CLI 的官方 login（CODEX_HOME=产品引擎目录，不复制既有客户端凭证） */
    openEngineLogin: 'app:open-engine-login',
    /** 多模型提供方（OpenAI 兼容 responses）：列表/配置/清除/控制台外链/模型拉取 */
    listModelProviders: 'app:list-model-providers',
    configureModelProvider: 'app:configure-model-provider',
    clearModelProvider: 'app:clear-model-provider',
    openProviderConsole: 'app:open-provider-console',
    listProviderModels: 'app:list-provider-models',
  },
} as const;

/** runner:invoke 允许的工具名（与 MCP 七工具同构） */
export const RUNNER_INVOKE_TOOLS = [
  'engineering.inspect',
  'engineering.build',
  'engineering.test',
  'device.bind',
  'device.flash',
  'device.verify',
  'engineering.export',
] as const;
export type RunnerInvokeTool = (typeof RUNNER_INVOKE_TOOLS)[number];

export interface AppInfo {
  name: 'ForgeStudio';
  version: string;
  platform: string;
  electronVersion: string;
  nodeVersion: string;
  dataDir: string;
  /** 用户主目录（引擎预热在无最近项目时的默认 cwd） */
  homeDir: string;
  engineHome: string; // 产品专属 CODEX_HOME
  engineCliPath: string;
}

export interface AppSettings {
  defaultModel?: string;
  uiLanguage: 'zh-CN' | 'en-US';
  /** 停止/退出时对进行中烧录任务的提示开关 */
  confirmExitOnDeviceOp: boolean;
  maxRendererEventQueue: number;
  /** 当前选定的模型提供方（key 本体存引擎目录 provider.env，不进 settings） */
  modelProvider?: { id: string; defaultModel?: string };
  /** 每提供方上次使用的模型（切换厂商时恢复选择；不含 key） */
  providerModelMemory?: Record<string, string>;
  /**
   * 更新源 JSON URL（Z2C scaffold：`{version, url, sha256, notes?}`；设置后「检查更新」
   * 仅比对与告知，不自动下载安装——electron-updater 待代码签名与更新服务器就绪后引入）
   */
  updateFeedUrl?: string;
}

/** 多模型提供方目录（OpenAI 兼容 responses 协议——Codex 0.162.1 仅支持 responses；
 * 各家 /responses 端点存在性已实测（401=端点在仅鉴权失败）。key 经各厂商控制台按量获取，
 * 仅 OpenAI 支持账号订阅式官方登录） */
export interface ModelProviderDescriptor {
  id: string;
  label: string;
  /** OpenAI 兼容 base_url（写入产品 CODEX_HOME/config.toml 的 model_providers，+ /responses 拼端点） */
  baseUrl: string;
  /** API key 的环境变量名（写入引擎目录 provider.env，引擎启动时注入子进程） */
  envKey: string;
  /** 默认模型提示（placeholder 文案；方舟需填接入点/模型 ID，按各控制台为准） */
  modelHint: string;
  /** 获取 API key 的控制台地址（固定白名单外链） */
  consoleUrl: string;
  /** 是否支持账号订阅式官方登录（当前仅 OpenAI） */
  officialLogin: boolean;
  /** 订阅套餐说明（如实口径：有 Coding Plan 类套餐的厂商注明；按量计费则不虚构） */
  planNote?: string;
}

export const MODEL_PROVIDERS: readonly ModelProviderDescriptor[] = [
  {
    id: 'openai',
    label: 'OpenAI（官方）',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    modelHint: 'gpt-5 等（model/list 实际返回为准）',
    consoleUrl: 'https://platform.openai.com/api-keys',
    officialLogin: true,
    planNote: '支持 ChatGPT 账号订阅官方登录（下方「官方登录」）；也可用 API key 按量计费。',
  },
  {
    id: 'volces-ark',
    label: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    envKey: 'ARK_API_KEY',
    modelHint: '如 glm-5-3-flash-260828 / deepseek-v4-1-flash-260910 / doubao-seed-2-1-lite-260915（GET /models 实测返回为准）',
    consoleUrl: 'https://console.volcengine.com/ark',
    officialLogin: false,
    planNote: '支持 Coding Plan 订阅套餐（方舟控制台开通）；开通后使用套餐 API key，额度按套餐计。',
  },
  {
    id: 'volces-ark-plan',
    label: '火山方舟 Agent Plan（订阅）',
    // Agent Plan 专属端点（D17 实测：/api/v3 对未开通模型报 ModelNotOpen；订阅 key 须走 /api/plan/v3）
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    envKey: 'ARK_API_KEY',
    modelHint: 'Agent Plan 企业版支持的模型（控制台"开通管理"查看；与上方方舟共用同一把 ARK_API_KEY）',
    consoleUrl: 'https://console.volcengine.com/ark',
    officialLogin: false,
    planNote: 'Agent Plan 企业版专属端点（/api/plan/v3）：需在方舟控制台开通并使用订阅专属 API key；普通按量/ Coding Plan key 请用上方「火山方舟（豆包）」。',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    // 智谱官方 Codex 专用 Responses 协议端点（/api/paas/v4 无 responses，实测 404；
    // 见 docs.bigmodel.cn/cn/coding-plan/tool/codex）
    baseUrl: 'https://open.bigmodel.cn/api/v1',
    envKey: 'ZHIPU_API_KEY',
    modelHint: '如 glm-4.6 / glm-4.5（Coding Plan 套餐内模型）',
    consoleUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    officialLogin: false,
    planNote: '支持 GLM Coding Plan 包月套餐（智谱开放平台开通）；开通后使用套餐 API key。',
  },
  {
    id: 'moonshot',
    label: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    envKey: 'MOONSHOT_API_KEY',
    modelHint: '如 kimi-k2-0905-preview（以平台模型列表为准）',
    consoleUrl: 'https://platform.moonshot.cn/console/api-keys',
    officialLogin: false,
    planNote: '支持 Kimi for Coding 订阅套餐（Moonshot 平台开通）；开通后使用套餐 API key。',
  },
  {
    id: 'qwen',
    label: '通义千问（百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envKey: 'DASHSCOPE_API_KEY',
    modelHint: '如 qwen-plus / qwen3-max（以百炼模型列表为准）',
    consoleUrl: 'https://bailian.console.aliyun.com/',
    officialLogin: false,
    planNote: '百炼平台支持多种资源包与套餐（控制台查看）；使用对应 API key。',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    modelHint: '如 deepseek-chat / deepseek-reasoner',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    officialLogin: false,
    planNote: '按量计费（账户充值），无订阅套餐。',
  },
] as const;

/** 设置页展示用：目录 + 是否已配置 key（绝不回显 key 本体） */
export interface ModelProviderSummary extends ModelProviderDescriptor {
  keyConfigured: boolean;
  /** 当前是否为激活提供方（写入引擎 config.toml 的那个） */
  active: boolean;
}

// ---------------------------------------------------------------------------
// preload 注入的 window.forgedesk 形状（renderer 唯一入口）
// ---------------------------------------------------------------------------

export interface ForgeDeskBridge {
  engine: {
    start(projectRoot: string, options?: { model?: string; resumeThreadId?: string }): Promise<
      OpResult<{ threadId: string; generation: number }>
    >;
    send(text: string): Promise<OpResult<{ turnId: string }>>;
    steer(text: string): Promise<OpResult<SteerResult>>;
    interrupt(): Promise<OpResult<void>>;
    /** 代码审阅：需引擎就绪且存在当前会话；审阅项以普通会话事件回流 */
    review(): Promise<OpResult<void>>;
    approve(requestId: string, decision: ApprovalDecision): Promise<OpResult<void>>;
    models(): Promise<OpResult<EngineModelInfo[]>>;
    authStatus(): Promise<OpResult<AuthStatusInfo>>;
    status(): EngineStatus;
    onEvent(cb: (event: EngineEvent) => void): () => void;
  };
  session: {
    listThreads(): Promise<OpResult<ThreadSummary[]>>;
    loadThread(threadId: string): Promise<OpResult<{ messages: StoredMessage[]; complete: boolean }>>;
    /** 补丁全文（差异面板渲染用）；仅允许 patches/ 目录内的引用，防路径穿越 */
    loadPatch(patchRef: string): Promise<OpResult<{ text: string }>>;
    /** 会话重命名（Z1-5）：本地持久化 + 引擎在线时同步 */
    renameThread(threadId: string, name: string): Promise<OpResult<void>>;
    /** 会话删除（Z1-5）：本地文件清理 + 当前线程时引擎同步 */
    deleteThread(threadId: string): Promise<OpResult<void>>;
    /** 上下文压缩（Z1-5）：需引擎就绪；完成以 session/compacted 事件为准 */
    compactThread(threadId: string): Promise<OpResult<void>>;
  };
  runner: {
    listTasks(): Promise<OpResult<TaskOverview[]>>;
    getTask(taskId: string): Promise<OpResult<TaskOverview>>;
    /** 工程 profile 枚举（任务向导） */
    listProfiles(): Promise<OpResult<ProfileSummary[]>>;
    createTask(req: CreateTaskRequest): Promise<OpResult<TaskOverview>>;
    updateAcceptance(
      taskId: string,
      items: Array<{ id?: string; kind: 'executable' | 'manual'; verifierId?: string; title: string; expected: string; manualRequired: boolean; required: boolean; status?: 'pending' | 'proposed' | 'not_runnable' }>,
    ): Promise<OpResult<AcceptanceItem[]>>;
    /** 人工验收判定（仅 manual 项；产生 manual_review 操作与证据，passed/failed 状态由此点亮）。返回该任务最新验收单。 */
    manualReview(
      taskId: string,
      itemId: string,
      decision: 'passed' | 'failed',
      note?: string,
    ): Promise<OpResult<AcceptanceItem[]>>;
    invoke(tool: RunnerInvokeTool, input: unknown): Promise<OpResult<unknown>>;
    cancel(operationId: string): Promise<OpResult<void>>;
    pendingAuthorization(): Promise<OpResult<PendingAuthorization[]>>;
    authorize(
      operationId: string,
      decision: 'approved' | 'declined',
      confirmedScope: { deviceBindingId?: string; artifactSha256?: string; taskId: string },
    ): Promise<OpResult<void>>;
    listDevices(): Promise<OpResult<EnumeratedDevice[]>>;
    diagnostics(): Promise<OpResult<RunnerDiagnostics>>;
    onEvent(cb: (event: RunnerEvent) => void): () => void;
  };
  app: {
    info(): Promise<AppInfo>;
    settingsGet(): Promise<AppSettings>;
    settingsSet(patch: Partial<AppSettings>): Promise<AppSettings>;
    /** 仅允许打开产品数据目录/项目根/产物路径，逐次校验前缀 */
    openPath(path: string, kind: 'evidence' | 'artifact' | 'export' | 'log' | 'project'): Promise<OpResult<void>>;
    openExternalTerminal(projectRoot: string): Promise<OpResult<void>>;
    exportDiagnostics(): Promise<OpResult<{ path: string }>>;
    ensureProject(): Promise<OpResult<{ projectRoot: string; name: string }>>;
    /** 外部终端拉起随包 CLI 官方 login（终端内完成 ChatGPT 登录或粘贴 API key；无参数、无注入面） */
    openEngineLogin(): Promise<OpResult<void>>;
    /** 模型提供方列表（含 keyConfigured/active；不回显 key 本体） */
    listModelProviders(): Promise<OpResult<ModelProviderSummary[]>>;
    /** 配置提供方（key 写入引擎目录 provider.env；id/baseUrl 来自固定目录，仅 apiKey/defaultModel 受控输入） */
    configureModelProvider(req: { providerId: string; apiKey: string; defaultModel?: string }): Promise<OpResult<void>>;
    /** 清除某提供方的 key 与激活配置 */
    clearModelProvider(providerId: string): Promise<OpResult<void>>;
    /** SSH 板卡凭据：设置后需重启应用注入 runner（返回需重启提示）；值不回显 */
    sshCredentialSet(passwordEnv: string, password: string): Promise<OpResult<{ restartRequired: true }>>;
    sshCredentialClear(passwordEnv: string): Promise<OpResult<{ restartRequired: boolean }>>;
    sshCredentialNames(): Promise<OpResult<string[]>>;
    /** 检查更新（Z2C scaffold）：读 updateFeedUrl 的 JSON 比对版本；仅告知，不下载不安装 */
    checkUpdate(): Promise<
      OpResult<{
        currentVersion: string;
        latestVersion?: string;
        updateAvailable: boolean;
        downloadUrl?: string;
        sha256?: string;
        notes?: string;
      }>
    >;
    /** 打开某提供方的控制台（固定白名单 URL，取 key 用） */
    openProviderConsole(providerId: string): Promise<OpResult<void>>;
    /** 拉取某提供方的模型列表（GET {base}/models，用已配置 key；id 仅限固定目录） */
    listProviderModels(providerId: string): Promise<OpResult<string[]>>;
  };
}

declare global {
  interface Window {
    forgedesk: ForgeDeskBridge;
  }
}
