/**
 * 引擎宿主：Codex app-server 适配器生命周期 + 产品 CODEX_HOME 管理。
 * - 每次会话启动前确保 config.toml（MCP 注册，绝对路径）与 auth.json（如已配置）
 * - 事件转发给 renderer；SessionStore 自动持久化
 * - CODEX_HOME = <dataDir>/engine，绝不回退 %USERPROFILE%\.codex
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  CodexEngineAdapter,
  EngineSessionStore,
  patchFilePath,
} from '@forgedesk/engine-adapter';
import type {
  EngineAdapter,
  EngineEvent,
  EngineStartOptions,
  EngineStatus,
} from '@forgedesk/contracts/engine';
import { ENGINEERING_TOOLS, MCP_SERVER_INSTRUCTIONS } from '@forgedesk/contracts/mcp';

export interface EngineHostOptions {
  codexCliPath: string;
  engineHome: string;
  sessionStorageDir: string;
  /** MCP 桥接：可执行文件与参数（绝对路径；由主进程按运行环境生成） */
  mcpBridge: { command: string; args: string[]; env?: Record<string, string> };
  /** 多提供方运行时配置（火山方舟/智谱/Kimi/千问/DeepSeek 等；null=OpenAI 官方默认） */
  getRuntimeProvider?: () => Promise<import('./provider-config').ProviderRuntimeConfig | null>;
  onEvent: (event: EngineEvent) => void;
}

export class EngineHost {
  #adapter: CodexEngineAdapter | null = null;
  readonly sessionStore: EngineSessionStore;
  #detachStore: (() => void) | null = null;
  #lastStatus: EngineStatus = 'stopped';
  #currentProjectRoot: string | null = null;
  #runtimeProvider: import('./provider-config').ProviderRuntimeConfig | null = null;
  /** 当前 adapter 构造时绑定的提供方 id：extraEnv 只在 adapter 创建时注入，切换提供方必须重建 */
  #adapterProviderId: string | null = null;

  constructor(private readonly opts: EngineHostOptions) {
    this.sessionStore = new EngineSessionStore({ storageDir: opts.sessionStorageDir });
  }

  get adapter(): EngineAdapter | null {
    return this.#adapter;
  }

  get status(): EngineStatus {
    return this.#adapter ? (this.#adapter.status as EngineStatus) : this.#lastStatus;
  }

