// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  JJ_MINIMUM_SUPPORTED_VERSION,
  classifyJjCommandFailure,
  classifyJjRevisionCondition,
  inspectJjVersion,
  jjMachineCommand,
  parseJjJsonLines,
  quoteJjSymbol,
  type JjChangedFileRecord,
  type JjRevisionRecord,
} from "@t3tools/shared/jjCli";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CheckpointMetadata {
  readonly operationId: string;
  readonly workspaceName: string;
  readonly commitId: string;
  readonly changeId: string;
  readonly description: string;
}

const JJ_TEST_CONFIG = [
  "--config",
  'user.name="T3 Code jj contract"',
  "--config",
  'user.email="jj-contract@example.invalid"',
] as const;

function run(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  options?: { readonly allowFailure?: boolean },
): CommandResult {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  });

  if (result.error) {
    throw result.error;
  }

  const exitCode = result.status ?? 1;
  const output = {
    exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };

  if (exitCode !== 0 && options?.allowFailure !== true) {
    throw new Error(
      `${command} failed with ${exitCode}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
    );
  }

  return output;
}

function runJj(
  cwd: string,
  args: ReadonlyArray<string>,
  options?: { readonly allowFailure?: boolean },
): CommandResult {
  return run("jj", [...JJ_TEST_CONFIG, ...args], cwd, options);
}

function parseSingleRecord<T>(output: string): T {
  const records = parseJjJsonLines(output);
  NodeAssert.equal(records.length, 1);
  return records[0] as T;
}

function revision(cwd: string, revisionId = "@"): JjRevisionRecord {
  return parseSingleRecord<JjRevisionRecord>(
    runJj(cwd, jjMachineCommand.revision(revisionId)).stdout,
  );
}

function currentOperation(cwd: string): Record<string, unknown> {
  return parseSingleRecord<Record<string, unknown>>(
    runJj(cwd, jjMachineCommand.currentOperation()).stdout,
  );
}

function bookmarkTarget(cwd: string, name: string): ReadonlyArray<string> {
  const records = parseJjJsonLines(runJj(cwd, jjMachineCommand.bookmarks()).stdout);
  const record = records.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      "name" in candidate &&
      candidate.name === name &&
      !("remote" in candidate),
  );
  NodeAssert.ok(typeof record === "object" && record !== null);
  const target = "target" in record ? record.target : undefined;
  NodeAssert.ok(Array.isArray(target));
  return target as ReadonlyArray<string>;
}

const versionOutput = run("jj", ["--version"], process.cwd()).stdout;
const versionSupport = inspectJjVersion(versionOutput);
NodeAssert.equal(
  versionSupport.status,
  "supported",
  versionSupport.status === "supported" ? undefined : versionSupport.detail,
);

const testRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-jj-phase-zero-"));

try {
  const sourcePath = NodePath.join(testRoot, "source space-雪");
  const clonePath = NodePath.join(testRoot, "clone space-雪");
  const secondWorkspacePath = NodePath.join(testRoot, "workspace space-雪");
  NodeFS.mkdirSync(sourcePath);

  runJj(testRoot, ["git", "init", "--colocate", sourcePath]);
  NodeAssert.ok(NodeFS.existsSync(NodePath.join(sourcePath, ".jj")));
  NodeAssert.ok(NodeFS.existsSync(NodePath.join(sourcePath, ".git")));

  const fileNames =
    process.env.OS === "Windows_NT"
      ? ["space snow-雪.txt"]
      : ["space snow-雪.txt", "tab\tname.txt", "line\nbreak.txt"];
  for (const fileName of fileNames) {
    NodeFS.writeFileSync(NodePath.join(sourcePath, fileName), `checkpoint:${fileName}\n`);
  }

  runJj(sourcePath, ["util", "snapshot"]);
  const initialDescription = "phase zero\nUnicode 雪 and tab\tcontent";
  runJj(sourcePath, ["describe", "--message", initialDescription]);

  const initialRevision = revision(sourcePath);
  NodeAssert.equal(initialRevision.description, `${initialDescription}\n`);
  NodeAssert.equal(classifyJjRevisionCondition(initialRevision), null);

  const changedFiles = parseJjJsonLines(
    runJj(sourcePath, jjMachineCommand.changedFiles()).stdout,
  ) as ReadonlyArray<JjChangedFileRecord>;
  NodeAssert.deepEqual(new Set(changedFiles.map((file) => file.path)), new Set(fileNames));

  runJj(sourcePath, ["commit", "--message", "baseline"]);
  for (const bookmark of ["main", "feature-雪"]) {
    runJj(sourcePath, ["bookmark", "create", quoteJjSymbol(bookmark), "--revision", "@-"]);
  }

  for (const invalidBookmark of ["feature space", "tab\tname", "line\nname"]) {
    const result = runJj(
      sourcePath,
      ["bookmark", "create", quoteJjSymbol(invalidBookmark), "--revision", "@-"],
      { allowFailure: true },
    );
    NodeAssert.equal(
      classifyJjCommandFailure({ exitCode: result.exitCode, stderr: result.stderr }),
      "invalid-ref",
    );
    runJj(sourcePath, ["bookmark", "delete", quoteJjSymbol(invalidBookmark)], {
      allowFailure: true,
    });
  }

  NodeFS.writeFileSync(NodePath.join(sourcePath, fileNames[0] as string), "checkpoint version\n");
  runJj(sourcePath, ["util", "snapshot"]);
  const checkpointDescription = "checkpoint description\nwith tab\tand 雪";
  runJj(sourcePath, ["describe", "--message", checkpointDescription]);
  const checkpointRevision = revision(sourcePath);
  const checkpointOperation = currentOperation(sourcePath);
  NodeAssert.equal(typeof checkpointOperation.id, "string");

  const checkpoint: CheckpointMetadata = {
    operationId: checkpointOperation.id as string,
    workspaceName: "default",
    commitId: checkpointRevision.commitId,
    changeId: checkpointRevision.changeId,
    description: checkpointRevision.description,
  };
  const checkpointPath = NodePath.join(testRoot, "checkpoint.json");
  NodeFS.writeFileSync(checkpointPath, JSON.stringify(checkpoint));

  runJj(sourcePath, [
    "workspace",
    "add",
    secondWorkspacePath,
    "--name",
    "contract-雪",
    "--revision",
    quoteJjSymbol("feature-雪"),
  ]);
  const workspaces = parseJjJsonLines(runJj(sourcePath, jjMachineCommand.workspaces()).stdout);
  NodeAssert.ok(
    workspaces.some(
      (workspace) =>
        typeof workspace === "object" &&
        workspace !== null &&
        "name" in workspace &&
        workspace.name === "contract-雪",
    ),
  );

  const secondWorkspaceFile = NodePath.join(secondWorkspacePath, fileNames[0] as string);
  NodeFS.writeFileSync(secondWorkspaceFile, "second workspace version\n");
  runJj(secondWorkspacePath, ["util", "snapshot"]);
  const secondWorkspaceRevision = revision(secondWorkspacePath);

  NodeFS.writeFileSync(NodePath.join(sourcePath, fileNames[0] as string), "after checkpoint\n");
  runJj(sourcePath, ["util", "snapshot"]);
  NodeAssert.notEqual(revision(sourcePath).commitId, checkpoint.commitId);

  const featureTargetBeforeRestore = bookmarkTarget(sourcePath, "feature-雪");
  runJj(sourcePath, ["util", "gc", "--expire", "now"]);

  // New file read plus new jj processes model a server restart before restore.
  const restartedCheckpoint = JSON.parse(
    NodeFS.readFileSync(checkpointPath, "utf8"),
  ) as CheckpointMetadata;
  NodeAssert.equal(
    revision(sourcePath, restartedCheckpoint.commitId).changeId,
    restartedCheckpoint.changeId,
  );

  runJj(sourcePath, ["restore", "--from", restartedCheckpoint.commitId, "--into", "@"]);
  runJj(sourcePath, ["describe", "--message", restartedCheckpoint.description.trimEnd()]);

  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(sourcePath, fileNames[0] as string), "utf8"),
    "checkpoint version\n",
  );
  NodeAssert.equal(NodeFS.readFileSync(secondWorkspaceFile, "utf8"), "second workspace version\n");
  NodeAssert.equal(revision(secondWorkspacePath).commitId, secondWorkspaceRevision.commitId);
  NodeAssert.deepEqual(bookmarkTarget(sourcePath, "feature-雪"), featureTargetBeforeRestore);
  NodeAssert.notEqual(currentOperation(sourcePath).id, restartedCheckpoint.operationId);

  runJj(testRoot, ["git", "clone", "--colocate", sourcePath, clonePath]);
  NodeAssert.ok(NodeFS.existsSync(NodePath.join(clonePath, ".jj")));
  NodeAssert.ok(NodeFS.existsSync(NodePath.join(clonePath, ".git")));

  const nonRepository = runJj(testRoot, ["status"], { allowFailure: true });
  NodeAssert.equal(
    classifyJjCommandFailure({
      exitCode: nonRepository.exitCode,
      stderr: nonRepository.stderr,
    }),
    "not-repository",
  );

  const unresolvedRevision = runJj(sourcePath, ["log", "--revisions", "t3code_missing_revision"], {
    allowFailure: true,
  });
  NodeAssert.equal(
    classifyJjCommandFailure({
      exitCode: unresolvedRevision.exitCode,
      stderr: unresolvedRevision.stderr,
    }),
    "unresolved-revision",
  );

  process.stdout.write(
    `jj Phase 0 contract passed with jj ${versionSupport.version} (minimum ${JJ_MINIMUM_SUPPORTED_VERSION})\n`,
  );
} finally {
  NodeFS.rmSync(testRoot, { recursive: true, force: true });
}
