﻿﻿﻿/**
 * 设备区：绑定状态 / 独占占用 / 串口最新一行 / 离线提示保留旧证据；
 * 未绑定的枚举设备提供绑定表单（须填写身份证据）。
 */
import { useState } from 'react';
import type { TaskOverview } from '../../contracts/engineering';
import type { EnumeratedDevice } from '../../contracts/device';
import { useAppStore } from '../../store/context';
import { Badge, StatusChip } from '../common/Badge';
import { formatClock } from '../../lib/format';

export function DeviceSection({ task, devices }: { task: TaskOverview; devices: EnumeratedDevice[] }) {
  const diagnostics = useAppStore((s) => s.diagnostics);
  const serialLogs = useAppStore((s) => s.serialLogs);
  const artifacts = task.artifacts;
  const firmware = artifacts.find((a) => a.type === 'firmware_elf') ?? artifacts.find((a) => a.type === 'firmware_bin') ?? artifacts[0];

  // 绑定状态来自真实操作记录（device_bind 成功 → deviceBindingId）
  const boundOps = task.operations
    .filter((o) => o.type === 'device_bind' && o.status === 'succeeded' && o.deviceBindingId)
    .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));
  const seen = new Set<string>();
  const bindings = boundOps
    .filter((o) => {
      if (!o.deviceBindingId || seen.has(o.deviceBindingId)) return false;
      seen.add(o.deviceBindingId);
      return true;
    })
    .map((o) => ({ bindingId: o.deviceBindingId!, op: o }));

  const latestSerial = serialLogs.length > 0 ? serialLogs[serialLogs.length - 1] : null;

  return (
    <div className="acceptance" data-testid="device-section">
      {bindings.length === 0 && devices.length === 0 && (
        <div className="device-row">
          <div className="device-row__head">
            <span className="device-row__name">设备不可用</span>
            <Badge tone="warn">未检测到设备</Badge>
          </div>
          <div className="device-row__meta">请连接目标板卡后刷新；软件任务不需要设备。</div>
        </div>
      )}
      {bindings.map(({ bindingId }) => {
        const locked = diagnostics?.activeDeviceLock === bindingId;
        return (
          <div key={bindingId} className="device-row" data-testid="device-bound">
            <div className="device-row__head">
              <span className="device-row__name">已绑定设备</span>
              <span>
                <StatusChip tone={locked ? 'info' : 'ok'} pulse={locked}>
                  {locked ? '独占占用中' : '已绑定'}
                </StatusChip>
              </span>
              {task.hasStaleEvidence && <Badge tone="warn">设备离线提示：证据保留但已过期</Badge>}
            </div>
            <div className="device-row__meta">
              <span>
                绑定 <span className="fd-code">{bindingId}</span>
              </span>
            </div>
            <div className="device-row__meta">
              串口最新一行：
              {latestSerial ? (
                <span className="fd-code" style={{ color: latestSerial.ok ? 'var(--ok)' : 'var(--danger)' }}>
                  {formatClock(latestSerial.at)} {latestSerial.text.split('\n')[0].slice(0, 80)}
                </span>
              ) : (
                <span style={{ color: 'var(--text-faint)' }}>（暂无串口数据）</span>
              )}
            </div>
            <BindActions task={task} bindingId={bindingId} firmwareId={firmware?.id} />
          </div>
        );
      })}
      {devices.map((d, i) => (
        <UnboundDeviceForm key={`${d.identity.usbVid}:${d.identity.usbPid}:${i}`} task={task} device={d} />
      ))}
      {devices.length === 0 && bindings.length > 0 && (
        <div className="device-row">
          <div className="device-row__meta">
            当前未枚举到在线设备——旧证据保留显示，重新连接后需重新验证（设备授权与烧录不会自动重放）。
          </div>
        </div>
      )}
    </div>
  );
}

function BindActions({ task, bindingId, firmwareId }: { task: TaskOverview; bindingId: string; firmwareId?: string }) {
  const flashArtifact = useAppStore((s) => s.flashArtifact);
  const verifySerial = useAppStore((s) => s.verifySerial);
  const refreshDevices = useAppStore((s) => s.refreshDevices);
  const busyTools = useAppStore((s) => s.busyTools);
  const serialVerifier = task.acceptance.find((a) => a.kind === 'executable' && /serial|identity/i.test(a.verifierId ?? ''));
  return (
    <div className="panel__task-actions">
      <button
        type="button"
        className="fd-btn fd-btn--small"
        disabled={!firmwareId || busyTools.includes(`flash:${firmwareId}`)}
        title={firmwareId ? '' : '先构建产生固件产物'}
        onClick={() => firmwareId && void flashArtifact(task.id, firmwareId, bindingId)}
        data-testid="flash-btn"
      >
        烧录固件（需授权）
      </button>
      <button
        type="button"
        className="fd-btn fd-btn--small"
        disabled={!serialVerifier?.verifierId}
        title={serialVerifier?.verifierId ? '' : '验收单缺少串口验证定义'}
        onClick={() => serialVerifier?.verifierId && void verifySerial(task.id, serialVerifier.verifierId, bindingId)}
        data-testid="verify-btn"
      >
        串口验证
      </button>
      <button type="button" className="fd-btn fd-btn--ghost fd-btn--small" onClick={() => void refreshDevices()}>
        刷新设备
      </button>
    </div>
  );
}

function UnboundDeviceForm({ task, device }: { task: TaskOverview; device: EnumeratedDevice }) {
  const bindDevice = useAppStore((s) => s.bindDevice);
  const [evidence, setEvidence] = useState('');
  const id = device.identity;
  return (
    <div className="device-row" data-testid="device-unbound">
      <div className="device-row__head">
        <span className="device-row__name">{id.displayName ?? `USB 设备 ${id.usbVid.toString(16).padStart(4, '0')}:${id.usbPid.toString(16).padStart(4, '0')}`}</span>
        {device.busy ? <Badge tone="info">被占用</Badge> : <Badge tone="neutral">未绑定</Badge>}
        {id.chipTarget && <Badge tone="neutral">{id.chipTarget}</Badge>}
        {id.probeSerial ? (
          <span className="fd-code" style={{ fontSize: 10 }}>
            SN {id.probeSerial}
          </span>
        ) : (
          <Badge tone="warn">无序列号 · 绑定需人工确认</Badge>
        )}
      </div>
      <div className="device-row__meta">
        {device.availableSerialPorts.length > 0 ? `串口 ${device.availableSerialPorts.join(', ')}` : '无串口'}
        {device.probeSummary ? ` · ${device.probeSummary}` : ''}
      </div>
      <div className="binding-form">
        <label className="fd-form__label" htmlFor={`ev-${id.usbPid}`}>
          身份证据（如何确认这块板就是目标板）
        </label>
        <textarea
          id={`ev-${id.usbPid}`}
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          placeholder="例：板上丝印 STM32F103CB，LED 每 2 秒闪烁一次，与我标注的目标板一致。"
        />
        <div>
          <button
            type="button"
            className="fd-btn fd-btn--small"
            disabled={!evidence.trim() || device.busy}
            onClick={() => void bindDevice(task.id, task.profileId, device, evidence)}
            data-testid="bind-btn"
          >
            绑定该设备（提交授权）
          </button>
        </div>
      </div>
    </div>
  );
}
