// fixture 模拟测试——非实机验收。
// 串口验证（§8.3 / M6）：nonce+buildId 匹配→passed；错误 nonce→failed；
// 旧缓冲日志不作本轮证据（flush 后旧行被丢弃）；固件无 buildId 回报→buildIdMatch:false
// 非 failed；掉线→失败；原始流落盘 serial-raw-*.log。
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { DeviceBinding, SerialVerifyArgs } from '@forgedesk/contracts';
import { runSerialVerify, type SerialVerifyDeps } from '../../src/device/serial.ts';
import { DeviceVerifyError } from '../../src/device/errors.ts';
import { VirtualSerialTransport } from './fixtures/virtual-serial.ts';

let workDir: string;
let stateDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'forgedesk-serial-work-'));
  stateDir = await mkdtemp(path.join(tmpdir(), 'forgedesk-serial-state-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

/** 写入模拟板内固件状态（等价虚拟烧录工具成功后的 device-firmware.json） */
async function flashFirmwareState(buildId: string | undefined, sha = 'a'.repeat(64)): Promise<void> {
  await writeFile(
    path.join(stateDir, 'device-firmware.json'),
    JSON.stringify({
      schemaVersion: 1,
      sha256: sha,
      buildId,
      supportsBuildIdEcho: buildId !== undefined,
      flashedAt: new Date().toISOString(),
    }),
    'utf8',
  );
}

const binding: DeviceBinding = {
  schemaVersion: 1,
  id: 'dev-serial-test',
  profileId: 'example-embedded-stm32',
  identity: { usbVid: 0x0483, usbPid: 0x3748, probeSerial: '00000000001A', serialPort: 'COM7', source: 'usb_hub' },
  chipTarget: 'STM32F103C8',
  serialPort: 'COM7',
  identityEvidence: 'fixture：虚拟探针（模拟）',
  confirmedByUser: false,
  createdAt: new Date().toISOString(),
};

function makeArgs(opts?: { buildId?: string; budgetMs?: number }): SerialVerifyArgs {
  return {
    taskId: 'task-serial-test',
    binding,
    profile: {
      chipTarget: 'STM32F103C8',
      identity: { usbVid: 0x0483, usbPid: 0x3748, expectProbeSerial: false },
      flashBudgetMs: 300_000,
      verifyBudgetMs: 120_000,
      serial: {
        baudRate: 115_200,
        verifyProtocol: { requestLine: 'FORGEDESK_VERIFY ${nonce}', buildIdEchoPrefix: 'BUILD_ID:' },
        responseTimeoutMs: 600,
      },
      flashCommand: { exe: 'probe-rs', args: ['download', '${artifact}'], timeoutMs: 300_000 },
    },
    buildId: opts?.buildId ?? 'bld-new固件',
    workDir,
    budgetMs: opts?.budgetMs ?? 5_000,
  };
}

function makeDeps(transportOpts: ConstructorParameters<typeof VirtualSerialTransport>[0]): SerialVerifyDeps {
  return {
    createTransport: () => new VirtualSerialTransport(transportOpts),
    resolvePort: async () => 'COM7',
  };
}

describe('串口验证：通过路径（模拟）', () => {
  it('nonce + buildId 匹配 → exchange 全 true，原始流落盘', async () => {
    await flashFirmwareState('bld-new固件');
    const outcome = await runSerialVerify(makeArgs(), makeDeps({ stateDir, portPath: 'COM7' }));
    expect(outcome.exchange.responseNonceMatch).toBe(true);
    expect(outcome.exchange.responseBuildId).toBe('bld-new固件');
    expect(outcome.exchange.buildIdMatch).toBe(true);
    expect(outcome.exchange.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(outcome.exchange.responseRaw).toContain('NONCE:');
    // 原始流落盘：serial-raw-*.log 含发送行与接收行
    const raw = await readFile(outcome.logRef!, 'utf8');
    expect(raw).toContain('> FORGEDESK_VERIFY ');
    expect(raw).toContain('< VERIFY OK BUILD_ID:bld-new固件');
  });

  it('带延迟的慢固件 → 仍在响应超时内通过', async () => {
    await flashFirmwareState('bld-x');
    const outcome = await runSerialVerify(
      makeArgs({ buildId: 'bld-x' }),
      makeDeps({ stateDir, portPath: 'COM7', responseDelayMs: 100 }),
    );
    expect(outcome.exchange.responseNonceMatch).toBe(true);
  });

  it('响应前噪声行 → 记录原始流但不影响判定', async () => {
    await flashFirmwareState('bld-x');
    const outcome = await runSerialVerify(
      makeArgs({ buildId: 'bld-x' }),
      makeDeps({ stateDir, portPath: 'COM7', extraNoiseLines: ['sensor: 23.5C', 'loop tick 42'] }),
    );
    expect(outcome.exchange.responseNonceMatch).toBe(true);
    expect(outcome.responsePreview).toContain('sensor: 23.5C');
  });
});

describe('串口验证：防假通过（M6，模拟）', () => {
  it('错误/旧 nonce → failed（nonce_mismatch）：旧固件响应不作为本轮证据', async () => {
    await flashFirmwareState('bld-new固件');
    const err = await runSerialVerify(
      makeArgs(),
      makeDeps({ stateDir, portPath: 'COM7', echoWrongNonce: true }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceVerifyError);
    const vErr = err as DeviceVerifyError;
    expect(vErr.reason).toBe('nonce_mismatch');
    expect(vErr.kind).toBe('test_failure');
    expect(vErr.exchange.responseNonceMatch).toBe(false);
  });

  it('旧缓冲日志不作本轮证据：flush 后旧行被丢弃，固件静默 → no_response 而非假通过', async () => {
    // 板上无固件状态（device-firmware.json 不存在 → 固件静默），但串口缓冲有旧验证响应
    const staleLines = [
      'boot v1.2.3',
      `VERIFY OK BUILD_ID:bld-old固件 NONCE:deadbeefdeadbeefdeadbeefdeadbeef`, // 上一轮的旧响应
    ];
    const err = await runSerialVerify(
      makeArgs(),
      makeDeps({ stateDir, portPath: 'COM7', staleLines }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceVerifyError);
    const vErr = err as DeviceVerifyError;
    expect(vErr.reason).toBe('no_response'); // 旧 NONCE 行已被 flush 丢弃，不会冒充本轮响应
    expect(vErr.exchange.responseNonceMatch).toBe(false);
  });

  it('旧缓冲行 flush 丢弃 + 正常固件 → 本轮新响应作证据（旧行不出现在判定中）', async () => {
    await flashFirmwareState('bld-new固件');
    const staleLines = [`VERIFY OK BUILD_ID:bld-old固件 NONCE:deadbeefdeadbeefdeadbeefdeadbeef`];
    const outcome = await runSerialVerify(
      makeArgs(),
      makeDeps({ stateDir, portPath: 'COM7', staleLines }),
    );
    expect(outcome.exchange.responseRaw).not.toContain('deadbeef'); // 旧 nonce 未参与判定
    expect(outcome.exchange.responseBuildId).toBe('bld-new固件');
    expect(outcome.exchange.buildIdMatch).toBe(true);
  });

  it('buildId 回报与期望不一致 → failed（板上可能仍是旧固件）', async () => {
    await flashFirmwareState('bld-old固件');
    const err = await runSerialVerify(makeArgs(), makeDeps({ stateDir, portPath: 'COM7' })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DeviceVerifyError);
    expect((err as DeviceVerifyError).reason).toBe('build_id_mismatch');
  });
});

describe('串口验证：未确认与故障（§8.3，模拟）', () => {
  it('固件无 buildId 回报 → buildIdMatch:false 但不失败（"已烧录，运行版本未独立确认"）', async () => {
    await flashFirmwareState(undefined); // supportsBuildIdEcho=false
    const outcome = await runSerialVerify(makeArgs(), makeDeps({ stateDir, portPath: 'COM7' }));
    expect(outcome.exchange.responseNonceMatch).toBe(true);
    expect(outcome.exchange.responseBuildId).toBeUndefined();
    expect(outcome.exchange.buildIdMatch).toBe(false); // 非 failed：未独立确认语义
  });

  it('掉线（响应前拔线）→ connection_failure', async () => {
    await flashFirmwareState('bld-x');
    const err = await runSerialVerify(
      makeArgs({ buildId: 'bld-x' }),
      makeDeps({ stateDir, portPath: 'COM7', disconnectOnRequest: true }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceVerifyError);
    expect((err as DeviceVerifyError).reason).toBe('connection_failure');
    expect((err as DeviceVerifyError).kind).toBe('connection_failure');
  });

  it('端口不存在（未插/已拔出）→ open 失败 → connection_failure', async () => {
    const err = await runSerialVerify(
      makeArgs(),
      makeDeps({ stateDir, portPath: 'COM404', portExists: false }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceVerifyError);
    expect((err as DeviceVerifyError).reason).toBe('connection_failure');
  });

  it('板上无固件（无响应）→ no_response（inconclusive 语义）', async () => {
    const err = await runSerialVerify(makeArgs(), makeDeps({ stateDir, portPath: 'COM7' })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DeviceVerifyError);
    expect((err as DeviceVerifyError).reason).toBe('no_response');
    // 失败也落原始流日志
    await expect(stat((err as DeviceVerifyError).logRef!)).resolves.toBeTruthy();
  });
});