  /** 启动（或换项目根/换提供方重启）引擎；确保隔离环境就绪 */
  async start(options: EngineStartOptions & { projectRoot: string }): Promise<{ threadId: string; generation: number }> {
    // 先渲染隔离环境并解析当前提供方——provider 的 API key 经 extraEnv 只随 adapter 构造注入，
    // 切换提供方（如 DeepSeek → 智谱）必须销毁重建 adapter，否则旧 key 仍被注入子进程
    await this.#ensureEngineHome();
    const providerId = this.#runtimeProvider?.id ?? null;
    const rootChanged = this.#currentProjectRoot !== options.projectRoot;
    const providerChanged = this.#adapterProviderId !== providerId;
    if (this.#adapter && (rootChanged || providerChanged)) {
      await this.dispose();
    }
    if (!this.#adapter) {
      this.#lastStatus = 'starting';
      const provider = this.#runtimeProvider;
      this.#adapter = new CodexEngineAdapter({
        codexCliPath: this.opts.codexCliPath,
        codexHome: this.opts.engineHome,
        storageDir: this.opts.sessionStorageDir,
        projectRoot: options.projectRoot,
        // 多提供方 API key 经 env_key 环境变量注入引擎子进程（key 不落 config.toml）
        ...(provider?.apiKey ? { extraEnv: { [provider.envKey]: provider.apiKey } } : {}),
      });
      this.#adapter.subscribe((event) => {
        if (event.type === 'engine/status') this.#lastStatus = event.status;
        this.opts.onEvent(event);
      });
      this.#detachStore?.();
      this.#currentProjectRoot = options.projectRoot;
      this.#adapterProviderId = providerId;
    }
    const started = await this.#adapter.start(options);
    /* BUG2 修复：adapter 复用路径也必须先退订旧的 SessionStore——否则每次 start()
     * 叠加一个监听器（事件写 N 次 + seq 重复 → "历史不完整" 误报） */
    this.#detachStore?.();
    // SessionStore 自动持久化（事件顺序即存储顺序）
    this.#detachStore = this.sessionStore.attach(this.#adapter, { projectRoot: options.projectRoot });
    return started;
  }

  /** 补丁全文（差异面板渲染）——仅允许 patches/ 目录内引用，防路径穿越 */
  async loadPatch(patchRef: string): Promise<{ text: string } | null> {
    if (!/^patch-g\d+-\d+$/.test(patchRef)) return null;
    try {
      const text = await fsp.readFile(patchFilePath(this.opts.sessionStorageDir, patchRef), 'utf8');
      return { text };
    } catch {
      return null;
    }
  }

  async dispose(): Promise<void> {
    this.#detachStore?.();
    this.#detachStore = null;
    if (this.#adapter) {
      await this.#adapter.dispose().catch(() => undefined);
      this.#adapter = null;
    }
    this.#lastStatus = 'stopped';
  }

  /** 引擎隔离环境：config.toml（MCP 注册 + 多提供方）+ auth.json（存在 API key 时） */
  async #ensureEngineHome(): Promise<void> {
    const home = this.opts.engineHome;
    await fsp.mkdir(home, { recursive: true });
    this.#runtimeProvider = (await this.opts.getRuntimeProvider?.()) ?? null;
    const toml = this.#renderConfigToml();
    const tomlPath = path.join(home, 'config.toml');
    await fsp.writeFile(tomlPath, toml, 'utf8');
  }

  #renderConfigToml(): string {
    const bridge = this.opts.mcpBridge;
    const envLines = bridge.env
      ? Object.entries(bridge.env).map(([k, v]) => `${tomlStr(k)} = ${tomlStr(v)}`).join(', ')
      : null;
    const envRow = envLines ? `\nenv = { ${envLines} }` : '';
    // 多提供方：激活方写入 model_provider/model_providers（OpenAI 兼容 responses 协议——
    // vendored Codex 0.162.1 已移除 wire_api="chat"，各家 /responses 端点经探测均存在）；
    // key 本体不落 config.toml——由 adapter extraEnv 注入子进程环境（env_key 引用）
    const p = this.#runtimeProvider;
    const providerSection = p
      ? [
          `model_provider = ${tomlStr(p.id)}`,
          ...(p.defaultModel ? [`model = ${tomlStr(p.defaultModel)}`] : []),
          '',
          `[model_providers.${p.id}]`,
          `name = ${tomlStr(p.id)}`,
          `base_url = ${tomlStr(p.baseUrl)}`,
          `env_key = ${tomlStr(p.envKey)}`,
          'wire_api = "responses"',
          '',
        ].join('\n')
      : '';
    return [
      '# ForgeStudio 生成（勿手改）——产品专属引擎配置，与用户其他 Codex 安装隔离',
      providerSection,
      '[mcp_servers.engineering]',
      `command = ${tomlStr(bridge.command)}`,
      `args = [${bridge.args.map((a) => tomlStr(a)).join(', ')}]`, envRow,
      'startup_timeout_sec = 20',
      'tool_timeout_sec = 360',
      'required = false',
      `enabled_tools = [\n${ENGINEERING_TOOLS.map((t) => `  '${t}',`).join('\n')}\n]`,
      '',
      `# 工具用途与服务说明见：${MCP_SERVER_INSTRUCTIONS.slice(0, 60)}…`,
      '',
    ]
      .filter((l) => l !== null)
      .join('\n');
  }
}

/**
 * TOML 字符串：默认 literal string（单引号，反斜杠为字面量、无需转义——Windows 路径友好）；
 * 值含单引号时退回 basic string（JSON.stringify 即合法 TOML basic string 转义）。
 * 旧实现把 `\` 转成 `\\` 且仍用单引号包裹——literal string 不解析转义，生成的
 * command 路径变成字面双反斜杠（Win32 恰好容忍，但属错误输出）。
 */
function tomlStr(v: string): string {
  return v.includes("'") ? JSON.stringify(v) : `'${v}'`;
}
