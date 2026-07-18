import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import type { VcsError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import { parseTurnDiffFilesFromUnifiedDiff } from "../checkpointing/Diffs.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as JjVcsDriver from "./JjVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const JjContractLayer = JjVcsDriver.layer.pipe(Layer.provideMerge(NodeServices.layer));
const GitReviewLayer = GitVcsDriver.vcsLayer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-vcs-review-equivalence-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runJj = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* VcsDriver.VcsDriver;
    yield* driver.execute({
      operation: "JjVcsDriver.contract.jj",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

type JjContractError = VcsError | PlatformError.PlatformError;

it("keeps content and bookmark conflicts distinct", () => {
  assert.deepStrictEqual(
    JjVcsDriver.collectJjStatusConflicts({
      revision: { conflict: true },
      changedFiles: [{ path: "conflicted.txt", conflict: true }],
      bookmarks: [
        { name: "feature", target: ["left", "right"] },
        { name: "main", remote: "origin", target: ["base"] },
      ],
    }),
    [
      { kind: "content", path: "conflicted.txt" },
      { kind: "named-ref", refName: "feature" },
    ],
  );
});

runVcsDriverContractSuite<VcsDriver.VcsDriver, JjContractError>({
  name: "Jujutsu",
  kind: "jj",
  layer: JjContractLayer,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        const driver = yield* VcsDriver.VcsDriver;
        yield* driver.initRepository({ cwd, kind: "jj" });
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

it.layer(JjContractLayer)("adds, selects, and removes jj Git remotes", (it) =>
  it.effect("manages remotes through jj", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-remotes-" });
      const driver = yield* VcsDriver.VcsDriver;
      yield* driver.initRepository({ cwd, kind: "jj" });

      yield* driver.addRemote({ cwd, name: "upstream", url: "https://example.test/repo.git" });
      assert.equal(yield* driver.resolveDefaultRemote(cwd), "upstream");
      assert.deepStrictEqual(
        (yield* driver.listRemotes(cwd)).remotes.map(({ name, url, isPrimary }) => ({
          name,
          url,
          isPrimary,
        })),
        [{ name: "upstream", url: "https://example.test/repo.git", isPrimary: true }],
      );

      yield* driver.removeRemote({ cwd, name: "upstream" });
      assert.deepStrictEqual((yield* driver.listRemotes(cwd)).remotes, []);
    }),
  ),
);

it.layer(JjContractLayer)("clones a colocated repository through jj", (it) =>
  it.effect("clones", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-clone-" });
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      yield* fileSystem.makeDirectory(source);
      const driver = yield* VcsDriver.VcsDriver;
      yield* driver.initRepository({ cwd: source, kind: "jj" });
      yield* fileSystem.writeFileString(path.join(source, "README.md"), "fixture\n");
      yield* runJj(source, ["commit", "-m", "fixture"]);

      yield* driver.cloneRepository({ kind: "jj", source, destination });

      assert.isTrue(yield* fileSystem.exists(path.join(destination, ".jj")));
      assert.isTrue(yield* fileSystem.exists(path.join(destination, ".git")));
      assert.equal((yield* driver.detectRepository(destination))?.kind, "jj");
    }),
  ),
);

it.layer(JjContractLayer)("reads jj status, bookmarks, and review diffs", (it) =>
  it.effect("models workspace state without a fictional current bookmark", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-status-" });
      const driver = yield* VcsDriver.VcsDriver;
      yield* driver.initRepository({ cwd, kind: "jj" });
      yield* fileSystem.writeFileString(path.join(cwd, "alpha.txt"), "one\ntwo\n");
      yield* runJj(cwd, ["bookmark", "create", "feature", "-r", "@"]);

      const getLocalStatus = driver.getLocalStatus;
      const listRefs = driver.listRefs;
      const getDiffPreview = driver.getDiffPreview;
      assert.isDefined(getLocalStatus);
      assert.isDefined(listRefs);
      assert.isDefined(getDiffPreview);
      if (!getLocalStatus || !listRefs || !getDiffPreview) return;

      const status = yield* getLocalStatus({ cwd });
      assert.equal(status.driverKind, "jj");
      assert.equal(status.refName, null);
      assert.equal(status.publishRef, null);
      assert.equal(status.hasWorkingTreeChanges, true);
      assert.equal(status.workingTree.insertions, 2);
      assert.deepStrictEqual(status.workingTree.files, [
        { path: "alpha.txt", insertions: 2, deletions: 0 },
      ]);
      assert.equal(status.workspaceRevisionDetails?.changeId, status.workspaceRevision);
      assert.equal(status.workspaceRevisionDetails?.empty, false);

      const refs = yield* listRefs({ cwd, includeMatchingRemoteRefs: true });
      assert.deepInclude(
        refs.refs.find((ref) => ref.name === "feature"),
        {
          kind: "bookmark",
          name: "feature",
          isRemote: false,
          current: false,
        },
      );
      assert.isFalse(refs.refs.some((ref) => ref.current));

      const preview = yield* getDiffPreview({ cwd });
      assert.deepStrictEqual(preview.sources[0]?.diff.match(/^diff --git /gm)?.length, 1);
      assert.include(preview.sources[0]?.diff ?? "", "a/alpha.txt");
      assert.equal(preview.sources[0]?.headRef, status.workspaceRevision);
      assert.match(preview.sources[0]?.id ?? "", /^jj-working-copy:/);
    }),
  ),
);

