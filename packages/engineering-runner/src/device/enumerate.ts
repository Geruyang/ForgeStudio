/**
 * 设备枚举（Agent C，任务书 §10.2 步骤 1）：
 * - USB 枚举：spawn powershell.exe -NoProfile 查询 Get-PnpDevice（shell:false，.exe 直启），
 *   解析 USB\VID_xxxx&PID_xxxx\实例段 提取 VID/PID/序列号片段，过滤 USB 类设备
 * - 串口列表：serialport SerialPort.list()（path/friendlyName/manufacturer/serialNumber/vid/pid）
 * - 合并为 EnumeratedDevice[]（source:'usb_hub'）；busy = 端口被本 runner 持有
 * - powershell 不可用/超时/非零退出 → 回退 serialport 列表（VID/PID 未知=0 → 绑定须人工确认）
 * 纯解析/合并函数与真实 powershell 调用分离，便于 fixture 级测试（不真跑 powershell 也可测解析）。
 * 本机无板卡：真实路径运行时探测，结果可能为空——不算失败。
 */
import type { DeviceIdentity, EnumeratedDevice } from '@forgedesk/contracts';
import { runCapture } from './run-capture';

/** Get-PnpDevice 输出实体（ConvertTo-Json 归一化后） */
export interface UsbPnpEntity {
  /** InstanceId，如 USB\VID_0483&PID_3748\00000000001A */
  pnpDeviceId: string;
  /** FriendlyName，如 "ST-Link Virtual COM Port (COM7)" */
  name: string;
  /** Class，如 Ports / USB / HIDClass */
  deviceClass?: string;
  /** Status，如 OK / Error */
  status?: string;
}

/** Get-PnpDevice 查询脚本：仅在场设备 + USB\VID_* 实例；输出压缩 JSON */
const PNP_QUERY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$rows = Get-PnpDevice -PresentOnly | Where-Object { $null -ne $_.InstanceId -and $_.InstanceId -like 'USB\\VID_*' } | Select-Object FriendlyName, InstanceId, Class, Status",
  "if ($null -eq $rows) { '[]' } else { @($rows) | ConvertTo-Json -Compress }",
].join('\n');

/**
 * 解析 powershell ConvertTo-Json 输出（单对象/数组均归一化为数组）。
 * JSON 非法时抛错，由调用方兜底回退 serialport 列表。
 */
export function parsePnpJsonOutput(raw: string): UsbPnpEntity[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const data: unknown = JSON.parse(trimmed);
  const arr = Array.isArray(data) ? data : [data];
  const entities: UsbPnpEntity[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.InstanceId !== 'string' || obj.InstanceId.length === 0) continue;
    entities.push({
      pnpDeviceId: obj.InstanceId,
      name: typeof obj.FriendlyName === 'string' ? obj.FriendlyName : '',
      deviceClass: typeof obj.Class === 'string' ? obj.Class : undefined,
      status: typeof obj.Status === 'string' ? obj.Status : undefined,
    });
  }
  return entities;
}

/**
 * 从 PnP InstanceId 提取 USB 身份。
 * 例：USB\VID_0483&PID_3748\00000000001A → { vid:1155, pid:14152, serial:'00000000001A' }
 * Windows 自动生成的实例段（如 6&27E5B6D&0&0000）不是真实序列号 → serial 置空。
 */
export function extractUsbIdentity(pnpDeviceId: string): {
  vid: number;
  pid: number;
  serial?: string;
} | null {
  const parts = pnpDeviceId.split('\\');
  if (parts.length < 3 || parts[0].toUpperCase() !== 'USB') return null;
  const m = /^VID_([0-9A-Fa-f]{4})&PID_([0-9A-Fa-f]{4})/.exec(parts[1]);
  if (!m) return null;
  const instance = parts.slice(2).join('\\').trim();
  // Windows 自动实例段形如 "6&27E5B6D&0&0000"（无真实序列号的设备）——不能当探针序列号
  const serial = instance.length > 0 && !/^[0-9]+&/.test(instance) ? instance : undefined;
  return { vid: parseInt(m[1], 16), pid: parseInt(m[2], 16), serial };
}

