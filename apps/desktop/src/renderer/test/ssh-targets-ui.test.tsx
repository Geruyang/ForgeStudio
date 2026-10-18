/**
 * 远程设备呈现（Z3 + Z4 整合）：SSH 目标并入设备区语义——
 * 每目标一张「远程设备（SSH 板卡）」卡（凭据徽标即授权状态）；设备区标题携带远程计数、
 * 有远程目标时默认展开；本地设备空态如实说明"经 SSH 远程设备执行"。
 * 无 ssh 目标的 profile 不渲染远程卡（不虚报）。数据来自 store.profileSummaries。
 */
import { screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProfileSummary } from '../contracts/runner';
import { EngineeringPanel } from '../views/EngineeringPanel';
import { makeTaskOverview } from './test-utils/fixtures';
import { makeSetup, renderWithStore } from './test-utils/render';
import { ok } from '../contracts/common';

const withSsh: ProfileSummary = {
  id: 'fz3b-make',
  revision: 1,
  title: 'FZ3B 板上工程',
  kind: 'software',
  fileSha256: 'a'.repeat(64),
  source: 'user',
  sshTargets: [{ host: '169.254.220.254', port: 22, username: 'ubuntu', passwordEnv: 'FZ3B_PASSWORD' }],
};

function renderPanel(profileSummaries: ProfileSummary[], profileId: string) {
  const setup = makeSetup();
  const task = makeTaskOverview({ id: 'task-1', profileId });
  setup.store.setState({ tasks: [task], activeTaskId: 'task-1', profileSummaries });
  renderWithStore(<EngineeringPanel />, setup);
  return setup;
}

describe('EngineeringPanel：远程设备卡（SshTargetsRow，Z4 整合后）', () => {
  it('profile 含 SSH 目标 → 设备区默认展开，远程设备卡显示 host:port/用户/变量名（不含密码值）', () => {
    renderPanel([withSsh], 'fz3b-make');
    const row = screen.getByTestId('ssh-targets-row');
    expect(row).toHaveTextContent('远程设备（SSH 板卡）');
    expect(row).toHaveTextContent('169.254.220.254:22');
    expect(row).toHaveTextContent('ubuntu');
    expect(row).toHaveTextContent('FZ3B_PASSWORD');
    expect(row.textContent).not.toMatch(/ubuntu:\S+|密码\s*=/); // 只呈现变量名与用户名，不呈现密码值
    // 设备区标题携带远程计数
    expect(screen.getByText(/设备.*远程 1/)).toBeInTheDocument();
    // 本地设备空态如实说明（不再误报"设备不可用"）
    expect(screen.getByTestId('device-empty')).toHaveTextContent('本任务经 SSH 远程设备执行');
    expect(screen.queryByText('设备不可用')).not.toBeInTheDocument();
  });

  it('profile 无 SSH 目标 → 不渲染远程设备卡；本地空态保持原口径', () => {
    renderPanel([{ ...withSsh, id: 'plain', sshTargets: [] }], 'plain');
    expect(screen.queryByTestId('ssh-targets-row')).not.toBeInTheDocument();
    // 设备区默认收起，展开后空态为"设备不可用"（无远程目标）
    expect(screen.queryByText('本任务经 SSH 远程设备执行')).not.toBeInTheDocument();
  });
});

describe('EngineeringPanel：SSH 凭据管理交互', () => {
  it('未配置 → 「密码未配置」徽标 + 配置按钮；输入密码回车 → 调用 set + 刷新状态', async () => {
    const setup = makeSetup({
      app: {
        sshCredentialSet: async () => ok({ restartRequired: true }),
        sshCredentialNames: async () => ok(['FZ3B_PASSWORD']),
      },
    });
    const task = makeTaskOverview({ id: 'task-1', profileId: 'fz3b-make' });
    setup.store.setState({
      tasks: [task], activeTaskId: 'task-1', profileSummaries: [withSsh], sshCredentialNames: [],
    });
    renderWithStore(<EngineeringPanel />, setup);
    expect(screen.getByText('密码未配置')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ssh-credential-btn'));
    const input = screen.getByTestId('ssh-credential-input');
    fireEvent.change(input, { target: { value: 'board-pass' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    await vi.waitFor(() => {
      expect(setup.bridge.calls.some((c) => c.method === 'app.sshCredentialSet' && c.args[0] === 'FZ3B_PASSWORD')).toBe(true);
    });
    // 刷新后（mock 返回已含 FZ3B_PASSWORD）显示已配置 + 清除按钮
    await vi.waitFor(() => expect(screen.getByText('密码已配置')).toBeInTheDocument());
    expect(screen.getByTestId('ssh-credential-clear-btn')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('board-pass')).not.toBeInTheDocument(); // 不回显
  });
});