it.layer(JjContractLayer)("preserves jj Git-format review metadata", (it) =>
  it.effect("keeps rename, deletion, mode, and binary markers", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-review-metadata-" });
      const driver = yield* VcsDriver.VcsDriver;
      yield* driver.initRepository({ cwd, kind: "jj" });
      yield* fileSystem.writeFileString(path.join(cwd, "rename-old.txt"), "rename\n");
      yield* fileSystem.writeFileString(path.join(cwd, "deleted.txt"), "deleted\n");
      yield* fileSystem.writeFileString(path.join(cwd, "script.sh"), "#!/bin/sh\n");
      yield* fileSystem.writeFile(path.join(cwd, "binary.bin"), new Uint8Array([0, 1, 2]));
      yield* runJj(cwd, ["commit", "-m", "base"]);

      yield* fileSystem.rename(path.join(cwd, "rename-old.txt"), path.join(cwd, "rename-new.txt"));
      yield* fileSystem.remove(path.join(cwd, "deleted.txt"));
      yield* fileSystem.chmod(path.join(cwd, "script.sh"), 0o755);
      yield* fileSystem.writeFile(path.join(cwd, "binary.bin"), new Uint8Array([0, 3, 2]));

      const getDiffPreview = driver.getDiffPreview;
      assert.isDefined(getDiffPreview);
      if (!getDiffPreview) return;
      const diff = (yield* getDiffPreview({ cwd })).sources[0]?.diff ?? "";
      assert.include(diff, "rename from rename-old.txt");
      assert.include(diff, "rename to rename-new.txt");
      assert.include(diff, "deleted file mode 100644");
      assert.include(diff, "old mode 100644");
      assert.include(diff, "new mode 100755");
      assert.match(diff, /Binary files .*binary\.bin.* differ/);
    }),
  ),
);

