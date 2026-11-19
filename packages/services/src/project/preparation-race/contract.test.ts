import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ProjectRepositoryContract, VirtualProject } from "#src/project-storage/contract.js";
import { createProjectService } from "#src/project/index.js";

it("PD07 同一草稿重复准备只分配一个目录，不影响无参调用", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-draft-prepare-"));
  const service = createProjectService({ workspaceDirectory: root, repository: vi.fn() });
  const draftId = "cc29167e-5a72-4c24-9e31-adcc584c73b4";
  try {
    const [a, b] = await Promise.all([
      service.prepareSession({ draftId }),
      service.prepareSession({ draftId }),
    ]);
    expect(a.workspacePath).toBe(b.workspacePath);
    expect(await readdir(root)).toHaveLength(1);
    expect((await service.prepareSession()).workspacePath).not.toBe(a.workspacePath);
    await expect(service.prepareSession({ draftId: "../../escape" })).rejects.toThrow();
    expect(await readdir(root)).toHaveLength(2);
    await rm(a.workspacePath, { recursive: true });
    await expect(service.prepareSession({ draftId, reuseDraft: true })).rejects.toThrow();
    expect(await readdir(root)).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not return a preparation result after its project was deleted during directory validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-prepare-delete-"));
  const project = {
    id: "p",
    hostId: "remote:server:s",
    roots: [{ rootPath: root, isPrimary: true, position: 0 }],
  } as VirtualProject;
  const readTree = vi
    .fn()
    .mockReturnValueOnce({ projects: [project], tasks: [] })
    .mockReturnValue({ projects: [], tasks: [] });
  const service = createProjectService({
    ownerHostId: project.hostId,
    workspaceDirectory: root,
    repository: async () => ({ readTree }) as unknown as ProjectRepositoryContract,
  });
  try {
    await expect(service.prepareSession({ projectId: "p" })).rejects.toThrow("project.not-found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 语义说明（有意偏离上游）：独立部署（Web + Agent）的存储 ownerHostId 是
// remote:server:<serverId>，但浏览器直连的 UI 只知道自己是本机，发来的是
// "local" 或省略 Host。上游把这两种请求一律按「远端未建项目」拒绝，导致
// Web 直连模式下新建/发送全部失败。本仓库以 Web 直连为主要 UX，因此约定：
// 只有**请求显式指向别的 Host** 时才施加「必须先建项目」「单根」约束；
// "local" 与省略 Host 视为本机，落到本进程自己的存储。
it("keeps create constraints for foreign hosts but accepts the local alias on server-scoped storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "remote-project-required-"));
  const project = {
    id: "empty",
    roots: [],
    hostId: "remote:server:s",
  } as unknown as VirtualProject;
  // 生产代码在补根后要求存在 primary root，且该目录可读。
  const initializeProjectRoot = vi.fn(() => ({
    ...project,
    roots: [{ rootPath: join(root, "empty"), isPrimary: true }],
  }));
  const service = createProjectService({
    ownerHostId: project.hostId,
    workspaceDirectory: root,
    repository: async () =>
      ({
        readTree: () => ({ projects: [project], tasks: [] }),
        initializeProjectRoot,
      }) as unknown as ProjectRepositoryContract,
  });
  try {
    // 外来 Host 且未指定项目：仍在目录副作用之前拒绝。
    await expect(
      service.prepareSession({ hostId: "remote:server:other" }),
    ).rejects.toThrow("project.host-offline");
    expect(initializeProjectRoot).not.toHaveBeenCalled();

    // 本机别名与省略 Host：允许分配本地草稿目录，不再要求先建项目。
    await expect(service.prepareSession({ hostId: "local" })).resolves.toMatchObject({
      projectId: null,
    });
    await expect(service.prepareSession()).resolves.toMatchObject({ projectId: null });

    // 本机请求指向空项目：补齐根目录而不是报错。
    await expect(
      service.prepareSession({ hostId: "local", projectId: project.id }),
    ).resolves.toMatchObject({ projectId: project.id });
    expect(initializeProjectRoot).toHaveBeenCalledTimes(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
