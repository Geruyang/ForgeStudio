/**
 * 多模型提供方配置（火山方舟/智谱/Kimi/千问/DeepSeek 等 OpenAI 兼容家）：
 * - settings.json 存激活提供方 id 与默认模型（不含 key 本体）；
 * - <engineHome>/provider.env 存各提供方 API key（KEY=VALUE，逐行；与 auth.json 同级、同等保护）；
 * - EngineHost 启动引擎时：config.toml 生成 [model_providers.<id>]，key 注入子进程环境。
 * renderer 永远拿不到 key 本体（listModelProviders 只回 configured 布尔）。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { MODEL_PROVIDERS, type ModelProviderSummary } from '@forgedesk/contracts/ipc';
import type { SettingsStore } from './settings';

export interface ProviderRuntimeConfig {
  id: string;
  baseUrl: string;
  envKey: string;
  apiKey: string | null;
  defaultModel?: string;
}

function providerEnvPath(engineHome: string): string {
  return path.join(engineHome, 'provider.env');
}

/** 解析 provider.env（KEY=VALUE 逐行；容错跳过空行/注释/畸形行） */
async function readProviderEnv(engineHome: string): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  try {
    const text = await fsp.readFile(providerEnvPath(engineHome), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && m[2].length > 0) map[m[1]] = m[2].trim();
    }
  } catch {
    /* 不存在视为空 */
  }
  return map;
}

async function writeProviderEnv(engineHome: string, map: Record<string, string>): Promise<void> {
  await fsp.mkdir(engineHome, { recursive: true });
  const text = Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  await fsp.writeFile(providerEnvPath(engineHome), text + '\n', 'utf8');
}

/** 设置页列表：目录 + keyConfigured + active（不回显 key） */
export async function listProviderSummaries(
  engineHome: string,
  settings: SettingsStore,
): Promise<ModelProviderSummary[]> {
  const s = await settings.load();
  const envMap = await readProviderEnv(engineHome);
  return MODEL_PROVIDERS.map((d) => ({
    ...d,
    keyConfigured: Boolean(envMap[d.envKey]),
    active: s.modelProvider?.id === d.id,
  }));
}

/** 配置提供方：key 写 provider.env；激活标记 + 默认模型 + 每厂商模型记忆写 settings */
export async function configureProvider(
  engineHome: string,
  settings: SettingsStore,
  req: { providerId: string; apiKey: string; defaultModel?: string },
): Promise<void> {
  const desc = MODEL_PROVIDERS.find((d) => d.id === req.providerId);
  if (!desc) throw new Error(`未知模型提供方: ${req.providerId}`);
  const key = req.apiKey.trim();
  if (key.length < 8) throw new Error('API key 过短（请粘贴完整 key）');
  if (/[\r\n]/.test(key)) throw new Error('API key 不应包含换行');
  const envMap = await readProviderEnv(engineHome);
  envMap[desc.envKey] = key;
  await writeProviderEnv(engineHome, envMap);
  const cur = await settings.load();
  const model = req.defaultModel?.trim();
  await settings.patch({
    modelProvider: {
      id: desc.id,
      ...(model ? { defaultModel: model } : {}),
    },
    // 每厂商模型记忆：切换回该厂商时恢复上次选择（清除 key 不抹记忆）
    ...(model ? { providerModelMemory: { ...(cur.providerModelMemory ?? {}), [desc.id]: model } } : {}),
  } as never);
}

/** 清除提供方：删 provider.env 中对应 key（空则删文件）；若为激活方则一并取消激活 */
export async function clearProvider(engineHome: string, settings: SettingsStore, providerId: string): Promise<void> {
  const desc = MODEL_PROVIDERS.find((d) => d.id === providerId);
  if (!desc) throw new Error(`未知模型提供方: ${providerId}`);
  const envMap = await readProviderEnv(engineHome);
  delete envMap[desc.envKey];
  // 空映射删文件（不残留空 provider.env）；settings.patch 是浅合并——删字段必须显式置 undefined
  if (Object.keys(envMap).length === 0) {
    await fsp.rm(providerEnvPath(engineHome), { force: true });
  } else {
    await writeProviderEnv(engineHome, envMap);
  }
  const s = await settings.load();
  if (s.modelProvider?.id === providerId) {
    await settings.patch({ modelProvider: undefined } as never);
  }
}

/** 引擎启动用的运行时配置（未配置/未激活返回 null → 走 OpenAI 官方默认） */
export async function resolveRuntimeProvider(
  engineHome: string,
  settings: SettingsStore,
): Promise<ProviderRuntimeConfig | null> {
  const s = await settings.load();
  const activeId = s.modelProvider?.id;
  if (!activeId) return null;
  const desc = MODEL_PROVIDERS.find((d) => d.id === activeId);
  if (!desc) return null;
  const envMap = await readProviderEnv(engineHome);
  const apiKey = envMap[desc.envKey] ?? null;
  return {
    id: desc.id,
    baseUrl: desc.baseUrl,
    envKey: desc.envKey,
    apiKey,
    defaultModel: s.modelProvider?.defaultModel,
  };
}

/** 拉取某提供方的模型列表（GET {base}/models，OpenAI 兼容；id 仅认固定目录）。
 * 四家实测（D19）：DeepSeek/千问 `data[].id`、方舟 `data[].id`（含 status 字段，Shutdown/Retiring
 * 的下线模型直接剔除）、智谱 `/api/v1/models` 为 `models[].slug` 格式（Codex 专用目录无 id 字段）。
 * 方舟 Agent Plan 端点（/api/plan/v3）不提供 GET /models（实测 404）——回落按量端点目录。 */
export async function listProviderModels(engineHome: string, providerId: string): Promise<string[]> {
  const desc = MODEL_PROVIDERS.find((d) => d.id === providerId);
  if (!desc) throw new Error(`未知模型提供方: ${providerId}`);
  const envMap = await readProviderEnv(engineHome);
  const key = envMap[desc.envKey];
  if (!key) throw new Error('该提供方尚未配置 API key（请先保存 key 再拉取模型列表）');
  const fetchModels = async (baseUrl: string) =>
    fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
  let res = await fetchModels(desc.baseUrl);
  // 方舟 Agent Plan 订阅端点只有推理路由、无模型目录：404 时回落按量端点（同一把 key、同一目录）
  if (res.status === 404 && providerId === 'volces-ark-plan') {
    res = await fetchModels('https://ark.cn-beijing.volces.com/api/v3');
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 120);
    throw new Error(`获取模型列表失败（HTTP ${res.status}）${body ? `：${body}` : ''}——请检查 key 是否有效/有额度`);
  }
  const json = (await res.json()) as {
    data?: Array<{ id?: string; slug?: string; status?: string }>;
    models?: Array<{ id?: string; slug?: string; status?: string }>;
  };
  const all = [...(json.data ?? []), ...(json.models ?? [])];
  // 方舟会把已下线（Shutdown）/将下线（Retiring）模型一并返回——剔除后才是可选集
  const unusable = new Set(['shutdown', 'retiring']);
  const usable = all.filter((m) => !(typeof m?.status === 'string' && unusable.has(m.status.toLowerCase())));
  const ids = usable
    .map((m) => m?.id ?? m?.slug)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (ids.length === 0) {
    throw new Error(
      all.length > 0
        ? '提供方返回的模型均已下线（Shutdown/Retiring）'
        : '提供方返回了空模型列表',
    );
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}
