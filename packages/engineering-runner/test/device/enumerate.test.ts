// fixture 模拟测试——非实机验收。
// 枚举：虚拟 PnP 输出解析 → EnumeratedDevice（VID/PID/序列号/COM 口/busy 标记）。
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import {
  enumerateUsbEntitiesViaPowerShell,
  extractComPort,
  extractUsbIdentity,
  identityFromSerialPortInfo,
  mergeEnumeratedDevices,
  parsePnpJsonOutput,
} from '../../src/device/enumerate.ts';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** 虚拟探针脚本的模拟 powershell JSON 输出（Get-PnpDevice | ConvertTo-Json -Compress 形态） */
function runVirtualProbeEnum(extraArgs: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(fixturesDir, 'virtual-probe-enum.mjs'), ...extraArgs], {
      shell: false,
      windowsHide: true,
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
  });
}

describe('枚举：虚拟 PnP 输出解析（模拟）', () => {
  it('解析 Get-PnpDevice JSON 数组 → 实体', async () => {
    const raw = await runVirtualProbeEnum();
    const entities = parsePnpJsonOutput(raw);
    expect(entities).toHaveLength(3);
    expect(entities[0].pnpDeviceId).toBe('USB\\VID_0483&PID_3748\\00000000001A');
    expect(entities[0].name).toContain('COM7');
    expect(entities[2].deviceClass).toBe('USB');
  });

  it('解析单对象输出（ConvertTo-Json 单元素降级形态）', async () => {
    const raw = await runVirtualProbeEnum(['--single']);
    const entities = parsePnpJsonOutput(raw);
    expect(entities).toHaveLength(1);
    expect(entities[0].pnpDeviceId).toContain('VID_0483');
  });

  it('VID/PID 十六进制提取：USB\\VID_0483&PID_3748\\00000000001A', () => {
    const id = extractUsbIdentity('USB\\VID_0483&PID_3748\\00000000001A');
    expect(id).toEqual({ vid: 0x0483, pid: 0x3748, serial: '00000000001A' });
  });

  it('Windows 自动实例段（6&...）不作序列号', () => {
    const id = extractUsbIdentity('USB\\VID_1A86&PID_7523\\6&27E5B6D&0&0000');
    expect(id).toEqual({ vid: 0x1a86, pid: 0x7523, serial: undefined });
  });

  it('非 USB\\VID_ 前缀 → null', () => {
    expect(extractUsbIdentity('PCI\\VEN_8086&DEV_1234\\3&11583659&0&10')).toBeNull();
    expect(extractUsbIdentity('USB\\ROOT_HUB30\\4&1a2b3c&0&0')).toBeNull();
  });

  it('设备名 COM 口提取', () => {
    expect(extractComPort('ST-Link Virtual COM Port (COM7)')).toBe('COM7');
    expect(extractComPort('USB-SERIAL CH340 (com5)')).toBe('COM5');
    expect(extractComPort('CMSIS-DAP v1')).toBeUndefined();
  });
});

describe('枚举：USB 实体 + 串口列表合并（模拟）', () => {
  const entities = parsePnpJsonOutput(
    JSON.stringify([
      {
        FriendlyName: 'ST-Link Virtual COM Port (COM7)',
        InstanceId: 'USB\\VID_0483&PID_3748\\00000000001A',
        Class: 'Ports',
        Status: 'OK',
      },
      {
        FriendlyName: 'CMSIS-DAP v1',
        InstanceId: 'USB\\VID_0D28&PID_0204\\H7GZ1M9A',
        Class: 'USB',
        Status: 'OK',
      },
    ]),
  );
  const ports = [
    { path: 'COM7', manufacturer: 'STMicroelectronics', serialNumber: '00000000001A', vendorId: '0483', productId: '3748' },
    { path: 'COM13', manufacturer: 'Unknown' }, // PnP 未覆盖的串口
  ];

  it('合并 → EnumeratedDevice[]（source=usb_hub，COM 只作位置）', () => {
    const devices = mergeEnumeratedDevices(entities, ports, []);
    expect(devices).toHaveLength(3);
    const stlink = devices[0];
    expect(stlink.identity).toMatchObject({
      usbVid: 0x0483,
      usbPid: 0x3748,
      probeSerial: '00000000001A',
      serialPort: 'COM7',
      source: 'usb_hub',
    });
    expect(stlink.availableSerialPorts).toEqual(['COM7', 'COM13']);
    expect(stlink.busy).toBe(false);
    const dap = devices[1];
    expect(dap.identity.probeSerial).toBe('H7GZ1M9A');
    expect(dap.identity.serialPort).toBeUndefined(); // 探针无 COM 口
  });

  it('PnP 未覆盖串口以 serialport 元信息补充（VID/PID 未知=0）', () => {
    const devices = mergeEnumeratedDevices(entities, ports, []);
    const extra = devices[2];
    expect(extra.identity.usbVid).toBe(0);
    expect(extra.identity.serialPort).toBe('COM13');
  });

  it('busy 标记：本 runner 持有的端口', () => {
    const devices = mergeEnumeratedDevices(entities, ports, ['com7']); // 小写输入也应命中
    expect(devices[0].busy).toBe(true);
    expect(devices[2].busy).toBe(false);
  });

  it('serialport 元信息 → identity（vid/pid 十六进制解析）', () => {
    const id = identityFromSerialPortInfo(ports[0]);
    expect(id.usbVid).toBe(0x0483);
    expect(id.usbPid).toBe(0x3748);
    expect(id.probeSerial).toBe('00000000001A');
  });
});

describe('枚举：真实 powershell 冒烟（本机 Win11；无板卡 → 结果可为空）', () => {
  it('Get-PnpDevice 查询不抛错（结构化输出或空数组）', { timeout: 30_000 }, async () => {
    const entities = await enumerateUsbEntitiesViaPowerShell(20_000);
    expect(Array.isArray(entities)).toBe(true);
  });
});
