// should 场景扩展（任务书 §15.2「多型号/多端口热插拔身份变化」+「长时间串口流与旧日志边界组合」）。
// 全部 fixture 模拟（虚拟探针/环回串口）——非实机验收；STM32 实机验证按用户指示暂缓。
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  newId,
  type DeviceBinding,
  type EnumeratedDevice,
  type DeviceAdapter,
  type SerialVerifyArgs,
  type SerialVerifyOutcome,
  type DeviceFlashArgs,
  type FlashOutcome,
  type ExclusiveLease,
} from '@forgedesk/contracts';
import { runSerialVerify, type SerialVerifyDeps } from '../../src/device/serial.ts';
import { VirtualSerialTransport } from './fixtures/virtual-serial.ts';
import { makeEmbeddedEngine } from '../helpers/engine.ts';
import { rmForce } from '../helpers/fixtures.ts';

let workDir: string;
let stateDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'forgedesk-hp-work-'));
  stateDir = await mkdtemp(path.join(tmpdir(), 'forgedesk-hp-state-'));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 长时间串口流与旧日志边界（模拟）
// ---------------------------------------------------------------------------

async function flashFirmwareState(buildId: string): Promise<void> {
  await writeFile(
    path.join(stateDir, 'device-firmware.json'),
    JSON.stringify({
      schemaVersion: 1,
      sha256: 'a'.repeat(64),
      buildId,
      supportsBuildIdEcho: true,
      flashedAt: new Date().toISOString(),
    }),
    'utf8',
  );
}

const serialProfile: SerialVerifyArgs['profile'] = {
  chipTarget: 'STM32F103C8',
  identity: { usbVid: 0x0483, usbPid: 0x3748, expectProbeSerial: false },
  flashBudgetMs: 300_000,
  verifyBudgetMs: 120_000,
  serial: {
    baudRate: 115_200,
    verifyProtocol: { requestLine: 'FORGEDESK_VERIFY ${nonce}', buildIdEchoPrefix: 'BUILD_ID:' },
    responseTimeoutMs: 800,
  },
  flashCommand: { exe: 'probe-rs', args: ['download', '${artifact}'], timeoutMs: 300_000 },
};

const serialBinding: DeviceBinding = {
  schemaVersion: 1,
  id: 'dev-hp-serial',
  profileId: 'fixture-embedded',
  identity: { usbVid: 0x0483, usbPid: 0x3748, probeSerial: 'HP-SN-1', serialPort: 'COM9', source: 'usb_hub' },
  chipTarget: 'STM32F103C8',
  serialPort: 'COM9',
  identityEvidence: 'fixture：热插拔/长流（模拟）',
  confirmedByUser: false,
  createdAt: new Date().toISOString(),
};

describe('should：长时间串口流与旧日志边界（模拟）', () => {
  it('1000 行旧日志 + 50 行响应前噪声：flush 丢弃旧行、噪声不干扰 nonce 判定，验证通过', async () => {
    await flashFirmwareState('bld-long流');
    const stale = Array.from({ length: 1000 }, (_, i) => `OLD_LOG_LINE_${i} 旧日志 noise`);
    const noise = Array.from({ length: 50 }, (_, i) => `RUNTIME_TELEMETRY_${i} {...json...}`);
    const args: SerialVerifyArgs = {
      taskId: 'task-hp-long',
      binding: serialBinding,
      profile: serialProfile,
      buildId: 'bld-long流',
      workDir,
      budgetMs: 8_000,
    };
    const deps: SerialVerifyDeps = {
      createTransport: () => new VirtualSerialTransport({ stateDir, portPath: 'COM9', staleLines: stale, extraNoiseLines: noise }),
      resolvePort: async () => 'COM9',
    };
    const outcome = await runSerialVerify(args, deps);
    expect(outcome.exchange.responseNonceMatch).toBe(true);
    expect(outcome.exchange.buildIdMatch).toBe(true);
    // 旧日志不作本轮证据：responseRaw 不含旧日志首行
    expect(outcome.exchange.responseRaw).not.toContain('OLD_LOG_LINE_0');
  });
});

