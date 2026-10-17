# 实施环境记录（ENVIRONMENT）

> 实际依赖、工具链与设备状态。**不含任何密钥**。

## 主机与系统

| 项 | 值 |
|---|---|
| OS | Windows 11（build 26200，OSVersion 报 10.0.26200.0） |
| 架构 | x64 |
| 时区 | Asia/Shanghai (+08:00) |
| Node.js | v24.21.0 |
| npm | 11.19.0 |
| pnpm | 未安装（使用 npm workspaces） |

## 开发工具链

| 工具 | 状态 | 说明 |
|---|---|---|
| Node.js | 可用 | v24.21.0（满足 Electron 44 开发需求） |
| npm | 可用 | 11.19.0，registry 可达 |
| **git** | **未安装** | 系统无 git。影响：A 级证据走内容清单摘要回退（hasGit=false）；运行时探测。是否安装 Git for Windows 待用户决定 |
| **Codex CLI** | **安装（项目内）** | 0.162.1 经 npm 安装于 tools/，vendor 至 tools/vendored/codex（44 文件 / 457MB）。SHA-256 见 DECISIONS D1 |
| Electron | 44.7.2（随依赖安装） | 验收平台 Windows 11 x64 |
| TypeScript | 5.9.3 | |
| VSCode/Trae 内置 ripgrep | 可用 |（不作为产品依赖） |

## 网络

- npm registry 可达（https://registry.npmjs.org）。

## 模型认证（H2 检查项）

| 项 | 状态 |
|---|---|
| Codex API key | **未提供**（阻塞项，已升级用户） |
| ChatGPT 账号登录 | 未执行（需用户授权后在产品专属 CODEX_HOME 内进行） |
| 模型真实调用 | **未执行**（凭证缺失）——不宣称任何模型已验证 |

## 嵌入式硬件（H2 检查项）

| 项 | 状态 |
|---|---|
| 板卡 | **未接入**（未枚举到任何目标板） |
| 探针（J-Link/ST-Link/DAPLink） | **未接入** |
| probe-rs / 烧录工具链 | 未安装（T2 运行前提，安装待用户指定板型后进行） |
| 串口设备 | 无目标设备接入 |

结论：T2 实机链在 H2 检查时点不具备，按任务书分流：软件任务、设备适配代码、fixture、诊断面板继续开发；实机验收保留未完成。

## 产品数据目录约定（隔离基线）

- 开发态：`<repo>/.runtime/`（数据/引擎目录，git 忽略）
- 安装态：程序 `%LOCALAPPDATA%\Programs\ForgeDesk\`（per-user NSIS，免管理员）；数据 `%APPDATA%\ForgeDesk\`
  （主进程 ready 前显式规范化，实测落位含 runner-discovery.json/forgedesk.db/engine/evidence/profiles）；
  vendored CLI 在安装目录下 `resources\engine\codex`
- 引擎 CODEX_HOME：`<数据目录>\engine`（不使用、不读取 `%USERPROFILE%\.codex`）
- 已安装版本实证（2026-10-14 晚，A-10）：`ForgeDesk Setup 0.1.0.exe` SHA-256
  `6FFD8365835CD8E8DB346B8B9155F732FAE82EE7CD195BE0B56F5C972F6AE6AB`，未签名；
  安装态 codex.exe 哈希与 vendored 清单一致（DD13BDB1…）
