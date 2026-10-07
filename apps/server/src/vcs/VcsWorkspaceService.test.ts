import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { JJ_WORKSPACE_JSON_TEMPLATE, parseJjJsonLines } from "@t3tools/shared/jjCli";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as JjVcsDriver from "./JjVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import { VcsWorkspaceService, jjWorkspaceNameForThread, layer } from "./VcsWorkspaceService.ts";

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
).pipe(Layer.provide(JjVcsDriver.layer));

const TestLayer = Layer.merge(
  layer.pipe(
    Layer.provide(RegistryLayer),
    Layer.provide(Layer.mock(GitWorkflowService.GitWorkflowService)({})),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-jj-workspaces-" })),
  ),
  JjVcsDriver.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

const listWorkspaceNames = Effect.fn("listWorkspaceNames")(function* (cwd: string) {
  const driver = yield* VcsDriver.VcsDriver;
  const result = yield* driver.execute({
    operation: "VcsWorkspaceService.test.list",
    cwd,
    args: ["workspace", "list", "--template", JJ_WORKSPACE_JSON_TEMPLATE],
  });
  return parseJjJsonLines(result.stdout).map((record) => {
    assert.isObject(record);
    assert.property(record, "name");
    return (record as { readonly name: string }).name;
  });
});

it.layer(TestLayer)("creates, reuses, repairs, and removes isolated Jujutsu workspaces", (it) => {
  it.effect("keeps thread workspaces independent and cleanup scoped", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* VcsDriver.VcsDriver;
      const workspaces = yield* VcsWorkspaceService;
      const fixtureRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-phase4-" });
      const repository = path.join(fixtureRoot, "repository");
      yield* fileSystem.makeDirectory(repository, { recursive: true });
      yield* driver.initRepository({ cwd: repository, kind: "jj" });

      const base = yield* driver.execute({
        operation: "VcsWorkspaceService.test.base",
        cwd: repository,
        args: ["log", "--no-graph", "-r", "@", "-T", 'commit_id ++ "\\n"'],
      });
      const baseCommit = base.stdout.trim();
      const firstThread = ThreadId.make("thread-phase4-first");
      const secondThread = ThreadId.make("thread-phase4-second");
      const first = yield* workspaces.createThreadWorkspace({
        cwd: repository,
        threadId: firstThread,
        baseRevision: baseCommit,
        publishRef: "feature/first",
      });
      const second = yield* workspaces.createThreadWorkspace({
        cwd: repository,
        threadId: secondThread,
        baseRevision: baseCommit,
        publishRef: "feature/second",
      });

      assert.notEqual(first.name, second.name);
      assert.notEqual(first.rootPath, second.rootPath);
      assert.notEqual(first.workspaceRevision?.changeId, second.workspaceRevision?.changeId);
      assert.equal(first.baseRevision?.commitId, baseCommit);
      assert.equal(second.baseRevision?.commitId, baseCommit);
      assert.isTrue(yield* fileSystem.exists(first.rootPath));
      assert.isTrue(yield* fileSystem.exists(second.rootPath));

      const reused = yield* workspaces.createThreadWorkspace({
        cwd: repository,
        threadId: firstThread,
        baseRevision: baseCommit,
        publishRef: "feature/first",
      });
      assert.deepStrictEqual(reused.workspaceRevision, first.workspaceRevision);

      yield* driver.execute({
        operation: "VcsWorkspaceService.test.externalRewrite",
        cwd: repository,
        args: [
          "describe",
          first.workspaceRevision?.changeId ?? "",
          "--message",
          "external rewrite",
        ],
      });
      const repaired = yield* workspaces.ensureThreadWorkspace({
        cwd: repository,
        threadId: firstThread,
        workspace: first,
      });
      assert.equal(repaired.name, first.name);
      assert.notEqual(repaired.workspaceRevision?.commitId, first.workspaceRevision?.commitId);

      yield* fileSystem.remove(first.rootPath, { recursive: true, force: true });
      const recreated = yield* workspaces.ensureThreadWorkspace({
        cwd: repository,
        threadId: firstThread,
        workspace: repaired,
      });
      assert.isTrue(yield* fileSystem.exists(recreated.rootPath));
      assert.equal(recreated.name, jjWorkspaceNameForThread(firstThread));

      yield* workspaces.removeThreadWorkspace({ cwd: repository, workspace: recreated });
      assert.isFalse(yield* fileSystem.exists(recreated.rootPath));
      assert.isTrue(yield* fileSystem.exists(second.rootPath));
      const names = yield* listWorkspaceNames(repository);
      assert.notInclude(names, recreated.name);
      assert.include(names, second.name);
    }),
  );
});
