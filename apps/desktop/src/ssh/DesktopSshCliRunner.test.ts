import { buildRemoteT3RunnerScript } from "@t3tools/ssh/tunnel";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { resolveDesktopSshCliRunner } from "./DesktopSshCliRunner.ts";

const preview = {
  appVersion: "0.1.1-preview.20261024.1",
  isDevelopment: false,
  devRemoteT3ServerEntryPath: Option.none<string>(),
};
const publishedVersion = "0.1.2-nightly.20261022.3512";

describe("desktop SSH runtime selection", () => {
  it("uses the app version for ordinary release builds", () => {
    expect(resolveDesktopSshCliRunner({ ...preview, appVersion: publishedVersion })).toEqual({
      archiveVersion: publishedVersion,
    });
  });

  it("uses the published override in the bootstrap script instead of an unpublished preview version", () => {
    const runner = resolveDesktopSshCliRunner(preview, publishedVersion);
    expect(runner).toEqual({ archiveVersion: publishedVersion });
    const script = buildRemoteT3RunnerScript(runner);
    expect(script).toContain(`T3_ARCHIVE_VERSION='${publishedVersion}'`);
    expect(script).not.toContain(preview.appVersion);
  });

  it("trims the override and treats whitespace as absent", () => {
    expect(resolveDesktopSshCliRunner(preview, ` ${publishedVersion} `)).toEqual({
      archiveVersion: publishedVersion,
    });
    expect(resolveDesktopSshCliRunner({ ...preview, appVersion: publishedVersion }, "  ")).toEqual({
      archiveVersion: publishedVersion,
    });
  });

  it("keeps an explicit development server path ahead of a release override", () => {
    expect(
      resolveDesktopSshCliRunner(
        {
          ...preview,
          isDevelopment: true,
          devRemoteT3ServerEntryPath: Option.some("/work/server/bin.mjs"),
        },
        publishedVersion,
      ),
    ).toMatchObject({
      nodeScriptPath: "/work/server/bin.mjs",
      nodeEngineRange: expect.any(String),
    });
  });

  it("ignores development server paths in packaged builds", () => {
    expect(
      resolveDesktopSshCliRunner(
        {
          ...preview,
          devRemoteT3ServerEntryPath: Option.some("/work/server/bin.mjs"),
        },
        publishedVersion,
      ),
    ).toEqual({ archiveVersion: publishedVersion });
  });
});
