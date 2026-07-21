import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import { VcsReviewService, layer } from "./VcsReviewService.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const processOutput = (stdout = "") => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

function testLayer(input: {
  readonly resolveCalls: Array<string>;
  readonly executeCalls: Array<string>;
}) {
  const driverLayer = Layer.mock(VcsDriver.VcsDriver)({
    capabilities: {
      kind: "jj",
      supportsWorktrees: true,
      supportsBookmarks: true,
      supportsAtomicSnapshot: true,
      supportsPushDefaultRemote: false,
      ignoreClassifier: "native",
    },
    execute: (command) =>
      Effect.sync(() => {
        input.executeCalls.push(command.operation);
        if (command.operation === "VcsReviewService.readBookmarks") {
          return processOutput(
            `${encodeUnknownJson({ name: "feature/review", remote: "origin", target: ["target"] })}\n`,
          );
        }
        if (command.operation === "VcsReviewService.readRevision") {
          return processOutput(
            `${encodeUnknownJson({
              commitId: "target",
              changeId: "change",
              description: "",
              conflict: false,
              empty: true,
              parents: ["parent"],
              workingCopies: [],
            })}\n`,
          );
        }
        if (command.operation === "VcsReviewService.readCurrentWorkspaceName") {
          return processOutput("another-workspace\n");
        }
        return processOutput();
      }),
    resolveDefaultRemote: () => Effect.succeed("origin"),
  });

  const registryLayer = Layer.effect(
    VcsDriverRegistry.VcsDriverRegistry,
    Effect.gen(function* () {
      const driver = yield* VcsDriver.VcsDriver;
      return VcsDriverRegistry.VcsDriverRegistry.of({
        get: () => Effect.succeed(driver),
        detect: () => Effect.succeed(null),
        resolve: ({ cwd }) =>
          Effect.sync(() => {
            input.resolveCalls.push(cwd);
            return {
              kind: "jj" as const,
              repository: {
                kind: "jj" as const,
                rootPath: "/repo",
                metadataPath: "/repo/.jj",
                colocated: true,
                freshness: {
                  source: "live-local" as const,
                  observedAt: TEST_EPOCH,
                  expiresAt: Option.none(),
                },
              },
              driver,
            };
          }),
      });
    }),
  ).pipe(Layer.provide(driverLayer));

  const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-vcs-review-" });
  return Layer.merge(
    layer.pipe(Layer.provide(registryLayer), Layer.provide(configLayer)),
    configLayer,
  ).pipe(Layer.provideMerge(NodeServices.layer));
}

describe("VcsReviewService", () => {
  it.effect(
    "rejects a missing isolated-workspace thread id before resolving the repository",
    () => {
      const resolveCalls: Array<string> = [];
      const executeCalls: Array<string> = [];
      return Effect.gen(function* () {
        const service = yield* VcsReviewService;
        const error = yield* service
          .prepareReview({
            cwd: "/repo",
            changeRequestNumber: 12,
            headRefName: "feature/review",
            mode: "worktree",
          })
          .pipe(Effect.flip);

        assert.include(error.detail, "thread id is required");
        assert.deepStrictEqual(resolveCalls, []);
        assert.deepStrictEqual(executeCalls, []);
      }).pipe(Effect.provide(testLayer({ resolveCalls, executeCalls })));
    },
  );

  it.effect("refuses to reuse a jj workspace with mismatched thread ownership", () => {
    const resolveCalls: Array<string> = [];
    const executeCalls: Array<string> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const service = yield* VcsReviewService;
      const threadId = ThreadId.make("thread-review-owner");
      const workspaceName = `t3code-${NodeCrypto.createHash("sha256")
        .update(threadId, "utf8")
        .digest("hex")
        .slice(0, 20)}`;
      const workspacePath = path.join(config.worktreesDir, "repo", workspaceName);
      yield* fileSystem.makeDirectory(workspacePath, { recursive: true });

      const error = yield* service
        .prepareReview({
          cwd: "/repo",
          changeRequestNumber: 12,
          headRefName: "feature/review",
          mode: "worktree",
          threadId,
        })
        .pipe(Effect.flip);

      assert.isTrue(error.recoverable);
      assert.include(error.detail, "ownership");
      assert.include(executeCalls, "VcsReviewService.readCurrentWorkspaceName");
    }).pipe(Effect.provide(testLayer({ resolveCalls, executeCalls })));
  });
});
