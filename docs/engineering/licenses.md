# 第三方许可证与改动说明（Licenses）

> QA（Agent D）维护。ForgeDesk 自身许可：`LicenseRef-SEE-LICENSE-IN-LICENSE`。
> 依赖版本以根 package-lock.json 为准（集成负责人管理）；本表为随包分发的第三方组件清单。

## 1. vendored Codex CLI（重点项）

| 项 | 值 |
|---|---|
| 组件 | OpenAI Codex CLI（`codex app-server` 引擎） |
| 版本 | **0.162.1**（npm `@openai/codex@0.162.1`，win32-x64 平台包） |
| codex.exe SHA-256 | `DD13BDB162A184FA04039488B234A8258EF9B76F84E926C505D5742B19249A6A` |
| 来源 | npm registry（OpenAI 官方发布物），vendor 至 `tools/vendored/codex`（44 文件），随安装包分发于 `resources\engine\codex` |
| 许可证 | **Apache-2.0**（不含模型服务权益或官方品牌使用权） |
| 改动 | **未修改**二进制；协议类型由同版本 CLI `generate-ts` 生成（743 个 TS 文件，`packages/contracts/src/protocol/codex/`，来源见 PROVENANCE.md） |
| 依据 | docs/DECISIONS.md **D1**（引擎与版本锁定） |

## 2. npm 依赖清单

| 名称 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| electron | 44.7.2 | MIT | 桌面应用宿主（主进程/renderer/preload） |
| react / react-dom | 19.3.0 | MIT | renderer UI 框架 |
| codex（vendored，见 §1） | 0.162.1 | Apache-2.0 | 引擎 app-server stdio |
| serialport | 13.0.0 | MIT | T2 串口通信（bindings-cpp 13.0.1，N-API 免重编） |
| zod | 3.25.76 | MIT | 契约 schema 与运行时校验 |
| diff | 9.0.0 | BSD-3-Clause | 会话内补丁/代码差异渲染 |
| zustand | 5.0.15 | MIT | renderer 状态管理 |
| vitest | 5.0.4 | MIT | 各包测试运行器 |
| esbuild | 0.28.2 | MIT | main/preload/bridge/runner 打包 |
| electron-builder | 26.15.3 | MIT | NSIS per-user 安装包 |
| vite | 8.3.4 | MIT | renderer 构建（@vitejs/plugin-react 6.1.2） |
| typescript | 5.9.3 | Apache-2.0 | 类型检查与构建 |
| jsdom / @testing-library/* | 30.1.2 / 16.3.3 / 7.0.1 | MIT | renderer 组件测试（仅开发态） |

传递依赖（react-dom 依赖 scheduler MIT、vite 依赖 rollup MIT、esbuild 为独立二进制等）均为
MIT/Apache-2.0 系宽松许可；完整清单以 `package-lock.json` 与安装包内 `LICENSES` 目录为准。

## 3. 许可证文本

各依赖许可证全文随安装包分发；源仓库 `node_modules/<pkg>/LICENSE` 为准。MIT/BSD-3/Apache-2.0
均要求保留版权与许可声明——分发物中予以保留。

## 4. 改动说明

- **不修改**任何第三方库源码；vendored codex 二进制原样分发（§1）；
- 自有代码：`packages/*`、`apps/desktop`（LicenseRef-SEE-LICENSE-IN-LICENSE）；
- 协议类型为生成物（未手改），更新 CLI 版本时重新生成并全量回归（DECISIONS D2/D3）。