/** 从设备名提取 COM 口，如 "ST-Link Virtual COM Port (COM7)" → "COM7" */
export function extractComPort(name: string): string | undefined {
  const m = /\((COM\d+)\)/i.exec(name);
  return m ? m[1].toUpperCase() : undefined;
}

export interface SerialPortInfoLike {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  vendorId?: string;
  productId?: string;
}

function parseHexOrZero(value: string | undefined): number {
  if (!value) return 0;
  const normalized = value.replace(/^0x/i, '');
  const parsed = parseInt(normalized, 16);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** serialport 列表项 → DeviceIdentity（VID/PID 未知时为 0：绑定必须人工确认） */
export function identityFromSerialPortInfo(port: SerialPortInfoLike): DeviceIdentity {
  return {
    usbVid: parseHexOrZero(port.vendorId),
    usbPid: parseHexOrZero(port.productId),
    probeSerial: port.serialNumber && port.serialNumber.length > 0 ? port.serialNumber : undefined,
    serialPort: port.path,
    displayName: port.manufacturer,
    source: 'usb_hub',
  };
}

/**
 * 枚举合并（纯函数）：USB 实体 + 串口列表 → EnumeratedDevice[]。
 * - PnP 已覆盖的 COM 口不重复；PnP 未覆盖的串口以 serialport 元信息补充
 * - heldPorts：本 runner 当前持有的端口（大写），对应设备 busy=true
 */
export function mergeEnumeratedDevices(
  entities: UsbPnpEntity[],
  ports: SerialPortInfoLike[],
  heldPorts: Iterable<string>,
): EnumeratedDevice[] {
  const allPorts = ports.map((p) => p.path);
  const heldUpper = new Set<string>();
  for (const p of heldPorts) heldUpper.add(p.toUpperCase());
  const devices: EnumeratedDevice[] = [];
  const seenPorts = new Set<string>();
  for (const entity of entities) {
    const usb = extractUsbIdentity(entity.pnpDeviceId);
    if (!usb) continue;
    const com = extractComPort(entity.name);
    if (com) seenPorts.add(com);
    devices.push({
      identity: {
        usbVid: usb.vid,
        usbPid: usb.pid,
        probeSerial: usb.serial,
        serialPort: com,
        displayName: entity.name || entity.deviceClass,
        source: 'usb_hub',
      },
      availableSerialPorts: allPorts,
      busy: com ? heldUpper.has(com) : false,
    });
  }
  for (const port of ports) {
    const upper = port.path.toUpperCase();
    if (seenPorts.has(upper)) continue;
    seenPorts.add(upper);
    devices.push({
      identity: identityFromSerialPortInfo(port),
      availableSerialPorts: allPorts,
      busy: heldUpper.has(upper),
    });
  }
  return devices;
}

/** 真实 powershell 枚举（本机调用；fixture 测试用 virtual-probe-enum.mjs 模拟输出）。失败/超时/非零退出抛错，由调用方回退 */
export async function enumerateUsbEntitiesViaPowerShell(timeoutMs = 15_000): Promise<UsbPnpEntity[]> {
  const encoded = Buffer.from(PNP_QUERY_SCRIPT, 'utf16le').toString('base64');
  const res = await runCapture(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeoutMs, maxOutputBytes: 4 * 1024 * 1024 },
  );
  if (res.spawnError) {
    throw new Error(`powershell 无法启动：${res.spawnError}`);
  }
  if (res.killed) {
    throw new Error(`powershell 枚举超时（${timeoutMs}ms），放弃 USB 枚举`);
  }
  if (res.code !== 0) {
    throw new Error(`powershell 枚举退出码 ${res.code}：${res.stderr.slice(0, 300)}`);
  }
  return parsePnpJsonOutput(res.stdout);
}
