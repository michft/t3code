import { describe, expect, it } from "@effect/vitest";

import { capitalizeVcsTerm, getVcsPresentation } from "./vcsPresentation.ts";

describe("VCS presentation", () => {
  it("uses branch and worktree terms for Git", () => {
    expect(getVcsPresentation("git")).toMatchObject({
      refSingular: "branch",
      workspaceSingular: "worktree",
      currentRefFallback: "Detached HEAD",
    });
  });

  it("uses bookmark and workspace terms for Jujutsu", () => {
    expect(getVcsPresentation("jj")).toMatchObject({
      refSingular: "bookmark",
      workspaceSingular: "workspace",
      currentRefFallback: "Unbookmarked change",
    });
  });

  it("falls back to generic version control terms", () => {
    expect(getVcsPresentation(undefined).systemLabel).toBe("Version control");
    expect(capitalizeVcsTerm("workspace")).toBe("Workspace");
  });
});
