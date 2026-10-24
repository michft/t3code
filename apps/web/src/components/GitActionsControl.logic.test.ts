import { SourceControlProviderKind, type VcsStatusResult } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { assert, describe, it } from "vite-plus/test";
import {
  buildMenuItems,
  requiresDefaultBranchConfirmation,
  resolveAutoFeatureBranchName,
  resolveDefaultBranchActionDialogCopy,
  resolveLiveThreadBranchUpdate,
  resolveQuickAction,
} from "./GitActionsControl.logic";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("git action progress presentation", () => {
  it("keeps the phase on the first row and hook output on the second", () => {
    assert.deepEqual(
      resolveGitActionProgressPresentation({
        isRunning: true,
        operation: "run_change_request",
        currentLabel: "Running pre-commit...",
        lastOutputLine: "Checking formatting and lint rules",
        phaseStartedAtMs: 1_000,
        hookStartedAtMs: 2_000,
      }),
      {
        status: "Running pre-commit...",
        output: "Checking formatting and lint rules",
        startedAtMs: 2_000,
      },
    );
  });

  it("omits empty output and supplies a brief startup label", () => {
    assert.deepEqual(
      resolveGitActionProgressPresentation({
        isRunning: true,
        operation: "run_change_request",
        currentLabel: "Running source control action",
        lastOutputLine: "  ",
        phaseStartedAtMs: 1_000,
        hookStartedAtMs: null,
      }),
      {
        status: "Starting source control action...",
        output: null,
        startedAtMs: 1_000,
      },
    );
  });

  it("presents pull progress inline without a second row", () => {
    assert.deepEqual(
      resolveGitActionProgressPresentation({
        isRunning: true,
        operation: "pull",
        currentLabel: "Pulling latest changes...",
        lastOutputLine: null,
        phaseStartedAtMs: 1_000,
        hookStartedAtMs: null,
      }),
      {
        status: "Pulling latest changes...",
        output: null,
        startedAtMs: 1_000,
      },
    );
  });

  it("does not present unrelated or completed actions", () => {
    const input = {
      isRunning: true,
      operation: "publish_repository",
      currentLabel: "Publishing repository",
      lastOutputLine: null,
      phaseStartedAtMs: 1_000,
      hookStartedAtMs: null,
    };

    assert.isNull(resolveGitActionProgressPresentation(input));
    assert.isNull(resolveGitActionProgressPresentation({ ...input, isRunning: false }));
  });

  it("formats compact elapsed time without allowing negative values", () => {
    assert.isNull(formatGitActionElapsed(null, 10_000));
    assert.equal(formatGitActionElapsed(10_000, 9_000), "0s");
    assert.equal(formatGitActionElapsed(10_000, 14_900), "4s");
    assert.equal(formatGitActionElapsed(10_000, 75_000), "1m 5s");
  });
});

describe("git action result toast timing", () => {
  it("keeps errors sticky and dismisses successes after visible time", () => {
    assert.deepEqual(resolveGitActionResultToastTiming("error"), {
      timeout: 0,
      dismissAfterVisibleMs: null,
    });
    assert.deepEqual(resolveGitActionResultToastTiming("success"), {
      timeout: 0,
      dismissAfterVisibleMs: 10_000,
    });
  });
});

