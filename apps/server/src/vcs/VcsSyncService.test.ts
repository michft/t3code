// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { ThreadId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as JjVcsDriver from "./JjVcsDriver.ts";
import * as JjProcess from "./JjProcess.ts";
import * as VcsChangeService from "./VcsChangeService.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as VcsReviewService from "./VcsReviewService.ts";
import { VcsSyncService, layer } from "./VcsSyncService.ts";

const TestJjProcessLayer = Layer.effect(
  JjProcess.JjProcess,
  Effect.gen(function* () {
    const jj = yield* JjProcess.make;
    return JjProcess.JjProcess.of({
      ensureSupportedVersion: jj.ensureSupportedVersion,
      run: (input) =>
        jj.run({
          ...input,
          args: [
            "--config",
            'user.name="T3 Code VCS test"',
            "--config",
            'user.email="vcs-test@example.invalid"',
            ...input.args,
          ],
        }),
    });
  }),
).pipe(Layer.provide(VcsProcess.layer));

const TestJjDriverLayer = Layer.effect(VcsDriver.VcsDriver, JjVcsDriver.make).pipe(
  Layer.provide(TestJjProcessLayer),
  Layer.provide(VcsProcess.layer),
);

const RegistryLayer = Layer.effect(
  VcsDriverRegistry.VcsDriverRegistry,
  Effect.gen(function* () {
    const driver = yield* VcsDriver.VcsDriver;
    return VcsDriverRegistry.VcsDriverRegistry.of({
      get: () => Effect.succeed(driver),
      detect: (input) =>
        driver
          .detectRepository(input.cwd)
          .pipe(
            Effect.map((repository) =>
              repository ? { kind: "jj" as const, repository, driver } : null,
            ),
          ),
      resolve: (input) =>
        driver
          .detectRepository(input.cwd)
          .pipe(
            Effect.flatMap((repository) =>
              repository
                ? Effect.succeed({ kind: "jj" as const, repository, driver })
                : Effect.die(`Expected a Jujutsu repository at ${input.cwd}`),
            ),
          ),
    });
  }),
).pipe(Layer.provide(TestJjDriverLayer));

