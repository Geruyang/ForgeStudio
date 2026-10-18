# 构建与打包说明（BUILD）

> 可复现构建、打包与安装步骤。由集成负责人维护。

## 前置条件

- Windows 11 x64；Node.js ≥ 22（当前锁定开发环境 v24.21.0）
- npm ≥ 10（workspaces）
- 可选：Git（缺失时 A 级证据走内容清单摘要回退，不影响构建）
- 打包无需管理员权限（per-user NSIS）

## 目录结构

```text
ForgeDesk-zcode/
├── apps/desktop/            Electron 应用（main/preload/bridge + renderer）
│   ├── dist/                构建产物（main、preload、renderer、runner、bridge）
│   ├── release/             electron-builder 输出（安装包）
│   └── scripts/             dev/build/package 脚本
├── packages/
│   ├── contracts/           冻结契约 + 生成的 Codex 协议类型
│   ├── engine-adapter/      Codex app-server stdio 适配
│   ├── engineering-mcp/     MCP stdio 服务（桥接到 runner）
│   └── engineering-runner/  工程执行器（状态/证据/设备）
├── engineering/
│   ├── profiles/            工程 profile（构建/测试/设备配置模板）
│   ├── acceptance/          用户控制的验收定义模板
│   └── fixtures/            固定测试与错误场景（标注"模拟"）
├── tools/vendored/codex/    锁定版 Codex CLI 0.162.1（随包分发）
└── docs/                    六份工作文档
```

## 开发运行

```powershell
cd ForgeDesk-zcode
npm install            # 根 workspaces 一次性安装
npm run dev            # Vite renderer (dev server) + esbuild watch main/preload + Electron
```

## 构建产物

```powershell
npm run build          # renderer (vite) + main/preload/bridge/runner (esbuild bundle)
```

- renderer → `apps/desktop/dist/renderer/`（加载 file:// 或 dev server URL）
- main → `apps/desktop/dist/main/index.js`（ESM）
- preload → `apps/desktop/dist/preload/index.js`（CJS，sandbox 兼容）
- runner service → `apps/desktop/dist/runner/service.cjs`（utilityProcess 加载）
- MCP bridge → `apps/desktop/dist/bridge/mcp-bridge.cjs`（ELECTRON_RUN_AS_NODE 加载）

## 生成安装包

```powershell
npm run package        # 构建 → runner 依赖闭包 → electron-builder → SHA-256
```

- 流程（`apps/desktop/scripts/package.mjs`，四步）：
  1. 完整构建（renderer + main/preload/bridge/runner）
  2. **runner 依赖闭包**：在 `dist/runner` 内独立安装 `serialport@13.0.0`（`--ignore-scripts`，
     使用 bindings-cpp 包内 prebuilds/win32-x64）并校验 6 个关键模块（缺件即打包失败——
     A-10 首装事故的防回归闸，见 DECISIONS D8）
  3. electron-builder NSIS per-user（**显式 `--publish never`**）
  4. 计算安装包 SHA-256 → `release/SHA256SUMS.txt`
- 输出：`apps/desktop/release/ForgeDesk Setup 0.1.0.exe`（正式证据目录 `release-final/` 同步留存）
- 注意：extraResources 对目录内 `node_modules` 有默认过滤，闭包必须以 `dist/runner/node_modules`
  为拷贝根单独成项（`electron-builder.yml` 已配置，勿改回目录整体拷贝）
- 安装位置（per-user）：`%LOCALAPPDATA%\Programs\ForgeDesk`；数据目录：`%APPDATA%\ForgeDesk`
- 资源：vendored Codex CLI（resources/engine/codex）、engineering 模板（resources/engineering）、
  runner 闭包（resources/fd-runner）
- 签名状态：无代码签名证书 → 交付时明示"未签名"（实测 NotSigned），不要求关闭系统安全机制

## 安装后验证（T1 口径：必须从安装后的应用验收）

1. 安装 ForgeDesk Setup，启动安装目录中的 ForgeDesk.exe
2. 首次运行：数据目录初始化、引擎 CODEX_HOME 隔离检查、vendored CLI 版本与哈希核对
3. 模型认证（两种方式任选）：
   - **多提供方 API key**：设置 → 「模型提供方」→ 选火山方舟/智谱/Kimi/千问/DeepSeek（或 OpenAI）→
     点「获取 API key」到厂商控制台创建 → 粘贴保存（key 只写入产品引擎目录 provider.env，
     界面不回显；按量计费，无订阅登录）→ 「刷新认证状态」→ 就绪
   - **OpenAI 官方登录（订阅）**：「模型认证状态」→「官方登录」→ 带中文指引的终端完成 ChatGPT
     授权 → 回设置页「刷新认证状态」
   未登录时顶栏「模型未登录」徽标与主界面横幅常亮提醒
4. 真实会话：顶栏「新会话」（或侧栏 ＋）→ 发送一条消息 → 观察增量/工具/审批/停止
5. 工程面板：创建任务 → 验收单 → inspect/build/test → 证据与版本绑定 → 导出交付包
   （低频的设备/操作历史区块默认折叠，点标题展开）
