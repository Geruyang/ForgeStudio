﻿﻿﻿/**
 * 任务向导：项目目录（ensureProject）→ profile 选择 → 模板勾选 → 手动项增删 → runner.createTask。
 */
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ok } from '../contracts/common';
import type { CreateTaskRequest } from '../contracts/runner';
import { TaskWizard } from '../views/TaskWizard';
import { makeTaskOverview } from './test-utils/fixtures';
import { makeSetup, renderWithStore } from './test-utils/render';

describe('任务向导 TaskWizard', () => {
  it('勾选模板项并创建任务：经 app.ensureProject → runner.createTask（含验收项）', async () => {
    const created: CreateTaskRequest[] = [];
    const setup = makeSetup({
      app: {
        ensureProject: async () => ok({ projectRoot: 'E:\\proj\\sample-tool', name: 'sample-tool' }),
      },
      runner: {
        createTask: async (req) => {
          created.push(req);
          return ok(makeTaskOverview({ id: 'task-9', title: req.title }));
        },
      },
    });
    setup.store.setState({ taskSetupOpen: 'create', project: null });
    renderWithStore(<TaskWizard />, setup);

    // 无既有任务 → profile 手动输入
    fireEvent.change(screen.getByTestId('wizard-profile-select'), { target: { value: '__manual__' } });
    fireEvent.change(screen.getByTestId('wizard-manual-profile'), { target: { value: 'sample-tool' } });

    // 模板默认勾选软件模板的部分项；取消"人工复核"
    const checks = screen.getAllByRole('checkbox');
    fireEvent.click(checks[2]);

    fireEvent.click(screen.getByTestId('wizard-submit'));
    await waitFor(() => expect(created.length).toBe(1));
    const req = created[0];
    expect(req.projectRoot).toBe('E:\\proj\\sample-tool');
    expect(req.title).toBe('软件缺陷修复任务');
    expect(req.acceptance?.length).toBe(2);
    expect(req.acceptance?.[0]).toMatchObject({ kind: 'executable', verifierId: 'software.build-pass' });
    // 向导关闭
    await waitFor(() => expect(setup.store.getState().taskSetupOpen).toBe(false));
  });

  it('可增删手动验收项并随请求提交', async () => {
    const created: CreateTaskRequest[] = [];
    const setup = makeSetup({
      app: { ensureProject: async () => ok({ projectRoot: 'E:\\proj', name: 'proj' }) },
      runner: {
        createTask: async (req) => {
          created.push(req);
          return ok(makeTaskOverview({ id: 'task-10' }));
        },
      },
    });
    setup.store.setState({
      taskSetupOpen: 'create',
      project: { root: 'E:\\proj', name: 'proj' },
      tasks: [makeTaskOverview({ id: 'task-a', profileId: 'sample-tool' })],
    });
    renderWithStore(<TaskWizard />, setup);

    fireEvent.click(screen.getByTestId('wizard-add-manual'));
    const inputs = screen.getAllByRole('textbox');
    const titleInput = inputs.find((el) => (el as HTMLInputElement).placeholder === '标题（必填）') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: '目视确认 LED' } });

    fireEvent.click(screen.getByTestId('wizard-submit'));
    await waitFor(() => expect(created.length).toBe(1));
    const manual = created[0].acceptance?.find((a) => a.title === '目视确认 LED');
    expect(manual).toMatchObject({ kind: 'manual', manualRequired: true, required: true });
  });

  it('profile 列表来自既有任务，也可手动输入', async () => {
    const created: CreateTaskRequest[] = [];
    const setup = makeSetup({
      app: { ensureProject: async () => ok({ projectRoot: 'E:\\proj', name: 'proj' }) },
      runner: {
        createTask: async (req) => {
          created.push(req);
          return ok(makeTaskOverview({ id: 'task-11' }));
        },
      },
    });
    setup.store.setState({
      taskSetupOpen: 'create',
      project: { root: 'E:\\proj', name: 'proj' },
      tasks: [makeTaskOverview({ id: 'task-a', profileId: 'sample-tool' })],
    });
    renderWithStore(<TaskWizard />, setup);
    expect(screen.getByTestId('wizard-profile-select')).toHaveTextContent('sample-tool');

    fireEvent.change(screen.getByTestId('wizard-profile-select'), { target: { value: '__manual__' } });
    fireEvent.change(screen.getByTestId('wizard-manual-profile'), { target: { value: 'forgedesk-self' } });
    fireEvent.click(screen.getByTestId('wizard-submit'));
    await waitFor(() => expect(created.length).toBe(1));
    expect(created[0].profileId).toBe('forgedesk-self');
  });
});
