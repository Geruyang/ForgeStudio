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
