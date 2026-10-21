import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  GitPreparePullRequestThreadResult,
  GitRunStackedActionInput,
  GitResolvePullRequestResult,
  VcsStatusLocalResult,
  VcsPullResult,
} from "./git.ts";

const decodeGitCommandError = Schema.decodeUnknownSync(Schema.toCodecJson(GitCommandError));
const decodePreparePullRequestThreadResult = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadResult,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeRunStackedActionResult = Schema.decodeUnknownSync(GitRunStackedActionResult);
const decodeResolvePullRequestResult = Schema.decodeUnknownSync(GitResolvePullRequestResult);
const decodeStatusLocalResult = Schema.decodeUnknownSync(VcsStatusLocalResult);
const decodePullResult = Schema.decodeUnknownSync(VcsPullResult);

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

describe("VcsCreateWorktreeInput", () => {
  it("accepts omitted newRefName for existing-refName worktrees", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "feature/existing",
      path: "/tmp/worktree",
    });

    expect(parsed.newRefName).toBeUndefined();
    expect(parsed.refName).toBe("feature/existing");
  });

  it("accepts baseRefName metadata for a new worktree ref", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      refName: "0123456789abcdef",
      newRefName: "feature/new",
      baseRefName: "origin/main",
      path: "/tmp/worktree",
    });

    expect(parsed.baseRefName).toBe("origin/main");
  });

  it("accepts a thread id for VCS-neutral workspace creation", () => {
    const parsed = decodeCreateWorktreeInput({
      cwd: "/repo",
      threadId: "thread-workspace",
      refName: "main",
      path: null,
    });

    expect(parsed.threadId).toBe("thread-workspace");
  });
});

describe("GitPreparePullRequestThreadInput", () => {
  it("accepts pull request references and mode", () => {
    const parsed = decodePreparePullRequestThreadInput({
      cwd: "/repo",
      reference: "#42",
      mode: "worktree",
    });

    expect(parsed.reference).toBe("#42");
    expect(parsed.mode).toBe("worktree");
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

  it("rejects an empty file path", () => {
    expect(() =>
      decodeRunStackedActionInput({
        actionId: "action-1",
        cwd: "/repo",
        action: "commit",
        filePaths: [""],
      }),
    ).toThrow();
  });

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

describe("GitRunStackedActionResult", () => {
  it("decodes a server-authored completion toast", () => {
    const parsed = decodeRunStackedActionResult({
      action: "commit_push",
      branch: {
        status: "created",
        name: "feature/server-owned-toast",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: move toast state into git manager",
      },
      push: {
        status: "pushed",
        branch: "feature/server-owned-toast",
        upstreamBranch: "origin/feature/server-owned-toast",
      },
      pr: {
        status: "skipped_not_requested",
      },
      toast: {
        title: "Pushed 89abcde to origin/feature/server-owned-toast",
        description: "feat: move toast state into git manager",
        cta: {
          kind: "run_action",
          label: "Create PR",
          action: {
            kind: "create_pr",
          },
        },
      },
    });

    expect(parsed.toast.cta.kind).toBe("run_action");
    if (parsed.toast.cta.kind === "run_action") {
      expect(parsed.toast.cta.action.kind).toBe("create_pr");
    }
  });

  it("decodes jj finalized and new workspace revisions", () => {
    const parsed = decodeRunStackedActionResult({
      action: "commit",
      branch: { status: "created", name: "feature/jj-change" },
      commit: {
        status: "created",
        commitSha: "finalized-commit",
        subject: "Finalize jj change",
        finalizedRevision: { commitId: "finalized-commit", changeId: "finalized-change" },
        workspaceRevision: { commitId: "workspace-commit", changeId: "workspace-change" },
        publishRef: {
          kind: "bookmark",
          name: "feature/jj-change",
          target: { commitId: "finalized-commit", changeId: "finalized-change" },
        },
      },
      push: { status: "skipped_not_requested" },
      pr: { status: "skipped_not_requested" },
      toast: { title: "Finalized finaliz", cta: { kind: "none" } },
    });

    expect(parsed.commit.workspaceRevision?.changeId).toBe("workspace-change");
    expect(parsed.commit.publishRef?.kind).toBe("bookmark");
  });
});

describe("VcsStatusLocalResult", () => {
  const baseStatus = {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: true,
    refName: "main",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
  };

  it("requires variant-specific conflict details", () => {
    expect(
      decodeStatusLocalResult({
        ...baseStatus,
        conflicts: [
          { kind: "content", path: "conflicted.txt" },
          { kind: "named-ref", refName: "feature" },
        ],
      }).conflicts,
    ).toEqual([
      { kind: "content", path: "conflicted.txt" },
      { kind: "named-ref", refName: "feature" },
    ]);
    expect(() =>
      decodeStatusLocalResult({ ...baseStatus, conflicts: [{ kind: "content" }] }),
    ).toThrow();
    expect(() =>
      decodeStatusLocalResult({ ...baseStatus, conflicts: [{ kind: "named-ref" }] }),
    ).toThrow();
  });
});

describe("VcsStatusLocalResult", () => {
  it("preserves leading and trailing whitespace in working-tree paths", () => {
    const parsed = decodeStatusLocalResult({
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "main",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [
          { path: " leading.txt", insertions: 1, deletions: 0 },
          { path: "trailing.txt ", insertions: 0, deletions: 1 },
        ],
        insertions: 1,
        deletions: 1,
      },
    });

    expect(parsed.workingTree.files.map((file) => file.path)).toEqual([
      " leading.txt",
      "trailing.txt ",
    ]);
  });

  it("rejects an empty working-tree path", () => {
    expect(() =>
      decodeStatusLocalResult({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "main",
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [{ path: "", insertions: 0, deletions: 0 }],
          insertions: 0,
          deletions: 0,
        },
      }),
    ).toThrow();
  });
});
