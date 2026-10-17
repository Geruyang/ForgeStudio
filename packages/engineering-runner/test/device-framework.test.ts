﻿﻿﻿// 设备操作授权语义框架测试（虚拟探针 stub，标注"模拟"）：
// 无适配 → environment_missing；绑定授权（范围核对/拒绝/批准）；烧录 requestKey 幂等；串口验证点亮 device: 验收。
import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { newId } from '@forgedesk/contracts/common';
import type {
  DeviceAdapter,
  DeviceFlashArgs,
  FlashOutcome,
  SerialVerifyArgs,
  SerialVerifyOutcome,
  ExclusiveLease,
} from '../src/internal/device-port.ts';
import type { DeviceBinding, EnumeratedDevice } from '@forgedesk/contracts/device';
import type { BuildOutput, DeviceBindOutput, DeviceFlashOutput, DeviceVerifyOutput } from '@forgedesk/contracts/mcp';
import { makeEngine, makeEmbeddedEngine, expectOk, type EngineFixture } from './helpers/engine.ts';
import { rmForce } from './helpers/fixtures.ts';

const cleanups: string[] = [];
const fixtures: EngineFixture[] = [];
afterAll(async () => {
  for (const f of fixtures) {
    await f.engine.shutdown(2_000).catch(() => undefined);
    f.storage.close();
  }
  for (const d of cleanups) await rmForce(d);
});

/** 虚拟探针适配器（内存实现，标注模拟；接口形态与设备 Agent C 的真实实现对齐） */
class StubProbeAdapter implements DeviceAdapter {
  flashCalls = 0;
  verifyCalls = 0;
  readonly devices: EnumeratedDevice[] = [
    {
      identity: { usbVid: 0x1234, usbPid: 0x5678, probeSerial: 'STUB-SN-001', chipTarget: 'stm32f103cb-fixture', source: 'usb_hub' },
      availableSerialPorts: ['COM-STUB'],
      probeSummary: 'stub probe（模拟）',
      busy: false,
    },
  ];

  async enumerate(): Promise<EnumeratedDevice[]> {
    return this.devices;
  }
  async acquireExclusive(bindingId: string, holderDescription: string): Promise<ExclusiveLease> {
    void bindingId;
    return { acquired: true, acquiredAt: new Date().toISOString(), heldBy: holderDescription };
  }
  async releaseExclusive(): Promise<void> {}
  buildBinding(profile: { chipTarget: string }, identity: DeviceBinding['identity'], identityEvidence: string): DeviceBinding {
    return {
      schemaVersion: 1,
      id: newId('dev'),
      profileId: 'fixture-embedded',
      identity,
      chipTarget: profile.chipTarget,
      serialPort: identity.serialPort,
      identityEvidence,
      confirmedByUser: false,
      createdAt: new Date().toISOString(),
    };
  }
  async flash(args: DeviceFlashArgs): Promise<FlashOutcome> {
    this.flashCalls += 1;
    const receipt = path.join(args.workDir, 'flash-receipt.log');
    await fsp.writeFile(receipt, `stub flash（模拟） artifact=${args.artifactSha256} buildId=${args.buildId ?? 'none'}\n`, 'utf8');
    return { toolReceiptPath: receipt, toolSummary: 'stub flash ok（模拟）', durationMs: 12, readbackVerified: true };
  }
  async verifySerial(args: SerialVerifyArgs): Promise<SerialVerifyOutcome> {
    this.verifyCalls += 1;
    const exchange = {
      nonce: 'a1b2c3',
      sentAt: new Date().toISOString(),
      responseRaw: `IDENT? nonce=a1b2c3 BUILD:${args.buildId ?? 'none'}`,
      responseNonceMatch: true,
      responseBuildId: args.buildId ?? 'none',
      buildIdMatch: true,
      capturedAt: new Date().toISOString(),
    };
    return { exchange, responsePreview: exchange.responseRaw.slice(0, 80) };
  }
  capabilities(): { probeRsAvailable: boolean; serialPortCount: number; serialPortsAvailable: boolean } {
    return { probeRsAvailable: false, serialPortCount: 1, serialPortsAvailable: true };
  }
}

