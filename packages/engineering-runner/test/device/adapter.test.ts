// fixture 模拟测试——非实机验收。
// adapter 汇总：capabilities（无 probe-rs → false 不崩溃）、buildBinding 身份规范化
// （VID/PID 十六进制→数值、序列号 trim、COM 只作位置、confirmedByUser 恒 false）、
// 独占物理层（串口 open 失败不得宣称独占成功）、嵌入式 profile 合法性。
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineeringProfileSchema, DeviceProfileSchema } from '@forgedesk/contracts';
import { createDeviceAdapter, DeviceAdapterImpl } from '../../src/device/index.ts';
import { VirtualSerialTransport } from './fixtures/virtual-serial.ts';

let dataDir: string;
let stateDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'forgedesk-adapter-'));
  stateDir = await mkdtemp(path.join(tmpdir(), 'forgedesk-adapter-state-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

const profile = {
  id: 'example-embedded-stm32',
  chipTarget: 'STM32F103C8',
  identity: { usbVid: 0x0483, usbPid: 0x3748, expectProbeSerial: false },
  flashCommand: { exe: 'probe-rs', args: ['download', '--chip', 'STM32F103C8', '${artifact}'], timeoutMs: 300_000 },
  flashBudgetMs: 300_000,
  verifyBudgetMs: 120_000,
};

describe('capabilities：能力诊断（本机无板卡/探针）', () => {
  it('无 probe-rs 环境 → probeRsAvailable=false，不崩溃；serialport 可用如实报告', async () => {
    const adapter = createDeviceAdapter({ dataDir });
    await adapter.refreshCapabilities();
    const caps = adapter.capabilities();
    expect(caps.probeRsAvailable).toBe(false); // 本机未安装 probe-rs（环境事实）
    expect(caps.serialPortsAvailable).toBe(true); // serialport 13 bindings 可加载
    expect(caps.serialPortCount).toBeGreaterThanOrEqual(0); // 无板卡 → 0 个串口也正常
  });

  it('显式 probeRsPath 指向不存在文件 → 仍 false 不崩溃', async () => {
    const adapter = createDeviceAdapter({ dataDir, probeRsPath: 'Z:/nonexistent/probe-rs.exe' });
    await adapter.refreshCapabilities();
    expect(adapter.capabilities().probeRsAvailable).toBe(false);
  });
});

describe('buildBinding：身份规范化与授权边界', () => {
  it('VID/PID 十六进制字符串→数值、序列号 trim、COM 口大写（只作位置）', () => {
    const adapter = createDeviceAdapter({ dataDir });
    const binding = adapter.buildBinding(
      profile,
      {
        usbVid: '0483' as unknown as number, // PnP 形态十六进制字符串
        usbPid: '0x3748' as unknown as number,
        probeSerial: '  00000000001A  ',
        serialPort: 'com7',
        source: 'usb_hub',
      },
      '用户在设备管理器核对 VID/PID 与丝印序列号后确认（fixture 模拟）',
    );
    expect(binding.identity.usbVid).toBe(0x0483);
    expect(binding.identity.usbPid).toBe(0x3748);
    expect(binding.identity.probeSerial).toBe('00000000001A');
    expect(binding.identity.serialPort).toBe('COM7');
    expect(binding.profileId).toBe('example-embedded-stm32');
    expect(binding.chipTarget).toBe('STM32F103C8');
    expect(binding.identityEvidence).toContain('确认');
  });

  it('confirmedByUser 构造期恒 false（授权由 B2 ops 层负责，C 不写授权状态）', () => {
    const adapter = createDeviceAdapter({ dataDir });
    const binding = adapter.buildBinding(
      profile,
      { usbVid: 0x0483, usbPid: 0x3748, source: 'usb_hub' },
      'evidence',
    );
    expect(binding.confirmedByUser).toBe(false);
    expect(binding.id).toMatch(/^dev-/);
    expect(binding.schemaVersion).toBe(1);
  });

  it('identityEvidence 为空 → 拒绝构造（无身份证据不得绑定）', () => {
    const adapter = createDeviceAdapter({ dataDir });
    expect(() => adapter.buildBinding(profile, { usbVid: 1, usbPid: 2, source: 'usb_hub' }, '  ')).toThrow(
      /identityEvidence/,
    );
  });
});

describe('独占物理层：串口被占用 → 不得宣称独占成功（M8）', () => {
  it('B2 接线兼容形态：new DeviceAdapterImpl({ lockDir }) 直接指定锁目录', async () => {
    const lockDir = path.join(dataDir, 'device-locks');
    const adapter = new DeviceAdapterImpl({ lockDir });
    const res = await adapter.acquireExclusive('dev-wire', '任务A device_flash');
    expect(res.acquired).toBe(true);
    await adapter.releaseExclusive('dev-wire');
  });

  it('dataDir 与 lockDir 均缺省 → 拒绝构造', () => {
    expect(() => new DeviceAdapterImpl({})).toThrow(/dataDir|lockDir/);
  });

  it('外部进程占用串口（如串口监视器）→ 物理独占失败并回滚文件锁', async () => {
    // 模拟外部占用：先以独立传输打开 COM7（fixture 端口占用注册表 → Windows 物理独占语义）
    const external = new VirtualSerialTransport({ stateDir, portPath: 'COM7' });
    await external.open('COM7', 115_200);

    const adapter = createDeviceAdapter({
      dataDir,
      resolveBindingPort: () => ({ serialPort: 'COM7', baudRate: 115_200 }),
      serialTransportFactory: () => new VirtualSerialTransport({ stateDir, portPath: 'COM7' }),
    });
    const res = await adapter.acquireExclusive('dev-phys', '任务A device_flash');
    expect(res.acquired).toBe(false);
    expect(res.heldBy).toContain('被占用');

    // 外部释放后可完整获取（文件锁 + 物理串口）
    await external.close();
    const res2 = await adapter.acquireExclusive('dev-phys', '任务A device_flash');
    expect(res2.acquired).toBe(true);
    await adapter.releaseExclusive('dev-phys');
  });
});

describe('嵌入式 profile：schema 合法性（示例未经实机验证）', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const profilePath = path.join(repoRoot, 'engineering', 'profiles', 'example-embedded-stm32.profile.json');

  it('example-embedded-stm32 通过 EngineeringProfileSchema 校验', async () => {
    const raw = JSON.parse(await readFile(profilePath, 'utf8'));
    const parsed = EngineeringProfileSchema.parse(raw);
    expect(parsed.kind).toBe('embedded');
    expect(parsed.device).toBeDefined();
  });

  it('device 段通过 DeviceProfileSchema 校验：flashCommand/serial.verifyProtocol/预算', async () => {
    const raw = JSON.parse(await readFile(profilePath, 'utf8')) as { device: unknown };
    const device = DeviceProfileSchema.parse(raw.device);
    expect(device.chipTarget).toBe('STM32F103C8');
    expect(device.flashCommand.args).toContain('${artifact}');
    expect(device.flashBudgetMs).toBe(300_000);
    expect(device.verifyBudgetMs).toBe(120_000);
    expect(device.serial?.verifyProtocol.requestLine).toContain('${nonce}');
    expect(device.serial?.verifyProtocol.buildIdEchoPrefix).toBe('BUILD_ID:');
    expect(device.readbackCommand?.args).toContain('${artifact}');
  });
});

describe('enumerate：adapter 层冒烟（本机无板卡）', () => {
  it('enumerate 不抛错，返回数组（可为空）', { timeout: 30_000 }, async () => {
    const adapter = createDeviceAdapter({ dataDir });
    const devices = await adapter.enumerate();
    expect(Array.isArray(devices)).toBe(true);
    for (const d of devices) {
      expect(d.identity.source).toBe('usb_hub');
      expect(typeof d.busy).toBe('boolean');
    }
  });
});