it.effect("produces equivalent Git and jj review file lists", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-vcs-review-" });
    const gitCwd = path.join(root, "git");
    const jjCwd = path.join(root, "jj");
    yield* fileSystem.makeDirectory(gitCwd);
    yield* fileSystem.makeDirectory(jjCwd);

    const gitPatch = yield* Effect.gen(function* () {
      const driver = yield* VcsDriver.VcsDriver;
      yield* driver.initRepository({ cwd: gitCwd, kind: "git" });
      yield* driver.execute({
        operation: "VcsReviewEquivalence.git.configEmail",
        cwd: gitCwd,
        args: ["config", "user.email", "test@example.test"],
      });
      yield* driver.execute({
        operation: "VcsReviewEquivalence.git.configName",
        cwd: gitCwd,
        args: ["config", "user.name", "Test"],
      });
      yield* fileSystem.writeFileString(path.join(gitCwd, "changed.txt"), "before\n");
      yield* fileSystem.writeFileString(path.join(gitCwd, "deleted.txt"), "delete\n");
      yield* driver.execute({
        operation: "VcsReviewEquivalence.git.add",
        cwd: gitCwd,
        args: ["add", "."],
      });
      yield* driver.execute({
        operation: "VcsReviewEquivalence.git.commit",
        cwd: gitCwd,
        args: ["commit", "-m", "base"],
      });
      yield* fileSystem.writeFileString(path.join(gitCwd, "changed.txt"), "after\n");
      yield* fileSystem.remove(path.join(gitCwd, "deleted.txt"));
      return (yield* driver.execute({
        operation: "VcsReviewEquivalence.git.diff",
        cwd: gitCwd,
        args: ["diff", "--patch", "HEAD"],
      })).stdout;
    }).pipe(Effect.provide(GitReviewLayer));

    const jjPatch = yield* Effect.gen(function* () {
      const driver = yield* VcsDriver.VcsDriver;
      yield* driver.initRepository({ cwd: jjCwd, kind: "jj" });
      yield* fileSystem.writeFileString(path.join(jjCwd, "changed.txt"), "before\n");
      yield* fileSystem.writeFileString(path.join(jjCwd, "deleted.txt"), "delete\n");
      yield* driver.execute({
        operation: "VcsReviewEquivalence.jj.commit",
        cwd: jjCwd,
        args: ["commit", "-m", "base"],
      });
      yield* fileSystem.writeFileString(path.join(jjCwd, "changed.txt"), "after\n");
      yield* fileSystem.remove(path.join(jjCwd, "deleted.txt"));
      const getDiffPreview = driver.getDiffPreview;
      assert.isDefined(getDiffPreview);
      if (!getDiffPreview) return "";
      return (yield* getDiffPreview({ cwd: jjCwd })).sources[0]?.diff ?? "";
    }).pipe(Effect.provide(JjContractLayer));

    const paths = (patch: string) =>
      parseTurnDiffFilesFromUnifiedDiff(patch)
        .map((file) => file.path)
        .toSorted();
    assert.deepStrictEqual(paths(jjPatch), paths(gitPatch));
    assert.deepStrictEqual(paths(jjPatch), ["changed.txt", "deleted.txt"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reads tracked remote bookmarks without inventing a current bookmark", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-remote-status-" });
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    yield* fileSystem.makeDirectory(source);

    yield* Effect.gen(function* () {
      const driver = yield* VcsDriver.VcsDriver;
      yield* driver.initRepository({ cwd: source, kind: "git" });
      yield* driver.execute({
        operation: "JjVcsDriver.remoteFixture.defaultBranch",
        cwd: source,
        args: ["symbolic-ref", "HEAD", "refs/heads/main"],
      });
      yield* driver.execute({
        operation: "JjVcsDriver.remoteFixture.configEmail",
        cwd: source,
        args: ["config", "user.email", "test@example.test"],
      });
      yield* driver.execute({
        operation: "JjVcsDriver.remoteFixture.configName",
        cwd: source,
        args: ["config", "user.name", "Test"],
      });
      yield* fileSystem.writeFileString(path.join(source, "README.md"), "fixture\n");
      yield* driver.execute({
        operation: "JjVcsDriver.remoteFixture.add",
        cwd: source,
        args: ["add", "."],
      });
      yield* driver.execute({
        operation: "JjVcsDriver.remoteFixture.commit",
        cwd: source,
        args: ["commit", "-m", "base"],
      });
    }).pipe(Effect.provide(GitReviewLayer));

    yield* Effect.gen(function* () {
      const driver = yield* VcsDriver.VcsDriver;
      yield* driver.cloneRepository({ kind: "jj", source, destination });
      const getLocalStatus = driver.getLocalStatus;
      const getRemoteStatus = driver.getRemoteStatus;
      const listRefs = driver.listRefs;
      assert.isDefined(getLocalStatus);
      assert.isDefined(getRemoteStatus);
      assert.isDefined(listRefs);
      if (!getLocalStatus || !getRemoteStatus || !listRefs) return;

      const [local, remote, refs] = yield* Effect.all([
        getLocalStatus({ cwd: destination }),
        getRemoteStatus({ cwd: destination }),
        listRefs({ cwd: destination, includeMatchingRemoteRefs: true }),
      ]);
      assert.equal(local.refName, null);
      assert.equal(local.publishRef, null);
      assert.equal(local.defaultRef, "main@origin");
      assert.equal(remote?.trackedRemote?.remoteName, "origin");
      assert.equal(remote?.trackedRemote?.refName, "main");
      assert.equal(remote?.aheadCount, 0);
      assert.equal(remote?.behindCount, 0);
      const remoteMain = refs.refs.find((ref) => ref.name === "main@origin");
      assert.deepInclude(remoteMain, {
        kind: "bookmark",
        remoteName: "origin",
        tracked: true,
        current: false,
        isDefault: true,
      });
      assert.isFalse(refs.refs.some((ref) => ref.current));
    }).pipe(Effect.provide(JjContractLayer));
  }).pipe(Effect.provide(NodeServices.layer)),
);
