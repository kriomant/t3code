import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DesktopAppActivationRequest } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import {
  findDesktopAppSshEnvironment,
  handleDesktopAppActivationRequest,
} from "../../desktopAppActivation";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { findProjectByPath, inferProjectTitleFromPath } from "../../lib/projectPaths";
import { newProjectId } from "../../lib/utils";
import { readProjects, waitForProject } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { environmentShell, useEnvironmentShellHasSnapshot } from "../../state/shell";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { environmentCatalog } from "../../connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";

export function DesktopAppActivationCoordinator() {
  const primaryEnvironment = usePrimaryEnvironment();
  const { isReady: catalogReady, environments } = useEnvironments();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const openThread = useNewThreadHandler();
  const queueRef = useRef(Promise.resolve());
  const activation = window.desktopBridge?.appActivation;
  const shellHasSnapshot = useEnvironmentShellHasSnapshot(
    primaryEnvironment?.environmentId ?? null,
  );
  const ready =
    activation !== undefined &&
    catalogReady &&
    ((primaryEnvironment?.connection.phase === "connected" &&
      primaryEnvironment.serverConfig !== null &&
      shellHasSnapshot) ||
      environments.some(
        (environment) =>
          environment.entry.target._tag !== "PrimaryConnectionTarget" &&
          environment.connection.phase === "connected" &&
          environment.serverConfig !== null,
      ));

  const processRequest = useEffectEvent(async (request: DesktopAppActivationRequest) =>
    handleDesktopAppActivationRequest(request, {
      getTarget: (request) => {
        if (request.type === "open-ssh-workspace") {
          const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
          const environmentId = findDesktopAppSshEnvironment(
            request.sshAlias,
            catalog.entries.values(),
          );
          const environment = appAtomRegistry.get(
            environmentPresentations.presentationAtom(environmentId),
          );
          if (
            environment?.connection.phase !== "connected" ||
            environment.serverConfig === null ||
            !appAtomRegistry.get(environmentShell.hasSnapshotAtom(environmentId))
          ) {
            return null;
          }
          return { environmentId, platform: environment.serverConfig.environment.platform.os };
        }
        if (
          primaryEnvironment?.connection.phase !== "connected" ||
          primaryEnvironment.serverConfig === null ||
          !shellHasSnapshot
        ) {
          return null;
        }
        return {
          environmentId: primaryEnvironment.environmentId,
          platform: primaryEnvironment.serverConfig.environment.platform.os,
        };
      },
      findProject: (environmentId, workspaceRoot) =>
        findProjectByPath(
          readProjects().filter((project) => project.environmentId === environmentId),
          workspaceRoot,
        ) ?? null,
      createProject: async (environmentId, workspaceRoot) => {
        const projectId = newProjectId();
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            title: inferProjectTitleFromPath(workspaceRoot),
            workspaceRoot,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          throw error instanceof Error ? error : new Error("T3 Code could not add the project.");
        }
        return projectId;
      },
      waitForProject: async (projectRef) => {
        await waitForProject(projectRef);
      },
      openThread: (projectRef) => openThread(projectRef),
    }),
  );

  useEffect(() => {
    if (!ready || activation === undefined) return;

    let subscribed = true;
    const unsubscribe = activation.onRequest((request) => {
      queueRef.current = queueRef.current.then(async () => {
        const response = await processRequest(request);
        await activation.complete(response);
      });
      queueRef.current = queueRef.current.catch(() => undefined);
    });
    // Skip readiness if React runs cleanup before this subscription can receive requests.
    queueMicrotask(() => {
      if (subscribed) void activation.setReady(true).catch(() => undefined);
    });
    return () => {
      subscribed = false;
      void activation.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, [activation, ready]);

  return null;
}
