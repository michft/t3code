import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  GitPreparePullRequestThreadResult,
  GitRunStackedActionInput,
  VcsPullResult,
} from "./git.ts";

const decodeGitCommandError = Schema.decodeUnknownSync(Schema.toCodecJson(GitCommandError));
const decodePreparePullRequestThreadResult = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadResult,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);

describe("GitCommandError", () => {
  it("decodes an unknown failure reason as absent", () => {
    const error = decodeGitCommandError({
      _tag: "GitCommandError",
      operation: "GitVcsDriver.createWorktree",
      command: "git",
      cwd: "/repo",
      detail: "git worktree add failed",
      reason: "added_by_a_newer_server",
    });

    expect(error.reason).toBeUndefined();
    expect(error.message).toBe(
      "Git command failed in GitVcsDriver.createWorktree (/repo): git worktree add failed",
    );
  });
});

describe("GitPreparePullRequestThreadResult", () => {
  it("defaults legacy responses to the pull request head", () => {
    const parsed = decodePreparePullRequestThreadResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
      branch: "feature/pr-threads",
      worktreePath: "/tmp/pr-threads",
    });

    expect(parsed.isOnPullRequestHead).toBe(true);
  });
});

describe("GitRunStackedActionInput", () => {
  it("preserves leading and trailing whitespace in file paths", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      filePaths: [" leading.txt", "trailing.txt "],
    });

    expect(parsed.filePaths).toEqual([" leading.txt", "trailing.txt "]);
  });
});

const decodePullResult = Schema.decodeUnknownSync(VcsPullResult);
describe("VcsPullResult", () => {
  it("preserves structured jj fetch recovery state", () => {
    const parsed = decodePullResult({
      status: "fetched_needs_rebase",
      refName: "main",
      upstreamRef: "main@origin",
      workspaceRevision: { commitId: "workspace-commit", changeId: "workspace-change" },
      conflicts: [],
    });

    expect(parsed.status).toBe("fetched_needs_rebase");
    expect(parsed.workspaceRevision?.changeId).toBe("workspace-change");
  });
});

describe("Jujutsu publish input", () => {
  it("accepts an explicit jj publish bookmark", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-jj-publish",
      cwd: "/repo",
      action: "push",
      publishRef: {
        kind: "bookmark",
        name: "feature/phase-6",
        target: { commitId: "published-commit", changeId: "published-change" },
      },
    });

    expect(parsed.publishRef?.name).toBe("feature/phase-6");
  });
});
