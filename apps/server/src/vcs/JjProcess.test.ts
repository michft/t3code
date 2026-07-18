import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as JjProcess from "./JjProcess.ts";
import * as VcsProcess from "./VcsProcess.ts";

const output = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

it.effect("accepts the minimum supported jj version", () =>
  Effect.gen(function* () {
    const process = yield* JjProcess.JjProcess;
    assert.equal(yield* process.ensureSupportedVersion("/repo"), "0.42.0");
  }).pipe(
    Effect.provide(
      Layer.effect(JjProcess.JjProcess, JjProcess.make).pipe(
        Layer.provide(
          Layer.mock(VcsProcess.VcsProcess)({
            run: () => Effect.succeed(output("jj 0.42.0\n")),
          }),
        ),
      ),
    ),
  ),
);

it.effect("rejects unsupported jj versions with actionable detail", () =>
  Effect.gen(function* () {
    const process = yield* JjProcess.JjProcess;
    const error = yield* process.ensureSupportedVersion("/repo").pipe(Effect.flip);
    assert.equal(error._tag, "VcsUnsupportedOperationError");
    if (error._tag !== "VcsUnsupportedOperationError") return;
    assert.match(error.detail, /requires jj 0\.42\.0 or newer/);
  }).pipe(
    Effect.provide(
      Layer.effect(JjProcess.JjProcess, JjProcess.make).pipe(
        Layer.provide(
          Layer.mock(VcsProcess.VcsProcess)({
            run: () => Effect.succeed(output("jj 0.41.0\n")),
          }),
        ),
      ),
    ),
  ),
);
