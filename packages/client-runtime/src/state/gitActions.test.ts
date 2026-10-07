import type { VcsNamedRef, VcsStatusResult } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import { buildMenuItems, resolveQuickAction } from "./gitActions.ts";

const publishRef: VcsNamedRef = {
  kind: "bookmark",
  name: "feature/phase-6",
  remoteName: "origin",
  target: { commitId: "finalized-commit", changeId: "finalized-change" },
};

const status: VcsStatusResult = {
  isRepo: true,
  driverKind: "jj",
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: null,
  workspaceRevision: "workspace-change",
  publishRef: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: {
    number: 106,
    title: "Phase 6 change request",
    url: "https://example.com/pr/106",
    baseRef: "main",
    headRef: publishRef.name,
    state: "open",
  },
};

describe("jj git actions", () => {
  it("opens an existing PR instead of offering to create another", () => {
    assert.deepEqual(buildMenuItems(status, false, true, publishRef), [
      {
        id: "pr",
        label: "View PR",
        disabled: false,
        icon: "pr",
        kind: "open_pr",
      },
    ]);
    assert.deepEqual(resolveQuickAction(status, false, false, true, publishRef), {
      label: "View PR",
      disabled: false,
      kind: "open_pr",
    });
  });
});
