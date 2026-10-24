import {
  SshConnectionProfile,
  SshConnectionTarget,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  handleDesktopAppActivationRequest,
  findDesktopAppSshEnvironment,
  type DesktopAppActivationDependencies,
} from "./desktopAppActivation";

const environmentId = EnvironmentId.make("primary");
const existingProjectId = ProjectId.make("project-existing");
const createdProjectId = ProjectId.make("project-created");
const threadId = ThreadId.make("thread-1");
const request = {
  version: 1,
  requestId: "request-1",
  type: "open-workspace",
  workspaceRoot: "/workspace/project",
  platform: "linux",
} as const;

function dependencies(
  overrides: Partial<DesktopAppActivationDependencies> = {},
): DesktopAppActivationDependencies {
  return {
    getTarget: () => ({ environmentId, platform: "linux" }),
    findProject: () => ({
      id: existingProjectId,
      environmentId,
      workspaceRoot: request.workspaceRoot,
      title: "project",
    }),
    createProject: vi.fn(async () => createdProjectId),
    renameProject: vi.fn(async () => undefined),
    waitForProject: vi.fn(async () => undefined),
    openThread: vi.fn(async () => ({ threadId })),
    ...overrides,
  };
}

describe("desktop app activation", () => {
  it("creates a named project using the explicit title", async () => {
    const deps = dependencies({ findProject: () => null });
    const title = "CLOUD-123 · branch's $(literal) + проект";
    const response = await handleDesktopAppActivationRequest({ ...request, title }, deps);
    expect(response).toMatchObject({ ok: true, projectId: createdProjectId });
    expect(deps.createProject).toHaveBeenCalledWith(environmentId, request.workspaceRoot, title);
    expect(deps.renameProject).not.toHaveBeenCalled();
  });

  it("renames an existing SSH project in its environment before opening the thread", async () => {
    const remoteId = EnvironmentId.make("remote");
    const order: string[] = [];
    const title = "feature/worktree-name";
    const deps = dependencies({
      getTarget: () => ({ environmentId: remoteId, platform: "linux" }),
      renameProject: vi.fn(async () => {
        order.push("rename");
      }),
      openThread: vi.fn(async () => {
        order.push("open");
        return { threadId };
      }),
    });
    const response = await handleDesktopAppActivationRequest(
      {
        version: 1,
        requestId: "named-ssh",
        type: "open-ssh-workspace",
        sshAlias: "devbox",
        workspaceRoot: "/work/feature/arcadia",
        title,
      },
      deps,
    );
    expect(response).toMatchObject({ ok: true, projectId: existingProjectId });
    expect(order).toEqual(["rename", "open"]);
    expect(deps.renameProject).toHaveBeenCalledWith(
      { environmentId: remoteId, projectId: existingProjectId },
      title,
    );
    expect(deps.createProject).not.toHaveBeenCalled();
  });

  it("preserves existing names when no title is supplied or the title already matches", async () => {
    const deps = dependencies();
    await handleDesktopAppActivationRequest(request, deps);
    await handleDesktopAppActivationRequest({ ...request, title: "project" }, deps);
    expect(deps.renameProject).not.toHaveBeenCalled();
  });

  it("does not open a thread when renaming fails", async () => {
    const deps = dependencies({
      renameProject: vi.fn(async () => {
        throw new Error("Rename denied");
      }),
    });
    const response = await handleDesktopAppActivationRequest(
      { ...request, title: "feature" },
      deps,
    );
    expect(response).toMatchObject({
      ok: false,
      code: "project-update-failed",
      message: "Rename denied",
    });
    expect(deps.openThread).not.toHaveBeenCalled();
  });

  it("opens the exact remote path in the selected SSH environment, regardless of the local platform", async () => {
    const remoteId = EnvironmentId.make("ssh-environment");
    const workspaceRoot = "/remote/my project's + & # ? = %2F/проект";
    const deps = dependencies({
      getTarget: vi.fn(() => ({ environmentId: remoteId, platform: "linux" as const })),
      findProject: vi.fn(() => null),
    });
    const sshRequest = {
      version: 1,
      requestId: "ssh-request",
      type: "open-ssh-workspace",
      sshAlias: "devbox",
      workspaceRoot,
    } as const;

    const response = await handleDesktopAppActivationRequest(sshRequest, deps);

    expect(response).toMatchObject({ ok: true, projectId: createdProjectId });
    expect(deps.getTarget).toHaveBeenCalledWith(sshRequest);
    expect(deps.createProject).toHaveBeenCalledWith(remoteId, workspaceRoot, undefined);
    expect(deps.openThread).toHaveBeenCalledWith({
      environmentId: remoteId,
      projectId: createdProjectId,
    });
  });

  it("rejects relative remote paths before selecting an environment", async () => {
    const deps = dependencies({ getTarget: vi.fn(() => null) });
    const response = await handleDesktopAppActivationRequest(
      {
        version: 1,
        requestId: "ssh-request",
        type: "open-ssh-workspace",
        sshAlias: "devbox",
        workspaceRoot: "relative/project",
      },
      deps,
    );
    expect(response).toMatchObject({ ok: false, code: "invalid-request" });
    expect(deps.getTarget).not.toHaveBeenCalled();
    expect(deps.openThread).not.toHaveBeenCalled();
  });

  it("reports SSH resolution errors without falling back to the local environment", async () => {
    const deps = dependencies({
      getTarget: () => {
        throw new Error("Connect devbox in Settings first.");
      },
    });
    const response = await handleDesktopAppActivationRequest(
      {
        version: 1,
        requestId: "ssh-request",
        type: "open-ssh-workspace",
        sshAlias: "devbox",
        workspaceRoot: "/remote/project",
      },
      deps,
    );
    expect(response).toMatchObject({
      ok: false,
      code: "environment-unavailable",
      message: "Connect devbox in Settings first.",
    });
    expect(deps.createProject).not.toHaveBeenCalled();
    expect(deps.openThread).not.toHaveBeenCalled();
  });

  it("waits for a created project before it opens the thread", async () => {
    const order: string[] = [];
    const deps = dependencies({
      findProject: () => null,
      createProject: vi.fn(async () => {
        order.push("create");
        return createdProjectId;
      }),
      waitForProject: vi.fn(async () => {
        order.push("project-event");
      }),
      openThread: vi.fn(async () => {
        order.push("open-thread");
        return { threadId };
      }),
    });

    const response = await handleDesktopAppActivationRequest(request, deps);

    expect(order).toEqual(["create", "project-event", "open-thread"]);
    expect(response).toMatchObject({ ok: true, projectId: createdProjectId });
  });

  it("rejects a Windows path when the primary environment is WSL", async () => {
    const response = await handleDesktopAppActivationRequest(
      { ...request, platform: "win32" },
      dependencies({ getTarget: () => ({ environmentId, platform: "linux" }) }),
    );

    expect(response).toMatchObject({ ok: false, code: "platform-mismatch" });
  });
});

