import { connectionRoutes, type ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import type {
  DesktopAppActivationFailure,
  DesktopAppActivationRequest,
  DesktopAppActivationResponse,
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ProjectId,
  ScopedProjectRef,
  ThreadId,
} from "@t3tools/contracts";

export interface DesktopAppActivationProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly title: string;
}

export interface DesktopAppActivationTarget {
  readonly environmentId: EnvironmentId;
  readonly platform: ExecutionEnvironmentPlatformOs;
}

export interface DesktopAppActivationDependencies {
  readonly getTarget: (request: DesktopAppActivationRequest) => DesktopAppActivationTarget | null;
  readonly findProject: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
  ) => DesktopAppActivationProject | null;
  readonly createProject: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
    title?: string,
  ) => Promise<ProjectId>;
  readonly renameProject: (projectRef: ScopedProjectRef, title: string) => Promise<void>;
  readonly waitForProject: (projectRef: ScopedProjectRef) => Promise<void>;
  readonly openThread: (
    projectRef: ScopedProjectRef,
  ) => Promise<{ readonly threadId: ThreadId } | null>;
}

function failure(
  requestId: string,
  code: DesktopAppActivationFailure["code"],
  message: string,
): DesktopAppActivationFailure {
  return { version: 1, requestId, ok: false, code, message };
}

function desktopPlatformToEnvironmentOs(
  platform: Extract<DesktopAppActivationRequest, { type: "open-workspace" }>["platform"],
): ExecutionEnvironmentPlatformOs {
  return platform === "win32" ? "windows" : platform;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export async function handleDesktopAppActivationRequest(
  request: DesktopAppActivationRequest,
  dependencies: DesktopAppActivationDependencies,
): Promise<DesktopAppActivationResponse> {
  if (
    request.type === "open-ssh-workspace" &&
    (!request.workspaceRoot.startsWith("/") || request.workspaceRoot.includes("\0"))
  ) {
    return failure(
      request.requestId,
      "invalid-request",
      "The SSH workspace must be an absolute remote path.",
    );
  }
  let target: DesktopAppActivationTarget | null;
  try {
    target = dependencies.getTarget(request);
  } catch (error) {
    return failure(
      request.requestId,
      "environment-unavailable",
      errorMessage(error, "The environment is not connected."),
    );
  }
  if (target === null) {
    return failure(
      request.requestId,
      "environment-unavailable",
      request.type === "open-ssh-workspace"
        ? `Connect ${request.sshAlias} in Settings → Connections before opening this project.`
        : "The desktop app's primary local environment is not connected.",
    );
  }

  const requestPlatform =
    request.type === "open-workspace" ? desktopPlatformToEnvironmentOs(request.platform) : null;
  if (requestPlatform !== null && requestPlatform !== target.platform) {
    return failure(
      request.requestId,
      "platform-mismatch",
      `The command path is for ${requestPlatform}, but the desktop app's primary environment uses ${target.platform}. Cross-platform path mapping is not supported.`,
    );
  }

  const existing = dependencies.findProject(target.environmentId, request.workspaceRoot);
  let projectId = existing?.id ?? null;
  if (projectId === null) {
    try {
      projectId = await dependencies.createProject(
        target.environmentId,
        request.workspaceRoot,
        request.title,
      );
      await dependencies.waitForProject({ environmentId: target.environmentId, projectId });
    } catch (error) {
      return failure(
        request.requestId,
        "project-create-failed",
        errorMessage(error, "T3 Code could not add the project."),
      );
    }
  }

  if (existing !== null && request.title !== undefined && existing.title !== request.title) {
    try {
      await dependencies.renameProject(
        { environmentId: target.environmentId, projectId: existing.id },
        request.title,
      );
    } catch (error) {
      return failure(
        request.requestId,
        "project-update-failed",
        errorMessage(error, "T3 Code could not rename the project."),
      );
    }
  }

  try {
    const opened = await dependencies.openThread({
      environmentId: target.environmentId,
      projectId,
    });
    if (opened === null) {
      return failure(
        request.requestId,
        "thread-open-failed",
        "T3 Code could not open a new thread for the project.",
      );
    }
    return {
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId,
      threadId: opened.threadId,
    };
  } catch (error) {
    return failure(
      request.requestId,
      "thread-open-failed",
      errorMessage(error, "T3 Code could not open a new thread for the project."),
    );
  }
}

export function findDesktopAppSshEnvironment(
  alias: string,
  entries: Iterable<ConnectionCatalogEntry>,
): EnvironmentId {
  const matches = Array.from(entries).filter((entry) =>
    connectionRoutes(entry).some((route) => {
      const profile = Option.getOrNull(route.profile);
      return profile?._tag === "SshConnectionProfile" && profile.target.alias === alias;
    }),
  );
  if (matches.length > 1) {
    throw new Error(
      `Several saved environments use SSH alias ${alias}. Remove the duplicate in Settings → Connections.`,
    );
  }
  const entry = matches[0];
  if (entry === undefined) {
    throw new Error(`Add ${alias} through Settings → Connections → Add environment → SSH first.`);
  }
  if (!entry.enabled) {
    throw new Error(`Enable ${alias} in Settings → Connections before opening this project.`);
  }
  return entry.target.environmentId;
}
