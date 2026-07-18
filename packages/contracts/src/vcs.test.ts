import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { VcsNamedRef, VcsThreadWorkspace, VcsWorkspaceIdentity } from "./vcs.ts";

const decodeThreadWorkspace = Schema.decodeUnknownSync(VcsThreadWorkspace);
const encodeThreadWorkspace = Schema.encodeSync(VcsThreadWorkspace);
const decodeWorkspaceIdentity = Schema.decodeUnknownSync(VcsWorkspaceIdentity);
const decodeNamedRef = Schema.decodeUnknownSync(VcsNamedRef);

describe("VCS-neutral persistence contracts", () => {
  it("reads legacy Git thread workspace metadata", () => {
    expect(
      decodeThreadWorkspace({
        version: 1,
        branch: "feature/legacy",
        worktreePath: "/tmp/legacy-worktree",
      }),
    ).toEqual({
      version: 1,
      branch: "feature/legacy",
      worktreePath: "/tmp/legacy-worktree",
    });
  });

  it("round-trips generic jj workspace metadata", () => {
    const workspace = decodeWorkspaceIdentity({
      driverKind: "jj",
      name: "thread-demo",
      rootPath: "/tmp/jj-workspace",
      workspaceRevision: { commitId: "abc123", changeId: "change123" },
      publishRef: { kind: "bookmark", name: "feature/demo" },
    });
    const encoded = encodeThreadWorkspace({ version: 2, workspace });

    expect(decodeThreadWorkspace(encoded)).toEqual({
      version: 2,
      workspace,
    });
  });

  it("keeps named-ref kind separate from its name", () => {
    expect(
      decodeNamedRef({
        kind: "bookmark",
        name: "main",
      }),
    ).toEqual({ kind: "bookmark", name: "main" });
  });
});
