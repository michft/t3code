import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { VcsUnsupportedOperationError, type VcsError } from "@t3tools/contracts";
import { inspectJjVersion } from "@t3tools/shared/jjCli";
import * as VcsProcess from "./VcsProcess.ts";

const MACHINE_ARGS = ["--color=never", "--no-pager"] as const;

export interface JjProcessInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly repository?: string;
  readonly stdin?: string;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly appendTruncationMarker?: boolean;
}

export class JjProcess extends Context.Service<
  JjProcess,
  {
    readonly ensureSupportedVersion: (cwd: string) => Effect.Effect<string, VcsError>;
    readonly run: (input: JjProcessInput) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;
  }
>()("t3/vcs/JjProcess") {}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const ensureSupportedVersion: JjProcess["Service"]["ensureSupportedVersion"] = Effect.fn(
    "JjProcess.ensureSupportedVersion",
  )(function* (cwd) {
    const result = yield* process.run({
      operation: "JjProcess.ensureSupportedVersion",
      command: "jj",
      args: ["--version"],
      cwd,
      spawnCwd: globalThis.process.cwd(),
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    });
    const support = inspectJjVersion(result.stdout);
    if (support.status !== "supported") {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjProcess.ensureSupportedVersion",
        kind: "jj",
        detail: support.detail,
      });
    }
    return support.version;
  });

  const run: JjProcess["Service"]["run"] = (input) =>
    process.run({
      operation: input.operation,
      command: "jj",
      args: [...MACHINE_ARGS, ...input.args],
      cwd: input.cwd,
      spawnCwd: input.repository ?? globalThis.process.cwd(),
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: input.appendTruncationMarker }
        : {}),
    });

  return JjProcess.of({ ensureSupportedVersion, run });
});

export const layer = Layer.effect(JjProcess, make).pipe(Layer.provide(VcsProcess.layer));
