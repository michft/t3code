import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitVcsDriver from "./GitVcsDriver.ts";

/**
 * Narrow compatibility boundary for provider CLIs/APIs that still require
 * Git branch and ref semantics in colocated repositories.
 */
export class VcsGitProviderCompatibility extends Context.Service<
  VcsGitProviderCompatibility,
  {
    readonly git: GitVcsDriver.GitVcsDriver["Service"];
  }
>()("t3/vcs/VcsGitProviderCompatibility") {}

export const make = Effect.gen(function* () {
  return VcsGitProviderCompatibility.of({
    git: yield* GitVcsDriver.GitVcsDriver,
  });
});

export const layer = Layer.effect(VcsGitProviderCompatibility, make);