async function setupEmbedded(adapter: StubProbeAdapter): Promise<EngineFixture> {
  const f = await makeEmbeddedEngine(adapter);
  cleanups.push(f.dataDir, f.fx.root, f.fx.profileDir);
  fixtures.push(f);
  return f;
}

describe('设备适配未注入', () => {
  it('device.bind / flash / verify → environment_missing（不崩溃），devices 路由空+诊断', async () => {
    const f = await makeEngine('ok');
    cleanups.push(f.dataDir, f.fx.root, f.fx.profileDir);
    fixtures.push(f);
    const bind = await f.engine.callOperation(
      'device_bind',
      { taskId: f.taskId, profileId: f.fx.profileId, identity: { usbVid: 1, usbPid: 2 }, identityEvidence: 'x' },
      { wait: true },
    );
    expect((bind.result as { ok: boolean; kind: string }).kind).toBe('environment_missing');
    const verify = await f.engine.callOperation('device_verify', { taskId: f.taskId, verifierId: 'device:serial', deviceBindingId: 'dev-00000000-0000-4000-8000-000000000000' }, { wait: true });
    expect((verify.result as { kind: string }).kind).toBe('environment_missing');
    const devices = await f.engine.listDevices();
    expect(devices.devices).toEqual([]);
    expect(devices.adapterAvailable).toBe(false);
  });
});