// ---------------------------------------------------------------------------
// 热插拔身份变化（模拟）：重插后序列号变化 → 新绑定；不同型号被 profile 校验拒绝
// ---------------------------------------------------------------------------

class HotplugStubAdapter implements DeviceAdapter {
  activeExclusive: string | undefined = undefined;
  current: EnumeratedDevice;
  constructor(serial: string) {
    this.current = {
      identity: { usbVid: 0x1234, usbPid: 0x5678, probeSerial: serial, chipTarget: 'stm32f103cb-fixture', source: 'usb_hub' },
      availableSerialPorts: ['COM-STUB'],
      probeSummary: 'hotplug stub（模拟）',
      busy: false,
    };
  }
  async enumerate() {
    return [this.current];
  }
  async acquireExclusive(): Promise<ExclusiveLease> {
    return { acquired: true, acquiredAt: new Date().toISOString() };
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
    const receipt = path.join(args.workDir, 'flash-receipt.log');
    await writeFile(receipt, 'hotplug stub flash（模拟）\n', 'utf8');
    return { toolReceiptPath: receipt, toolSummary: 'ok（模拟）', durationMs: 5 };
  }
  async verifySerial(): Promise<SerialVerifyOutcome> {
    return {
      exchange: {
        nonce: 'deadbeef',
        sentAt: new Date().toISOString(),
        responseRaw: 'IDENT? ok',
        responseNonceMatch: true,
        buildIdMatch: true,
        capturedAt: new Date().toISOString(),
      },
      responsePreview: 'ok（模拟）',
    };
  }
  capabilities() {
    return { probeRsAvailable: false, serialPortCount: 1, serialPortsAvailable: true };
  }
}

/** bind + 批准授权，返回绑定 id（复用 device-framework 的授权流程形态） */
async function bindApproved(f: Awaited<ReturnType<typeof makeEmbeddedEngine>>, probeSerial: string, evidence: string): Promise<string> {
  const call = f.engine.callOperation(
    'device_bind',
    { taskId: f.taskId, profileId: 'fixture-embedded', identity: { usbVid: 0x1234, usbPid: 0x5678, probeSerial }, identityEvidence: evidence },
    { wait: true },
  );
  let pending = f.engine.pendingAuthorizations();
  for (let i = 0; i < 100 && pending.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
    pending = f.engine.pendingAuthorizations();
  }
  f.engine.authorize({ operationId: pending[0]!.operationId, decision: 'approved', confirmedScope: { taskId: f.taskId } });
  const r = (await call).result as { ok: boolean; deviceBindingId: string };
  expect(r.ok).toBe(true);
  return r.deviceBindingId;
}

describe('should：热插拔身份变化（模拟）', () => {
  it('重插后序列号变化：新绑定独立创建（不静默复用旧绑定）；不同型号（VID 变化）被拒绝', async () => {
    const adapter = new HotplugStubAdapter('SN-BEFORE-001');
    const f = await makeEmbeddedEngine(adapter);
    const cleanups = [f.dataDir, f.fx.root, f.fx.profileDir];
    try {
      const id1 = await bindApproved(f, 'SN-BEFORE-001', '热插拔前（模拟）');
      // 热插拔：重插后同口出现不同序列号（换探针/重枚举）
      adapter.current = { ...adapter.current, identity: { ...adapter.current.identity, probeSerial: 'SN-AFTER-009' } };
      const id2 = await bindApproved(f, 'SN-AFTER-009', '热插拔后（新序列号，模拟）');
      expect(id2).not.toBe(id1); // 新身份 → 新绑定
      // 多型号：VID 不同（换板型）→ profile 身份校验拒绝
      const r3 = await f.engine.callOperation(
        'device_bind',
        { taskId: f.taskId, profileId: 'fixture-embedded', identity: { usbVid: 0x9999, usbPid: 0x5678, probeSerial: 'SN-OTHER' }, identityEvidence: '另一种板（模拟）' },
        { wait: true },
      );
      expect((r3.result as { kind: string }).kind).toBe('permission_denied');
    } finally {
      f.storage.close();
      await f.engine.shutdown(1_000);
      for (const d of cleanups) await rmForce(d);
    }
  });
});
