import { JJ_MINIMUM_SUPPORTED_VERSION } from "@t3tools/shared/jjCli";
import { SourceControlProviderKind, VcsProcessSpawnError } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { providerAuth } from "@t3tools/source-control-core/server/discovery";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import {
  fakeDiscovery,
  fakeSourceControlProvider,
} from "@t3tools/source-control-testing/fakeSourceControlDriver";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SourceControlDiscovery from "./SourceControlDiscovery.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

const kind = SourceControlProviderKind.make;

// Serves both the host's runs and the server's own VCS probes, whose inputs share these fields.
const run = (
  input: Pick<
    SourceControlHost.SourceControlProcessInput,
    "operation" | "command" | "args" | "cwd"
  >,
): Effect.Effect<SourceControlHost.SourceControlProcessOutput, VcsProcessSpawnError> => {
  if (input.args[0] === "--version") {
    return input.command === "missing-cli"
      ? Effect.fail(
          new VcsProcessSpawnError({
            operation: input.operation,
            command: input.command,
            cwd: input.cwd,
            cause: new Error(`${input.command} not found`),
          }),
        )
      : Effect.succeed(
          TestSourceControlHost.processOutput(
            input.command === "jj"
              ? `jj ${JJ_MINIMUM_SUPPORTED_VERSION}\n`
              : `${input.command} version test\n`,
          ),
        );
  }
  return Effect.succeed(
    TestSourceControlHost.processOutput(`signed in as ${input.command}-user\n`),
  );
};

const cliDiscovery = (name: string) => ({
  type: "cli" as const,
  kind: kind(name),
  label: name,
  installHint: `Install ${name}.`,
  executable: name === "beta" ? "missing-cli" : `${name}-cli`,
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  parseAuth: ({ stdout }: { readonly stdout: string }) =>
    providerAuth({ status: "authenticated", account: /as (\S+)/.exec(stdout)?.[1] }),
});

const layerDiscovery = (vcsRun: typeof run = run) =>
  Layer.effect(
    SourceControlProviderRegistry.SourceControlProviderRegistry,
    SourceControlProviderRegistry.makeWithProviders(
      [
        cliDiscovery("alpha"),
        cliDiscovery("beta"),
        fakeDiscovery("gamma", {
          probeAuth: Effect.succeed(providerAuth({ status: "authenticated", account: "api-user" })),
        }),
      ].map((discovery) => ({
        kind: discovery.kind,
        provider: fakeSourceControlProvider(discovery.kind),
        discovery,
      })),
    ),
  ).pipe(
    Layer.provideMerge(TestSourceControlHost.layer({ process: { run } })),
    Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provideMerge(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({})),
    Layer.provideMerge(Layer.mock(VcsProcess.VcsProcess)({ run: vcsRun })),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-control-discovery-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("reports every hosting integration in registry order with its sign-in", () =>
  Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const result = yield* discovery.discover;

    assert.deepStrictEqual(
      result.sourceControlProviders.map((item) => ({
        kind: item.kind,
        status: item.status,
        version: item.version,
        auth: item.auth.status,
        account: item.auth.account,
      })),
      [
        {
          kind: kind("alpha"),
          status: "available",
          version: Option.some("alpha-cli version test"),
          auth: "authenticated",
          account: Option.some("alpha-cli-user"),
        },
        {
          kind: kind("beta"),
          status: "missing",
          version: Option.none(),
          auth: "unknown",
          account: Option.none(),
        },
        {
          kind: kind("gamma"),
          status: "available",
          version: Option.none(),
          auth: "authenticated",
          account: Option.some("api-user"),
        },
      ],
    );
    assert.deepStrictEqual(
      result.versionControlSystems.map((item) => [item.kind, item.status]),
      [
        ["git", "available"],
        ["jj", "available"],
      ],
    );
  }).pipe(Effect.provide(SourceControlDiscovery.layer.pipe(Layer.provide(layerDiscovery())))),
);

it.effect("reports unsupported and unparseable jj versions", () =>
  Effect.gen(function* () {
    for (const output of ["jj 0.41.0\n", ""]) {
      const discovery = yield* SourceControlDiscovery.SourceControlDiscovery.pipe(
        Effect.provide(
          SourceControlDiscovery.layer.pipe(
            Layer.provide(
              layerDiscovery((input) =>
                input.command === "jj"
                  ? Effect.succeed(
                      TestSourceControlHost.processOutput("warning: development build\n", {
                        stderr: output,
                      }),
                    )
                  : run(input),
              ),
            ),
          ),
        ),
      );
      const result = yield* discovery.discover;
      const jj = result.versionControlSystems.find((item) => item.kind === "jj");
      assert.ok(jj);
      assert.strictEqual(jj.status, "unsupported");
      if (output)
        assert.strictEqual(
          Option.getOrNull(jj.detail),
          `Jujutsu 0.41.0 is unsupported. T3 Code requires jj ${JJ_MINIMUM_SUPPORTED_VERSION} or newer.`,
        );
      else assert.isTrue(Option.isNone(jj.version));
    }
  }),
);