describe('设备授权语义框架（stub 虚拟探针，模拟）', () => {
  let adapter: StubProbeAdapter;
  let f: EngineFixture;

  beforeEach(async () => {
    adapter = new StubProbeAdapter();
    f = await setupEmbedded(adapter);
  });

  it('bind：身份与 profile 不符 → 拒绝', async () => {
    const r = await f.engine.callOperation(
      'device_bind',
      { taskId: f.taskId, profileId: 'fixture-embedded', identity: { usbVid: 0xdead, usbPid: 0xbeef }, identityEvidence: '贴错板' },
      { wait: true },
    );
    expect((r.result as { kind: string }).kind).toBe('permission_denied');
  });

  it('bind：pending 授权生成 → 范围不符拒绝 → declined 后操作 cancelled；批准后 confirmedByUser', async () => {
    const identity = { usbVid: 0x1234, usbPid: 0x5678, probeSerial: 'STUB-SN-001' };
    const call = f.engine.callOperation(
      'device_bind',
      { taskId: f.taskId, profileId: 'fixture-embedded', identity, identityEvidence: '丝印核对（模拟）' },
      { wait: true },
    );
    // 等待 pending 出现
    let pending = f.engine.pendingAuthorizations();
    for (let i = 0; i < 100 && pending.length === 0; i += 1) {
      await new Promise((r2) => setTimeout(r2, 20));
      pending = f.engine.pendingAuthorizations();
    }
    expect(pending).toHaveLength(1);
    expect(pending[0]?.type).toBe('device_bind');
    const opId = pending[0]!.operationId;
    // 范围不符 → 400（BadRequestError）
    expect(() =>
      f.engine.authorize({
        operationId: opId,
        decision: 'approved',
        confirmedScope: { taskId: 'task-other', deviceBindingId: 'dev-wrong' },
      }),
    ).toThrow(/范围不匹配/);
    // 拒绝 → 操作 cancelled
    const bindingId = pending[0] && (f.storage.getOperation(opId) as unknown as { deviceBindingId?: string })?.deviceBindingId;
    void bindingId;
    f.engine.authorize({ operationId: opId, decision: 'declined', confirmedScope: { taskId: f.taskId } });
    const declined = await call;
    expect(declined.result).toBeTruthy();
    expect(f.storage.getOperation(opId)?.status).toBe('cancelled');
    expect(f.engine.pendingAuthorizations()).toHaveLength(0);
  });

  it('bind→approve→flash→verify 全链路（模拟）：授权持久化使第二次 flash 免确认；requestKey 幂等', async () => {
    // 1) 构建产物
    const build = expectOk((await f.engine.callOperation('build', { taskId: f.taskId, profileRevision: 1 }, { wait: true })).result) as BuildOutput;
    // 2) 绑定 + 批准
    const bindCall = f.engine.callOperation(
      'device_bind',
      { taskId: f.taskId, profileId: 'fixture-embedded', identity: { usbVid: 0x1234, usbPid: 0x5678, probeSerial: 'STUB-SN-001' }, identityEvidence: '丝印核对（模拟）' },
      { wait: true },
    );
    let pending = f.engine.pendingAuthorizations();
    for (let i = 0; i < 100 && pending.length === 0; i += 1) {
      await new Promise((r2) => setTimeout(r2, 20));
      pending = f.engine.pendingAuthorizations();
    }
    const bindPending = pending[0]!;
    f.engine.authorize({ operationId: bindPending.operationId, decision: 'approved', confirmedScope: { taskId: f.taskId } });
    const bind = expectOk((await bindCall).result) as DeviceBindOutput;
    expect(bind.confirmedByUser).toBe(true);
    expect(f.storage.getBinding(bind.deviceBindingId)?.confirmedByUser).toBe(true);

    // 3) 烧录（首次需要授权：artifactSha256 范围）
    const flashArgs = { taskId: f.taskId, artifactId: build.artifactId, deviceBindingId: bind.deviceBindingId, requestKey: 'rk-flash-stub-00001' };
    const flashCall = f.engine.callOperation('device_flash', flashArgs, { wait: true });
    let flashPending = f.engine.pendingAuthorizations().find((p) => p.type === 'device_flash');
    for (let i = 0; i < 100 && !flashPending; i += 1) {
      await new Promise((r2) => setTimeout(r2, 20));
      flashPending = f.engine.pendingAuthorizations().find((p) => p.type === 'device_flash');
    }
    expect(flashPending).toBeDefined();
    expect(flashPending?.artifactSha256).toBe(build.artifactSha256);
    // 范围不符拒绝（artifactSha256 不一致）
    expect(() =>
      f.engine.authorize({
        operationId: flashPending!.operationId,
        decision: 'approved',
        confirmedScope: { taskId: f.taskId, artifactSha256: 'f'.repeat(64), deviceBindingId: bind.deviceBindingId },
      }),
    ).toThrow(/范围不匹配/);
    f.engine.authorize({
      operationId: flashPending!.operationId,
      decision: 'approved',
      confirmedScope: { taskId: f.taskId, artifactSha256: build.artifactSha256, deviceBindingId: bind.deviceBindingId },
    });
    const flash = expectOk((await flashCall).result) as DeviceFlashOutput;
    expect(flash.status).toBe('succeeded');
    expect(flash.readbackVerified).toBe(true);
    expect(adapter.flashCalls).toBe(1);

    // 4) 同 requestKey 重复烧录 → 原操作，不重复副作用
    const flash2 = await f.engine.callOperation('device_flash', flashArgs, { wait: true });
    expect(flash2.operationId).toBe(flash.operationId);
    expect(adapter.flashCalls).toBe(1); // 幂等：副作用只发生一次

    // 5) 新 requestKey、同范围（授权已持久化未过期）→ 免确认直接烧录
    const flash3 = expectOk(
      (await f.engine.callOperation('device_flash', { ...flashArgs, requestKey: 'rk-flash-stub-00002' }, { wait: true })).result,
    ) as DeviceFlashOutput;
    expect(flash3.status).toBe('succeeded');
    expect(adapter.flashCalls).toBe(2);
    expect(f.engine.pendingAuthorizations()).toHaveLength(0);

    // 6) 串口验证：nonce+buildId 匹配 → evidence passed + device: 验收项点亮
    const verify = expectOk(
      (await f.engine.callOperation('device_verify', { taskId: f.taskId, verifierId: 'device:serial-identity', deviceBindingId: bind.deviceBindingId }, { wait: true })).result,
    ) as DeviceVerifyOutput;
    expect(verify.result).toBe('passed');
    expect(verify.nonceMatch).toBe(true);
    expect(verify.buildIdMatch).toBe(true);
    const item = f.storage.getAcceptanceItem(f.acceptanceItemId);
    expect(item?.status).toBe('passed');
    expect(f.storage.getTask(f.taskId)?.status).toBe('passed');
  });
});
