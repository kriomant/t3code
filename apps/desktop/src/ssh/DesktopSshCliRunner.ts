import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";
import * as Option from "effect/Option";

import serverPackageJson from "../../../server/package.json" with { type: "json" };
import type { DesktopEnvironment } from "../app/DesktopEnvironment.ts";

declare const __T3CODE_BUILD_SSH_RUNTIME_VERSION__: string;

const buildSshRuntimeVersion =
  typeof __T3CODE_BUILD_SSH_RUNTIME_VERSION__ === "string"
    ? __T3CODE_BUILD_SSH_RUNTIME_VERSION__
    : "";

type RunnerEnvironment = Pick<
  DesktopEnvironment["Service"],
  "appVersion" | "isDevelopment" | "devRemoteT3ServerEntryPath"
>;

export function resolveDesktopSshCliRunner(
  environment: RunnerEnvironment,
  archiveVersionOverride = buildSshRuntimeVersion,
): RemoteT3RunnerOptions {
  const devRemoteEntryPath = Option.getOrUndefined(environment.devRemoteT3ServerEntryPath);
  if (environment.isDevelopment && devRemoteEntryPath !== undefined) {
    return { nodeScriptPath: devRemoteEntryPath, nodeEngineRange: serverPackageJson.engines.node };
  }
  // A custom desktop preview may have no corresponding published remote CLI archive.
  return { archiveVersion: archiveVersionOverride.trim() || environment.appVersion };
}
