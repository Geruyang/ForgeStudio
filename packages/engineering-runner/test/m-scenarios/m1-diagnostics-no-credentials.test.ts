// M1 must 场景（fixture 级）；集成状态：TODO-INT
// （runner 的 GET /api/diagnostics 未交付前：以 contracts RunnerDiagnostics 类型构造真实形状的序列化
//   样本做无凭证扫描；集成后改为拉取真实端点响应体扫描同组正则。
//   凭证扫描器本身（正则有效性）与真实交付物文件扫描现在就真实运行。）
//
// 场景（任务书 §15.2 M1）：诊断/交付包不含凭证——鉴权失败不虚报成功、诊断导出无密钥。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RunnerDiagnostics } from '../../../contracts/src/runner-api.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** 凭证样式的检测模式（诊断/导出/日志面禁止出现） */
const CREDENTIAL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'openai-api-key-env', re: /OPENAI_API_KEY\s*[=:]/i },
  { name: 'openai-sk-key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'bearer-token', re: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  {
    name: 'generic-secret-assignment',
    // 注意 ["']?：JSON 形式 {"apiKey": "..."} 的键名带尾引号，诊断/导出恰以 JSON 为载体——
    // 不允许引号会漏检 JSON 凭证赋值（本文件正控制用例曾暴露该盲点，已修复）。
    re: /\b(?:api[_-]?key|apikey|secret|password|passwd|access[_-]?token|auth[_-]?token|token)\b["']?\s*[:=]\s*["'][^"']{8,}["']/i,
  },
  { name: 'github-token', re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

/** 扫描文本，返回命中的模式名（空数组 = 干净） */
export function scanForCredentials(text: string): string[] {
  const hits: string[] = [];
  for (const { name, re } of CREDENTIAL_PATTERNS) {
    if (re.test(text)) hits.push(name);
  }
  return hits;
}

/** 真实形状的诊断样本（无凭证字段设计：只含状态/路径/计数） */
function sampleDiagnosticsHealthy(): RunnerDiagnostics {
  return {
    schemaVersion: 1,
    runnerVersion: '0.1.0',
    uptimeMs: 86_400_000,
    storagePath: 'C:\\Users\\dev\\AppData\\Roaming\\ForgeDesk\\storage',
    storageOk: true,
    gitAvailable: false,
    probeRsAvailable: false,
    serialPortsAvailable: false,
    pendingAuthorizations: 0,
  };
}

function sampleDiagnosticsWithErrors(): RunnerDiagnostics {
  return {
    schemaVersion: 1,
    runnerVersion: '0.1.0',
    uptimeMs: 1_500,
    storagePath: 'C:\\Users\\dev\\AppData\\Roaming\\ForgeDesk\\storage',
    storageOk: true,
    gitAvailable: false,
    probeRsAvailable: true,
    probeRsPath: 'C:\\Users\\dev\\.cargo\\bin\\probe-rs.exe',
    serialPortsAvailable: true,
    activeDeviceLock: 'task-9f2c1a3b-7d4e-4f5a-8b6c-2d1e0f9a8b7c',
    pendingAuthorizations: 1,
    lastError: '烧录命令退出码 1：Error connecting to probe；详见 logRef（不含令牌）',
  };
}

describe('M1 诊断不含凭证（fixture 级）——扫描器有效性（正控制）', () => {
  it('每种凭证样式都能被扫描器命中（防扫描器形同虚设）', () => {
    const planted: Array<[string, string]> = [
      ['openai-api-key-env', 'OPENAI_API_KEY=whatever'],
      ['openai-sk-key', 'sk-AbCdEf1234567890AbCdEf12'],
      ['bearer-token', 'Authorization: Bearer abcdef1234567890abcd'],
      ['generic-secret-assignment', '{"apiKey": "supersecretvalue123"}'],
      ['generic-secret-assignment', 'token: "tok_9f2c1a3b7d4e4f5a"'],
      ['github-token', 'ghp_AbCdEf1234567890AbCdEf12345'],
      ['aws-access-key', 'AKIAIOSFODNN7EXAMPLE'],
      ['jwt', 'eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4'],
    ];
    for (const [expectName, sample] of planted) {
      expect(scanForCredentials(sample)).toContain(expectName);
    }
  });

  it('正常工程文本（命令行、路径、URL）不误报', () => {
    expect(scanForCredentials('node build.mjs --check')).toEqual([]);
    expect(scanForCredentials('C:\\Users\\dev\\AppData\\Roaming\\ForgeDesk\\storage\\tasks')).toEqual([]);
    expect(scanForCredentials('https://registry.npmjs.org（只解析协议，不含令牌）')).toEqual([]);
    expect(scanForCredentials('codex.exe 0.162.1，SHA-256 DD13BDB1...（版本哈希非凭证）')).toEqual([]);
  });
});

describe('M1 诊断不含凭证（fixture 级）——RunnerDiagnostics 序列化样本', () => {
  it('健康诊断样本序列化后无凭证命中', () => {
    expect(scanForCredentials(JSON.stringify(sampleDiagnosticsHealthy()))).toEqual([]);
  });

  it('含错误信息/设备锁/工具路径的诊断样本序列化后无凭证命中', () => {
    expect(scanForCredentials(JSON.stringify(sampleDiagnosticsWithErrors()))).toEqual([]);
  });

  it('诊断字段设计不含令牌类字段名', () => {
    const keys = Object.keys(sampleDiagnosticsHealthy());
    for (const k of keys) {
      expect(k.toLowerCase()).not.toMatch(/token|apikey|api_key|secret|password/);
    }
  });

  it('SSE 事件包装（diagnostics/updated payload）序列化后无凭证命中', () => {
    const event = {
      schemaVersion: 1,
      seq: 42,
      type: 'diagnostics/updated',
      payload: sampleDiagnosticsWithErrors(),
      emittedAt: new Date().toISOString(),
    };
    expect(scanForCredentials(JSON.stringify(event))).toEqual([]);
  });

  it('无凭证导出包样例（app 信息 + 引擎路径 + 版本清单）无凭证命中', () => {
    const exportBlob = JSON.stringify({
      schemaVersion: 1,
      app: { name: 'ForgeDesk', version: '0.1.0', platform: 'win32-x64', electronVersion: '44.7.2' },
      engineHome: 'C:\\Users\\dev\\AppData\\Roaming\\ForgeDesk\\engine',
      engineCliPath: 'C:\\Users\\dev\\AppData\\Local\\Programs\\ForgeDesk\\resources\\engine\\codex\\bin\\codex.exe',
      vendoredCodex: { version: '0.162.1', sha256: 'DD13BDB162A184FA04039488B234A8258EF9B76F84E926C505D5742B19249A6A' },
      models: [{ id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex' }],
      note: '导出不含任何凭证（任务书 §15.2 M1）',
    });
    expect(scanForCredentials(exportBlob)).toEqual([]);
  });
});

describe('M1 诊断不含凭证（fixture 级）——真实交付物文件扫描', () => {
  const realFiles: Array<[string, string]> = [
    ['forgedesk-self.profile.json', join(repoRoot, 'engineering', 'profiles', 'forgedesk-self.profile.json')],
    ['sample-tool.profile.json', join(repoRoot, 'engineering', 'fixtures', 'software', 'sample-tool', 'sample-tool.profile.json')],
    ['task-templates.json', join(repoRoot, 'engineering', 'acceptance', 'task-templates.json')],
    ['VERSION.json', join(repoRoot, 'tools', 'vendored', 'codex', 'VERSION.json')],
    ['approval-basic.jsonl', join(repoRoot, 'engineering', 'fixtures', 'transcripts', 'approval-basic.jsonl')],
    ['approval-stale-generation.jsonl', join(repoRoot, 'engineering', 'fixtures', 'transcripts', 'approval-stale-generation.jsonl')],
    ['stop-semantics.jsonl', join(repoRoot, 'engineering', 'fixtures', 'transcripts', 'stop-semantics.jsonl')],
    ['stop-failure.jsonl', join(repoRoot, 'engineering', 'fixtures', 'transcripts', 'stop-failure.jsonl')],
  ];

  for (const [name, file] of realFiles) {
    it(`无凭证命中：${name}`, () => {
      expect(scanForCredentials(readFileSync(file, 'utf8'))).toEqual([]);
    });
  }
});

// TODO-INT（集成后）：
// 1. 启动真实 runner（B2 http 模块），请求 GET /api/diagnostics 并以同一 scanForCredentials 扫描响应体；
// 2. 触发 app:exportDiagnostics（apps/desktop 主进程）扫描导出文件内容；
// 3. 鉴权失败路径：authStatus() 返回 mode='none'、ok=false（不虚报成功）——需 engine-adapter 集成后验证。

// ---------------------------------------------------------------------------
// 集成版（待集成执行；依赖：Agent B2 的 runner HTTP 服务 createRunnerService —— 未交付时自动 skip）
// B2 交付（src/index.ts 导出 createRunnerService）后 skip 解除，本块用真实服务验证：
//   GET /api/diagnostics 响应体、存储目录全部文本文件、导出包——三者均不得命中凭证模式。
// ---------------------------------------------------------------------------

type RunnerServiceModule = {
  createRunnerService?: (options: { dataDir: string }) => Promise<{
    close?: () => Promise<void>;
    stop?: () => Promise<void>;
    dispose?: () => Promise<void>;
  }>;
};
let runnerService: RunnerServiceModule | null = null;
let runnerImportError = '';
try {
  runnerService = (await import('../../src/index.ts')) as RunnerServiceModule;
  if (typeof runnerService.createRunnerService !== 'function') {
    runnerImportError = 'src/index.ts 已存在但未导出 createRunnerService（B2 服务层未交付）';
  }
} catch (error) {
  runnerImportError = String(error);
}

describe.skipIf(!runnerService?.createRunnerService)('M1 诊断/存储/导出不含凭证（集成版：真实 runner 服务）', () => {
  it('起 createRunnerService → GET /api/diagnostics → 响应体与存储目录均无凭证命中', async () => {
    // 真实流程：createRunnerService({dataDir}) → 读 dataDir/runner-discovery.json 取 port/token →
    //   fetch GET /api/diagnostics（Bearer）→ scanForCredentials(响应体) === []；
    //   递归扫描 dataDir 下全部文本文件 → scanForCredentials === []；
    //   POST /api/ops/export 产物目录扫描（导出包无凭证，任务书 §15.2 M1）。
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, readFileSync: readText } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dataDir = mkdtempSync(join(tmpdir(), 'forgedesk-m1-int-'));
    // 临时工程 + profile（放 dataDir/profiles，loader 默认目录）
    const projectRoot = mkdtempSync(join(tmpdir(), 'forgedesk-m1-proj-'));
    writeFileSync(join(projectRoot, 'src-main.js'), 'console.log("m1");\n');
    const profileDir = join(dataDir, 'profiles');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, 'm1-int.profile.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'm1-int',
        revision: 1,
        title: 'M1 集成临时工程',
        kind: 'software',
        build: { exe: 'node', args: ['-e', 'require("node:fs").writeFileSync("out.txt","ok")'], timeoutMs: 30000 },
        artifactsGlob: ['out.txt'],
        verifiers: [
          { verifierId: 'm1-smoke', title: '冒烟', command: { exe: 'node', args: ['--version'], timeoutMs: 30000 } },
        ],
        inputIncludes: ['src-main.js'],
        inputExcludes: ['out.txt'],
      }),
      'utf8',
    );
    try {
      const service = await runnerService!.createRunnerService!({ dataDir });
      const discovery = JSON.parse(readText(join(dataDir, 'runner-discovery.json'), 'utf8'));
      const base = `http://127.0.0.1:${discovery.port}`;
      const auth = { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' };

      // 1) GET /api/diagnostics 响应体无凭证
      const diag = await fetch(`${base}/api/diagnostics`, { headers: auth });
      expect(diag.status).toBe(200);
      expect(scanForCredentials(await diag.text())).toEqual([]);

      // 2) 建任务 → build → export（生成真实导出包）
      const task = (await (
        await fetch(`${base}/api/tasks`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ projectRoot, profileId: 'm1-int', title: 'M1' }),
        })
      ).json()) as { id: string };
      const build = (await (
        await fetch(`${base}/api/ops/build?wait=true`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ taskId: task.id, profileRevision: 1 }),
        })
      ).json()) as { result?: { ok?: boolean } };
      expect(build.result?.ok).toBe(true);
      const exported = (await (
        await fetch(`${base}/api/ops/export?wait=true`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ taskId: task.id }),
        })
      ).json()) as { result?: { ok?: boolean } };
      expect(exported.result?.ok).toBe(true);

      // 3) 先关闭服务（发现文件按契约携带本机回环令牌，close 后随之删除），
      //    再递归扫描 dataDir（含 DB 旁文件/证据/导出包）全部文本文件：无凭证命中
      await service.close?.();
      const textExt = /\.(json|log|txt|md)$/i;
      const scanDir = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          const st = statSync(p);
          if (st.isDirectory()) scanDir(p);
          else if (textExt.test(name)) {
            expect(scanForCredentials(readText(p, 'utf8')), `文件 ${p} 命中凭证模式`).toEqual([]);
          }
        }
      };
      scanDir(dataDir);
    } finally {
      // Windows 上 WAL 句柄释放有延迟：重试删除
      await rmWithRetry(dataDir);
      await rmWithRetry(projectRoot);
    }
  });
});

/** rmSync 重试（Windows 句柄延迟释放时 EPERM） */
async function rmWithRetry(target: string, attempts = 5): Promise<void> {
  const { rmSync } = await import('node:fs');
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

if (!runnerService?.createRunnerService) {
  it('【依赖状态记录】B2 createRunnerService 未交付，集成版用例已跳过', () => {
    console.log(`[M1-INT] runner 服务模块加载失败（预期，待 B2 交付）：${runnerImportError.slice(0, 200)}`);
    expect(runnerImportError.length).toBeGreaterThan(0);
  });
}