describe("when: ref is clean and has an open PR", () => {
  it("resolveQuickAction rests in the disabled up-to-date state", () => {
    const quick = resolveQuickAction(
      status({
        pr: {
          number: 10,
          title: "Open PR",
          url: "https://example.com/pr/10",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Commit",
      disabled: true,
      hint: "Branch is up to date. No action needed.",
    });
  });

  it("buildMenuItems disables commit/push and omits the PR entry", () => {
    const items = buildMenuItems(
      status({
        pr: {
          number: 11,
          title: "Existing PR",
          url: "https://example.com/pr/11",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
    ]);
  });
});

describe("when: actions are busy", () => {
  it("resolveQuickAction returns running disabled state", () => {
    const quick = resolveQuickAction(status(), true);
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Commit",
      disabled: true,
      hint: "Git action in progress.",
    });
  });

  it("buildMenuItems disables all actions", () => {
    const items = buildMenuItems(status(), true);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: git status is unavailable", () => {
  it("resolveQuickAction returns unavailable disabled state", () => {
    const quick = resolveQuickAction(null, false);
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Commit",
      disabled: true,
      hint: "Git status is unavailable.",
    });
  });

  it("buildMenuItems returns no menu items", () => {
    const items = buildMenuItems(null, false);
    assert.deepEqual(items, []);
  });
});

describe("when: repository uses jj", () => {
  const jjStatus = status({
    driverKind: "jj",
    refName: null,
    workspaceRevision: "change-id",
    publishRef: null,
    hasWorkingTreeChanges: true,
  });

  it("enables workspace-aware finalization", () => {
    assert.deepEqual(resolveQuickAction(jjStatus, false), {
      label: "Finalize change",
      disabled: false,
      kind: "run_action",
      action: "commit",
    });
  });

  it("exposes only the finalize action", () => {
    assert.deepEqual(buildMenuItems(jjStatus, false), [
      {
        id: "commit",
        label: "Finalize change",
        disabled: false,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
    ]);
  });

  it("publishes only through an explicit workspace bookmark", () => {
    const publishRef = {
      kind: "bookmark" as const,
      name: "feature/phase-6",
      target: { commitId: "finalized-commit", changeId: "finalized-change" },
    };
    assert.deepEqual(resolveQuickAction(jjStatus, false, false, true, publishRef), {
      label: "Finalize & publish",
      disabled: false,
      kind: "run_action",
      action: "commit_push",
    });
    const cleanStatus = { ...jjStatus, hasWorkingTreeChanges: false };
    assert.deepEqual(resolveQuickAction(cleanStatus, false, false, true, publishRef), {
      label: "Publish feature/phase-6",
      disabled: false,
      kind: "run_action",
      action: "push",
    });
    assert.deepEqual(
      resolveQuickAction(cleanStatus, false, false, true, {
        ...publishRef,
        remoteName: "origin",
      }),
      {
        label: "Create change request",
        disabled: false,
        kind: "run_action",
        action: "create_pr",
      },
    );
  });

  it("prefers an explicit safe fetch when the tracked remote is ahead", () => {
    assert.deepEqual(resolveQuickAction({ ...jjStatus, behindCount: 1 }, false), {
      label: "Fetch updates",
      disabled: false,
      kind: "run_pull",
    });
  });

  it("opens an existing change request instead of offering to create another", () => {
    const openPrStatus = {
      ...jjStatus,
      hasWorkingTreeChanges: false,
      pr: {
        number: 106,
        title: "Phase 6 change request",
        url: "https://example.com/pr/106",
        baseRef: "main",
        headRef: "feature/phase-6",
        state: "open" as const,
      },
    };
    const publishRef = {
      kind: "bookmark" as const,
      name: "feature/phase-6",
      remoteName: "origin",
      target: { commitId: "finalized-commit", changeId: "finalized-change" },
    };

    assert.deepEqual(buildMenuItems(openPrStatus, false, true, publishRef), [
      {
        id: "pr",
        label: "View PR",
        disabled: false,
        icon: "pr",
        kind: "open_pr",
      },
    ]);
    assert.deepEqual(resolveQuickAction(openPrStatus, false, false, true, publishRef), {
      label: "View PR",
      disabled: false,
      kind: "open_pr",
    });
  });
});

describe("when: ref is clean, ahead, and has an open PR", () => {
  it("resolveQuickAction prefers push", () => {
    const quick = resolveQuickAction(
      status({
        aheadCount: 3,
        pr: {
          number: 13,
          title: "Open PR",
          url: "https://example.com/pr/13",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, { kind: "run_action", action: "push", label: "Push" });
  });
});

describe("when: ref is clean, up to date, and has no open PR", () => {
  it("enables create PR when synced with upstream but ahead of default, even with local changes", () => {
    const syncedFeature = status({
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 1,
      pr: null,
    });

    const quick = resolveQuickAction(syncedFeature, false);
    assert.deepInclude(quick, {
      label: "Create PR",
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    });

    const items = buildMenuItems(syncedFeature, false);
    assert.equal(items.find((item) => item.id === "pr")?.disabled, false);

    const dirtyFeature = { ...syncedFeature, hasWorkingTreeChanges: true };
    assert.equal(
      buildMenuItems(dirtyFeature, false).find((item) => item.id === "pr")?.disabled,
      false,
    );
  });
});

describe("when: on default ref without open PR", () => {
  it("resolveQuickAction returns commit and push when local changes exist", () => {
    const quick = resolveQuickAction(
      status({ refName: "main", hasWorkingTreeChanges: true }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
      disabled: false,
    });
  });
});

describe("when: ref has no upstream configured", () => {
  it("resolveQuickAction runs push and create PR when no upstream and commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "create_pr",
      label: "Push & create PR",
      disabled: false,
    });
  });

  it("resolveQuickAction publishes when no origin remote exists", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
      false,
      false,
    );
    assert.deepEqual(quick, {
      kind: "open_publish",
      label: "Publish repository",
      disabled: false,
    });
  });
});

describe("when: the ref is on GitLab", () => {
  const gitLab = {
    sourceControlProvider: {
      kind: SourceControlProviderKind.make("gitlab"),
      name: "GitLab",
      baseUrl: "https://gitlab.com",
    },
  };

  it("names merge requests in actions and the default-ref dialog", () => {
    const ahead = status({ ...gitLab, hasUpstream: false, aheadCount: 2 });
    assert.equal(resolveQuickAction(ahead, false).label, "Push & create MR");
    assert.equal(
      resolveQuickAction(status({ ...gitLab, hasWorkingTreeChanges: true }), false).label,
      "Commit, push & MR",
    );
    assert.equal(buildMenuItems(ahead, false).find((item) => item.id === "pr")?.label, "Create MR");

    const copy = resolveDefaultBranchActionDialogCopy({
      action: "create_pr",
      branchName: "main",
      includesCommit: false,
      terminology: sourceControlClients.get("gitlab").changeRequest,
    });
    assert.equal(copy.title, "Push & create MR from default ref?");
    assert.include(copy.description, "create a merge request on");
  });
});

describe("requiresDefaultBranchConfirmation", () => {
  it("requires confirmation for push actions on default ref", () => {
    assert.isFalse(requiresDefaultBranchConfirmation("commit", true));
    assert.isTrue(requiresDefaultBranchConfirmation("push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("create_pr", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push_pr", true));
    assert.isFalse(requiresDefaultBranchConfirmation("commit_push", false));
    assert.isFalse(requiresDefaultBranchConfirmation("push", false));
  });
});

describe("resolveLiveThreadBranchUpdate", () => {
  it("returns a branch update when live git status differs from stored thread metadata", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/old-ref",
      gitStatus: status({ refName: "effect-atom" }),
    });

    assert.deepEqual(update, {
      branch: "effect-atom",
    });
  });

  it("returns null when git status is detached HEAD but the thread already has a ref", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "effect-atom",
      gitStatus: status({ refName: null }),
    });

    assert.equal(update, null);
  });

  it("does not regress a semantic thread ref back to a temporary worktree ref", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "t3code/github-query-rate-limit",
      gitStatus: status({ refName: "t3code/bda76797" }),
    });

    assert.equal(update, null);
  });
});

describe("resolveAutoFeatureBranchName", () => {
  it("increments suffix when the preferred ref name already exists", () => {
    const ref = resolveAutoFeatureBranchName(
      ["main", "feature/fix-toast-copy", "feature/fix-toast-copy-2"],
      "fix toast copy",
    );
    assert.equal(ref, "feature/fix-toast-copy-3");
  });

  it("treats existing ref names as case-insensitive for collision checks", () => {
    const ref = resolveAutoFeatureBranchName(["Feature/Ticket-1"], "feature/ticket-1");
    assert.equal(ref, "feature/ticket-1-2");
  });
});
