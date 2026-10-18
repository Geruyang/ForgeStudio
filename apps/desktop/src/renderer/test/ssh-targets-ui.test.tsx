/**
 * 远程目标呈现（Z3）：profile 带 ssh 命令时 EngineeringPanel 显示目标行；
 * 无 ssh 目标的 profile 不渲染（不虚报）。数据来自 store.profileSummaries。
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

describe('EngineeringPanel：远程目标行（SshTargetsRow）', () => {
  it('profile 含 SSH 目标 → 显示 host:port/用户/密码变量名（不含密码值）', () => {
    renderPanel([withSsh], 'fz3b-make');
    const row = screen.getByTestId('ssh-targets-row');
    expect(row).toHaveTextContent('169.254.220.254:22');
    expect(row).toHaveTextContent('ubuntu');
    expect(row).toHaveTextContent('FZ3B_PASSWORD');
    expect(row.textContent).not.toMatch(/ubuntu:\S+|密码\s*=/); // 只呈现变量名与用户名，不呈现密码值
  });

  it('profile 无 SSH 目标 → 不渲染该行', () => {
    renderPanel([{ ...withSsh, id: 'plain', sshTargets: [] }], 'plain');
    expect(screen.queryByTestId('ssh-targets-row')).not.toBeInTheDocument();
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
