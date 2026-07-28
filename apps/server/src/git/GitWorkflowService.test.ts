import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

function mockJjDriver(
  overrides: Partial<VcsDriver.VcsDriver["Service"]>,
): VcsDriver.VcsDriver["Service"] {
  const unexpected = () => Effect.die("unexpected jj driver call");
  return VcsDriver.VcsDriver.of({
    capabilities: {
      kind: "jj",
      supportsWorktrees: false,
      supportsBookmarks: true,
      supportsAtomicSnapshot: true,
      supportsPushDefaultRemote: true,
      supportsWorkspaces: true,
      supportsNamedPublishRefs: true,
      supportsSelectedFileFinalize: true,
      supportsThreadLocalRestore: true,
      supportsDefaultRemotePush: true,
      supportsGitProviderCompatibility: true,
      ignoreClassifier: "native",
    },
    execute: unexpected,
    detectRepository: unexpected,
    isInsideWorkTree: unexpected,
    listWorkspaceFiles: unexpected,
    listRemotes: unexpected,
    addRemote: unexpected,
    removeRemote: unexpected,
    resolveDefaultRemote: unexpected,
    filterIgnoredPaths: unexpected,
    initRepository: unexpected,
    cloneRepository: unexpected,
    ...overrides,
  });
}

function makeLayer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
  readonly manager?: Partial<GitManager.GitManager["Service"]>;
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)(input.manager ?? {})),
  );
}

describe("GitWorkflowService", () => {
  it.effect("lets GitManager route jj stacked actions", () => {
    const driver = mockJjDriver({});
    let receivedAction: string | null = null;
    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const result = yield* workflow.runStackedAction({
        actionId: "jj-action",
        cwd: "/jj-repo",
        action: "push",
        publishRef: { kind: "bookmark", name: "feature/phase-6" },
      });
      assert.equal(receivedAction, "push");
      assert.equal(result.push.status, "pushed");
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () =>
            Effect.succeed({
              kind: "jj" as const,
              repository: {
                kind: "jj" as const,
                rootPath: "/jj-repo",
                metadataPath: "/jj-repo/.jj",
                freshness: {
                  source: "live-local" as const,
                  observedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                  expiresAt: Option.none(),
                },
              },
              driver,
            }),
          manager: {
            runStackedAction: (input) => {
              receivedAction = input.action;
              return Effect.succeed({
                action: input.action,
                branch: { status: "skipped_not_requested" as const },
                commit: { status: "skipped_not_requested" as const },
                push: { status: "pushed" as const, branch: "feature/phase-6" },
                pr: { status: "skipped_not_requested" as const },
                toast: { title: "Published feature/phase-6", cta: { kind: "none" as const } },
              });
            },
          },
        }),
      ),
    );
  });

  it.effect("routes status and ref reads through a detected jj driver", () => {
    const driver = mockJjDriver({
      getLocalStatus: () =>
        Effect.succeed({
          isRepo: true,
          driverKind: "jj",
          workspaceRevision: "change-id",
          publishRef: null,
          defaultRef: "main@origin",
          conflicts: [],
          hasPrimaryRemote: true,
          isDefaultRef: false,
          refName: null,
          hasWorkingTreeChanges: true,
          workingTree: {
            files: [{ path: "file.txt", insertions: 1, deletions: 0 }],
            insertions: 1,
            deletions: 0,
          },
        }),
      getRemoteStatus: () =>
        Effect.succeed({
          trackedRemote: { remoteName: "origin", refName: "main" },
          hasUpstream: true,
          aheadCount: 1,
          behindCount: 0,
          aheadOfDefaultCount: 1,
          pr: null,
        }),
      listRefs: () =>
        Effect.succeed({
          refs: [
            {
              kind: "bookmark",
              name: "main@origin",
              isRemote: true,
              remoteName: "origin",
              current: false,
              isDefault: true,
              worktreePath: null,
            },
          ],
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: 1,
        }),
    });
    const detect = () =>
      DateTime.now.pipe(
        Effect.map((observedAt) => ({
          kind: "jj" as const,
          repository: {
            kind: "jj" as const,
            rootPath: "/repo",
            metadataPath: "/repo/.jj",
            colocated: true,
            freshness: { source: "live-local" as const, observedAt, expiresAt: Option.none() },
          },
          driver,
        })),
      );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/repo" });
      const refs = yield* workflow.listRefs({ cwd: "/repo" });

      assert.equal(status.driverKind, "jj");
      assert.equal(status.refName, null);
      assert.equal(status.workspaceRevision, "change-id");
      assert.equal(status.aheadCount, 1);
      assert.equal(status.trackedRemote?.refName, "main");
      assert.equal(refs.refs[0]?.kind, "bookmark");
      assert.isFalse(refs.refs[0]?.current);
    }).pipe(Effect.provide(makeLayer({ detect })));
  });

  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("structures workflow detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this status workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("structures command detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream command detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.listRefs",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });
});
