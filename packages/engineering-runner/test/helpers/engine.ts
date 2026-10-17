/**
 * 引擎级测试助手：组装 Storage + ProfileLoader + OpsEngine + 临时工程。
 */
import { Storage } from '../../src/storage/database.ts';
import { ProfileLoader } from '../../src/profiles/loader.ts';
import { OpsEngine, type ToolOutput } from '../../src/ops/engine.ts';
import type { DeviceAdapter } from '../../src/internal/device-port.ts';
import type { ToolFailure } from '@forgedesk/contracts/mcp';
import { writeFixtureProject, writeEmbeddedProfile, type FixtureProject } from './fixtures.ts';

export interface EngineFixture {
  dataDir: string;
  fx: FixtureProject;
  storage: Storage;
  engine: OpsEngine;
  taskId: string;
  acceptanceItemId: string;
}

export async function makeEngine(
  variant: Parameters<typeof writeFixtureProject>[0],
  opts?: { sideEffectBuild?: boolean; adapter?: DeviceAdapter | null; acceptance?: 'smoke' | 'proposed-extra' | 'none' },
): Promise<EngineFixture> {
  const dataDir = await makeTmpDataDir();
  const fx = await writeFixtureProject(variant, { sideEffectBuild: opts?.sideEffectBuild });
  const storage = new Storage(dataDir);
  const profiles = new ProfileLoader([fx.profileDir]);
  await profiles.reload();
  const engine = new OpsEngine({ dataDir, storage, profiles, deviceAdapter: opts?.adapter ?? null });
  const verifierId = variant === 'keywords' ? 'kw-verifier' : `${fx.profileId}-smoke`;
  const acceptance =
    opts?.acceptance === 'none'
      ? []
      : [
          {
            kind: 'executable' as const,
            verifierId,
            title: '冒烟验收',
            expected: '验收命令按规则通过',
            manualRequired: false,
            required: true,
          },
        ];
  const task = await engine.createTask({
    projectRoot: fx.root,
    profileId: fx.profileId,
    title: `任务-${variant}`,
    acceptance,
  });
  const items = storage.listAcceptanceItems(task.id);
  return { dataDir, fx, storage, engine, taskId: task.id, acceptanceItemId: items[0]?.id ?? '' };
}

export async function makeTmpDataDir(): Promise<string> {
  const { makeTmpDir } = await import('./fixtures.ts');
  return makeTmpDir('data');
}

/** 嵌入式工程（虚拟探针 stub 适配器用） */
export async function makeEmbeddedEngine(adapter: DeviceAdapter): Promise<EngineFixture> {
  const dataDir = await makeTmpDataDir();
  const { writeFixtureProject, makeTmpDir } = await import('./fixtures.ts');
  const fx = await writeFixtureProject('ok');
  await writeEmbeddedProfile(fx.profileDir);
  const storage = new Storage(dataDir);
  const profiles = new ProfileLoader([fx.profileDir]);
  await profiles.reload();
  const engine = new OpsEngine({ dataDir, storage, profiles, deviceAdapter: adapter });
  const task = await engine.createTask({
    projectRoot: fx.root,
    profileId: 'fixture-embedded',
    title: '嵌入式任务（虚拟探针，模拟）',
    acceptance: [
      { kind: 'executable', verifierId: 'device:serial-identity', title: '串口身份验证', expected: 'nonce+buildId 匹配', manualRequired: false, required: true },
    ],
  });
  void makeTmpDir;
  const items = storage.listAcceptanceItems(task.id);
  return { dataDir, fx, storage, engine, taskId: task.id, acceptanceItemId: items[0]?.id ?? '' };
}

/** 断言为成功输出（收窄联合；undefined 视为失败） */
export function expectOk<T extends ToolOutput>(value: T | ToolFailure | undefined): T {
  if (
    value === undefined ||
    (typeof value === 'object' && value !== null && 'ok' in value && (value as { ok?: unknown }).ok === false)
  ) {
    throw new Error(`期望工具成功，得到失败: ${JSON.stringify(value)}`);
  }
  return value as T;
}