const TestLayer = Layer.mergeAll(
  layer.pipe(Layer.provide(RegistryLayer)),
  VcsReviewService.layer.pipe(
    Layer.provide(RegistryLayer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-jj-sync-test-" })),
  ),
  VcsChangeService.layer.pipe(Layer.provide(RegistryLayer)),
).pipe(Layer.provideMerge(TestJjDriverLayer), Layer.provideMerge(NodeServices.layer));

function git(args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", [...args], { encoding: "utf8" }).trim();
}

it.layer(TestLayer)("VcsSyncService", (it) => {
  it.effect("pushes only the explicit bookmark and records its remote", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* VcsDriver.VcsDriver;
      const changes = yield* VcsChangeService.VcsChangeService;
      const sync = yield* VcsSyncService;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-phase6-" });
      const repository = path.join(root, "source");
      const remote = path.join(root, "remote.git");
      yield* fileSystem.makeDirectory(repository);
      git(["init", "--bare", "--initial-branch=main", remote]);
      yield* driver.initRepository({ cwd: repository, kind: "jj" });
      yield* driver.addRemote({ cwd: repository, name: "origin", url: remote });
      yield* fileSystem.writeFileString(path.join(repository, "change.txt"), "change\n");

      const finalized = yield* changes.finalizeChange({
        cwd: repository,
        message: "Publish explicit bookmark",
        createPublishRef: "feature/phase-6",
      });
      assert.equal(finalized.status, "created");
      if (finalized.status !== "created") {
        throw new Error("Expected a finalized change.");
      }
      assert.isDefined(finalized.publishRef);

      const result = yield* sync.publish({
        cwd: repository,
        publishRef: finalized.publishRef,
      });
      assert.equal(result.remoteName, "origin");
      assert.equal(result.publishRef.remoteName, "origin");
      assert.equal(
        git(["--git-dir", remote, "rev-parse", "refs/heads/feature/phase-6"]),
        finalized.finalizedRevision.commitId,
      );
      const mainRef = NodeChildProcess.spawnSync(
        "git",
        ["--git-dir", remote, "show-ref", "--verify", "refs/heads/main"],
        { encoding: "utf8" },
      );
      assert.notEqual(mainRef.status, 0);
    }),
  );

  it.effect("advances only an empty workspace after a safe fetch", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* VcsDriver.VcsDriver;
      const changes = yield* VcsChangeService.VcsChangeService;
      const sync = yield* VcsSyncService;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-phase6-fetch-" });
      const source = path.join(root, "source");
      const clean = path.join(root, "clean");
      const dirty = path.join(root, "dirty");
      const remote = path.join(root, "remote.git");
      yield* fileSystem.makeDirectory(source);
      git(["init", "--bare", "--initial-branch=main", remote]);
      yield* driver.initRepository({ cwd: source, kind: "jj" });
      yield* driver.addRemote({ cwd: source, name: "origin", url: remote });
      yield* fileSystem.writeFileString(path.join(source, "base.txt"), "base\n");
      const base = yield* changes.finalizeChange({
        cwd: source,
        message: "Base",
        createPublishRef: "main",
      });
      assert.equal(base.status, "created");
      if (base.status !== "created") {
        throw new Error("Expected a finalized base change.");
      }
      assert.isDefined(base.publishRef);
      yield* sync.publish({ cwd: source, publishRef: base.publishRef });

      yield* driver.cloneRepository({ kind: "jj", source: remote, destination: clean });
      yield* driver.cloneRepository({ kind: "jj", source: remote, destination: dirty });
      yield* driver.execute({
        operation: "VcsSyncService.test.baseCleanWorkspace",
        cwd: clean,
        args: ["new", base.finalizedRevision.commitId],
      });
      yield* driver.execute({
        operation: "VcsSyncService.test.baseDirtyWorkspace",
        cwd: dirty,
        args: ["new", base.finalizedRevision.commitId],
      });
      yield* fileSystem.writeFileString(path.join(dirty, "local.txt"), "local\n");
      yield* driver.execute({
        operation: "VcsSyncService.test.snapshotDirty",
        cwd: dirty,
        args: ["util", "snapshot"],
      });

      yield* fileSystem.writeFileString(path.join(source, "next.txt"), "next\n");
      const next = yield* changes.finalizeChange({
        cwd: source,
        message: "Next",
        publishRef: base.publishRef,
      });
      assert.equal(next.status, "created");
      if (next.status !== "created") {
        throw new Error("Expected a finalized follow-up change.");
      }
      assert.isDefined(next.publishRef);
      yield* sync.publish({ cwd: source, publishRef: next.publishRef });

      const cleanResult = yield* sync.fetch({ cwd: clean });
      assert.equal(cleanResult.status, "updated");
      const cleanAfter = yield* driver.execute({
        operation: "VcsSyncService.test.cleanAfter",
        cwd: clean,
        args: [
          "log",
          "--no-graph",
          "--revisions",
          "@",
          "--template",
          'parents.map(|p| p.commit_id()).join("\n")',
        ],
      });
      assert.equal(cleanAfter.stdout.trim(), next.finalizedRevision.commitId);

      const dirtyBefore = yield* driver.execute({
        operation: "VcsSyncService.test.dirtyBefore",
        cwd: dirty,
        args: [
          "log",
          "--no-graph",
          "--revisions",
          "@",
          "--template",
          'parents.map(|p| p.commit_id()).join("\n")',
        ],
      });
      assert.equal(dirtyBefore.stdout.trim(), base.finalizedRevision.commitId);
      const dirtyResult = yield* sync.fetch({ cwd: dirty });
      assert.equal(dirtyResult.status, "needs-rebase");
      const dirtyAfter = yield* driver.execute({
        operation: "VcsSyncService.test.dirtyAfter",
        cwd: dirty,
        args: [
          "log",
          "--no-graph",
          "--revisions",
          "@",
          "--template",
          'parents.map(|p| p.commit_id()).join("\n")',
        ],
      });
      assert.equal(dirtyAfter.stdout, dirtyBefore.stdout);
    }),
  );

  it.effect("prepares idempotent local and isolated review workspaces", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* VcsDriver.VcsDriver;
      const changes = yield* VcsChangeService.VcsChangeService;
      const sync = yield* VcsSyncService;
      const reviews = yield* VcsReviewService.VcsReviewService;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-phase7-review-" });
      const source = path.join(root, "source");
      const review = path.join(root, "review");
      const remote = path.join(root, "remote.git");
      yield* fileSystem.makeDirectory(source);
      git(["init", "--bare", "--initial-branch=main", remote]);
      yield* driver.initRepository({ cwd: source, kind: "jj" });
      yield* driver.addRemote({ cwd: source, name: "origin", url: remote });
      yield* fileSystem.writeFileString(path.join(source, "review.txt"), "review\n");
      const finalized = yield* changes.finalizeChange({
        cwd: source,
        message: "Review target",
        createPublishRef: "feature/review",
      });
      assert.equal(finalized.status, "created");
      if (finalized.status !== "created") {
        throw new Error("Expected a finalized review change.");
      }
      assert.isDefined(finalized.publishRef);
      yield* sync.publish({ cwd: source, publishRef: finalized.publishRef });
      yield* driver.cloneRepository({ kind: "jj", source: remote, destination: review });

      const local = yield* reviews.prepareReview({
        cwd: review,
        changeRequestNumber: 42,
        headRefName: "feature/review",
        mode: "local",
      });
      assert.equal(local.bookmarkName, "t3code-review-42");
      assert.isNull(local.workspacePath);
      const firstCurrent = yield* driver.execute({
        operation: "VcsSyncService.test.reviewCurrent",
        cwd: review,
        args: ["log", "--no-graph", "--revisions", "@", "--template", "commit_id"],
      });
      const localParent = yield* driver.execute({
        operation: "VcsSyncService.test.reviewParent",
        cwd: review,
        args: ["log", "--no-graph", "--revisions", "@-", "--template", "commit_id"],
      });
      assert.equal(localParent.stdout, finalized.finalizedRevision.commitId);

      yield* reviews.prepareReview({
        cwd: review,
        changeRequestNumber: 42,
        headRefName: "feature/review",
        mode: "local",
      });
      const repeatedCurrent = yield* driver.execute({
        operation: "VcsSyncService.test.reviewRepeatedCurrent",
        cwd: review,
        args: ["log", "--no-graph", "--revisions", "@", "--template", "commit_id"],
      });
      assert.equal(repeatedCurrent.stdout, firstCurrent.stdout);

      const isolated = yield* reviews.prepareReview({
        cwd: review,
        changeRequestNumber: 42,
        headRefName: "feature/review",
        mode: "worktree",
        threadId: "thread-phase-7-review" as ThreadId,
      });
      assert.isNotNull(isolated.workspacePath);
      assert.isTrue(yield* fileSystem.exists(isolated.workspacePath as string));
      const isolatedParent = yield* driver.execute({
        operation: "VcsSyncService.test.reviewWorkspaceParent",
        cwd: isolated.workspacePath as string,
        args: ["log", "--no-graph", "--revisions", "@-", "--template", "commit_id"],
      });
      assert.equal(isolatedParent.stdout, finalized.finalizedRevision.commitId);

      const repeatedIsolated = yield* reviews.prepareReview({
        cwd: review,
        changeRequestNumber: 42,
        headRefName: "feature/review",
        mode: "worktree",
        threadId: "thread-phase-7-review" as ThreadId,
      });
      assert.equal(repeatedIsolated.workspacePath, isolated.workspacePath);
      assert.equal(
        git(["--git-dir", remote, "rev-parse", "refs/heads/feature/review"]),
        finalized.finalizedRevision.commitId,
      );
    }),
  );
});