function sshEntry(id: string, alias: string): ConnectionCatalogEntry {
  const target = new SshConnectionTarget({
    environmentId: EnvironmentId.make(id),
    label: alias,
    connectionId: id,
  });
  return {
    target,
    enabled: true,
    profile: Option.some(
      new SshConnectionProfile({
        environmentId: target.environmentId,
        label: alias,
        connectionId: id,
        target: { alias, hostname: "remote.example", username: "alice", port: 22 },
      }),
    ),
  };
}

describe("desktop SSH environment selection", () => {
  it("matches saved aliases exactly, including alternate routes", () => {
    const first = sshEntry("first", "devbox");
    const second = sshEntry("second", "other");
    expect(findDesktopAppSshEnvironment("devbox", [first, second])).toBe(
      first.target.environmentId,
    );
    expect(
      findDesktopAppSshEnvironment("other", [
        { ...first, alternateRoutes: [sshEntry("first", "other")] },
      ]),
    ).toBe(first.target.environmentId);
    expect(() => findDesktopAppSshEnvironment("remote.example", [first])).toThrow("Settings");
  });

  it("rejects missing, disabled and ambiguous aliases", () => {
    expect(() => findDesktopAppSshEnvironment("devbox", [])).toThrow("Settings");
    expect(() =>
      findDesktopAppSshEnvironment("devbox", [{ ...sshEntry("first", "devbox"), enabled: false }]),
    ).toThrow("Enable");
    expect(() =>
      findDesktopAppSshEnvironment("devbox", [
        sshEntry("first", "devbox"),
        sshEntry("second", "devbox"),
      ]),
    ).toThrow("Several");
  });
});
