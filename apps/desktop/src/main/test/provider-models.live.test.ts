// @vitest-environment node
// Z1-1 live 验证（2026-10-17）：真实拉取各提供方 GET /models（D19 实现的回归实测）。
// 运行条件：FD_LIVE_ENGINE_HOME 指向含 provider.env 的引擎目录（如安装版 %APPDATA%\ForgeStudio\engine）。
// 未设置或对应 key 缺失 → 该提供方自动跳过（skip ≠ 通过，实测结果以运行输出为准）。
// 只发只读 GET /models 请求，不打印任何 key 本体。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { listProviderModels } from '../provider-config';

const engineHome = process.env.FD_LIVE_ENGINE_HOME ?? '';

function hasKey(envKey: string): boolean {
  if (!engineHome) return false;
  const file = path.join(engineHome, 'provider.env');
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  const m = text.match(new RegExp(`^${envKey}=(.+)$`, 'm'));
  return Boolean(m && m[1].trim().length > 0);
}

const skipAll = !engineHome || !existsSync(path.join(engineHome, 'provider.env'));

describe.skipIf(skipAll)('模型列表直拉（live，真实厂商端点）', () => {
  const cases: Array<{ id: string; envKey: string; note: string }> = [
    { id: 'volces-ark', envKey: 'ARK_API_KEY', note: '按量端点目录，剔除 Shutdown/Retiring' },
    { id: 'volces-ark-plan', envKey: 'ARK_API_KEY', note: 'Agent Plan 404 → 回落按量端点' },
    { id: 'zhipu', envKey: 'ZHIPU_API_KEY', note: '/api/v1/models 的 models[].slug 格式' },
    { id: 'qwen', envKey: 'DASHSCOPE_API_KEY', note: 'data[].id 格式' },
    { id: 'deepseek', envKey: 'DEEPSEEK_API_KEY', note: 'data[].id 格式' },
    { id: 'moonshot', envKey: 'MOONSHOT_API_KEY', note: 'data[].id 格式' },
  ];

  for (const c of cases) {
    it.skipIf(!hasKey(c.envKey))(
      `${c.id}：返回非空、去重、排序的模型 id 列表（${c.note}）`,
      { timeout: 30_000 },
      async () => {
        const models = await listProviderModels(engineHome, c.id);
        expect(models.length).toBeGreaterThan(0);
        expect(new Set(models).size).toBe(models.length);
        expect([...models].sort((a, b) => a.localeCompare(b))).toEqual(models);
        // 样例输出（前 5 个，仅为计数与形态证据，不含任何敏感值）
        console.log(`[live] ${c.id}: ${models.length} 个模型，样例 ${models.slice(0, 5).join(', ')}`);
      },
    );
  }
});