6. 嵌入式（T2）：绑定设备 → 授权烧录 → 串口验证（需实机，缺失则面板显示"设备不可用"）

## 超时/预算基线（任务书 §6.2）

- MCP 服务级：startup_timeout_sec=20、tool_timeout_sec=360
- runner 操作预算：烧录 300s、验证 120s、构建/测试按 profile timeoutMs 汇总

## vendored 依赖恢复（git 检出后，Z0-4 起）

`tools/vendored/codex/`（44 文件 / ~437MB 引擎二进制）与 `apps/desktop/release*/`、
`.electron-cache/` 不入库。fresh clone 后恢复：

1. `npm ci`（根，恢复工作区依赖）
2. `cd tools && npm ci`（安装 `@openai/codex@0.162.1` + 平台包到 tools/node_modules）
3. 重建 vendored 目录：将 `tools/node_modules/@openai/codex/` 与平台包内容复制到
   `tools/vendored/codex/`（保持与 DECISIONS D1 记录的 44 文件清单布局一致）
4. 校验：`Get-FileHash tools\vendored\codex\codex.exe` 对照 DECISIONS D1 的
   SHA-256 `DD13BDB162A184FA04039488B234A8258EF9B76F84E926C505D5742B19249A6A`；
   不一致则停止并排查（版本漂移不得作为发行依据）

## 发布物规范（Z2C，git 可追溯）

每次正式发布（release-final 同步）必须记录三元组并写入 PROJECT_STATE：

1. `git rev-parse HEAD`（源码 commit）
2. 安装包 SHA-256（`Get-FileHash`）
3. package.json version

发布后构建 `update-feed.json`（Z2C 更新检查 scaffold 消费）：

```json
{ "version": "<新版本>", "url": "<下载地址>", "sha256": "<安装包 SHA-256>", "notes": "<要点>" }
```

更新源 URL 由用户在 设置 → 诊断与关于 → 更新检查 配置；当前仅比对与告知，
不自动下载安装——electron-updater 完整通道（差分下载/签名校验/替换重启）
待代码签名证书与更新服务器就绪后引入（见 ROADMAP Z2C）。

## 代码签名（Z4-B2，2026-10-19 接入）

**管线状态：签名链路已接入并端到端验证（自签测试证书实测：PFX 与证书存储指纹两分支、
sha256 + DigiCert RFC3161 时间戳均嵌入成功）；正式签名待用户提供真实证书——当前产物仍为未签名。**

### 启用方式（凭据经环境变量注入，不落盘不入库）

```powershell
# 方式一：PFX 文件
$env:FD_SIGN_PFX = "D:\certs\forgedesk.pfx"; $env:FD_SIGN_PFX_PASSWORD = "***"; npm run package

# 方式二：证书存储（CurrentUser\My）按 SHA-1 指纹
$env:FD_SIGN_CERT_THUMBPRINT = "<thumbprint>"; npm run package

# 可选：自定义时间戳服务器（默认 http://timestamp.digicert.com）
$env:FD_SIGN_TIMESTAMP_URL = "http://timestamp.sectigo.com"
```

- 实现：`apps/desktop/scripts/sign-hook.cjs`（electron-builder 自定义签名钩子，经
  `--config.win.signtoolOptions.sign` 挂接）+ `sign-installer.mjs`（独立签名/复签工具）。
- 签名引擎 `@electron/windows-sign` 随 electron-builder 分发、**内置 vendor signtool.exe，无需安装 Windows SDK**。
- 签名发生在 electron-builder 计算 blockmap 之前 → `latest.yml`（sha512）与 SHA256SUMS 对应**签名后**产物，差分更新不受影响。
- 仅 sha256（SHA-1 自 2016 起 Windows 弃用，钩子内跳过）；预检前置（PFX 缺文件/缺密码在构建前即报错）。
- 复验命令：`Get-AuthenticodeSignature <exe>` → 正式证书应显示 `Valid`（自签测试证书显示
  `UnknownError`/无信任链，属预期——2026-10-19 实测记录见 ACCEPTANCE）。

### 证书选型参考（价格以各官网为准，2026-10 时点）

| 方案 | 适合 | 说明 |
|---|---|---|
| Azure Trusted Signing | 个人/小团队首选 | 按月订阅（约 $9.99/月起），无硬件 token、签发快；electron-builder 原生 `azureSignOptions` 支持（另一接入路径，与本钩子互斥） |
| Certum Open Source | 开源项目 | 面向开源身份的代码签名证书（年费较低），需项目公开仓库 |
| SSL.com / GlobalSign / DigiCert OV | 企业 | 组织验证；SmartScreen 信誉逐步积累 |
| 同上 EV | 追求立即消除 SmartScreen 告警 | EV 证书通常即时获得 SmartScreen 信誉，价格最高、需硬件 token |

**如实说明**：自签证书可走通管线但**不能**消除 SmartScreen 告警（无受信根链），不作为交付选项；
未签名安装包触发 SmartScreen 告警属预期，交付文档继续明示"未签名"。
