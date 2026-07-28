import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const VcsDriverKind = Schema.Literals(["git", "jj", "unknown"]);
export type VcsDriverKind = typeof VcsDriverKind.Type;

export const VcsFreshnessSource = Schema.Literals([
  "live-local",
  "cached-local",
  "cached-remote",
  "explicit-remote",
]);
export type VcsFreshnessSource = typeof VcsFreshnessSource.Type;

export const VcsFreshness = Schema.Struct({
  source: VcsFreshnessSource,
  observedAt: Schema.DateTimeUtc,
  expiresAt: Schema.Option(Schema.DateTimeUtc),
});
export type VcsFreshness = typeof VcsFreshness.Type;

export const VcsDriverCapabilities = Schema.Struct({
  kind: VcsDriverKind,
  supportsWorktrees: Schema.Boolean,
  supportsBookmarks: Schema.Boolean,
  supportsAtomicSnapshot: Schema.Boolean,
  supportsPushDefaultRemote: Schema.Boolean,
  supportsWorkspaces: Schema.optional(Schema.Boolean),
  supportsNamedPublishRefs: Schema.optional(Schema.Boolean),
  supportsSelectedFileFinalize: Schema.optional(Schema.Boolean),
  supportsThreadLocalRestore: Schema.optional(Schema.Boolean),
  supportsDefaultRemotePush: Schema.optional(Schema.Boolean),
  supportsGitProviderCompatibility: Schema.optional(Schema.Boolean),
  ignoreClassifier: Schema.Literals(["native", "git-compatible-fallback"]),
});
export type VcsDriverCapabilities = typeof VcsDriverCapabilities.Type;

export const VcsRepositoryIdentity = Schema.Struct({
  kind: VcsDriverKind,
  rootPath: TrimmedNonEmptyString,
  metadataPath: Schema.NullOr(TrimmedNonEmptyString),
  colocated: Schema.optional(Schema.Boolean),
  freshness: VcsFreshness,
});
export type VcsRepositoryIdentity = typeof VcsRepositoryIdentity.Type;

export const VcsListWorkspaceFilesResult = Schema.Struct({
  paths: Schema.Array(TrimmedNonEmptyString),
  truncated: Schema.Boolean,
  freshness: VcsFreshness,
});
export type VcsListWorkspaceFilesResult = typeof VcsListWorkspaceFilesResult.Type;

export const VcsRemote = Schema.Struct({
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  pushUrl: Schema.Option(TrimmedNonEmptyString),
  isPrimary: Schema.Boolean,
});
export type VcsRemote = typeof VcsRemote.Type;

export const VcsListRemotesResult = Schema.Struct({
  remotes: Schema.Array(VcsRemote),
  freshness: VcsFreshness,
});
export type VcsListRemotesResult = typeof VcsListRemotesResult.Type;

export const VcsAddRemoteInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
});
export type VcsAddRemoteInput = typeof VcsAddRemoteInput.Type;

export const VcsRemoveRemoteInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type VcsRemoveRemoteInput = typeof VcsRemoveRemoteInput.Type;

export const VcsCloneRepositoryInput = Schema.Struct({
  kind: Schema.optional(VcsDriverKind),
  source: TrimmedNonEmptyString,
  destination: TrimmedNonEmptyString,
});
export type VcsCloneRepositoryInput = typeof VcsCloneRepositoryInput.Type;

export const VcsNamedRefKind = Schema.Literals(["branch", "bookmark"]);
export type VcsNamedRefKind = typeof VcsNamedRefKind.Type;

export const VcsRevision = Schema.Struct({
  commitId: TrimmedNonEmptyString,
  changeId: Schema.optional(TrimmedNonEmptyString),
});
export type VcsRevision = typeof VcsRevision.Type;

export const VcsNamedRef = Schema.Struct({
  kind: VcsNamedRefKind,
  name: TrimmedNonEmptyString,
  remoteName: Schema.optional(TrimmedNonEmptyString),
  target: Schema.optional(VcsRevision),
});
export type VcsNamedRef = typeof VcsNamedRef.Type;

export const VcsDivergence = Schema.Struct({
  ahead: NonNegativeInt,
  behind: NonNegativeInt,
  divergent: Schema.Boolean,
});
export type VcsDivergence = typeof VcsDivergence.Type;

export const VcsConflictKind = Schema.Literals(["content", "named-ref"]);
export type VcsConflictKind = typeof VcsConflictKind.Type;

export const VcsConflict = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("content"),
    path: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("named-ref"),
    ref: VcsNamedRef,
  }),
]);
export type VcsConflict = typeof VcsConflict.Type;

export const VcsTrackedRemoteState = Schema.Struct({
  remoteName: TrimmedNonEmptyString,
  remoteRef: VcsNamedRef,
  divergence: VcsDivergence,
});
export type VcsTrackedRemoteState = typeof VcsTrackedRemoteState.Type;

export const VcsWorkspaceIdentity = Schema.Struct({
  driverKind: VcsDriverKind,
  name: Schema.NullOr(TrimmedNonEmptyString),
  rootPath: TrimmedNonEmptyString,
  workspaceRevision: Schema.NullOr(VcsRevision),
  baseRevision: Schema.optional(Schema.NullOr(VcsRevision)),
  publishRef: Schema.NullOr(VcsNamedRef),
});
export type VcsWorkspaceIdentity = typeof VcsWorkspaceIdentity.Type;

/** Compatibility shape used while persisted Git thread fields are migrated. */
export const VcsThreadWorkspace = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(2),
    workspace: VcsWorkspaceIdentity,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    branch: Schema.NullOr(TrimmedNonEmptyString),
    worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  }),
]);
export type VcsThreadWorkspace = typeof VcsThreadWorkspace.Type;

export const VcsWorkflowKind = Schema.Literals(["change", "workspace", "sync", "checkpoint"]);
export type VcsWorkflowKind = typeof VcsWorkflowKind.Type;

export class VcsWorkflowError extends Schema.TaggedErrorClass<VcsWorkflowError>()(
  "VcsWorkflowError",
  {
    workflow: VcsWorkflowKind,
    operation: TrimmedNonEmptyString,
    kind: VcsDriverKind,
    detail: TrimmedNonEmptyString,
    recoverable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `VCS ${this.workflow} workflow failed in ${this.operation}: ${this.detail}`;
  }
}

export const VcsActionProgressPhase = Schema.Literals([
  "prepare-ref",
  "finalize-change",
  "sync",
  "publish",
  "change-request",
]);
export type VcsActionProgressPhase = typeof VcsActionProgressPhase.Type;

export const VcsActionProgressEvent = Schema.Union([
  Schema.TaggedStruct("action-started", {
    actionId: TrimmedNonEmptyString,
    phases: Schema.Array(VcsActionProgressPhase),
  }),
  Schema.TaggedStruct("phase-started", {
    actionId: TrimmedNonEmptyString,
    phase: VcsActionProgressPhase,
    label: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("output", {
    actionId: TrimmedNonEmptyString,
    phase: VcsActionProgressPhase,
    stream: Schema.Literals(["stdout", "stderr"]),
    text: Schema.String,
  }),
  Schema.TaggedStruct("action-finished", {
    actionId: TrimmedNonEmptyString,
  }),
  Schema.TaggedStruct("action-failed", {
    actionId: TrimmedNonEmptyString,
    phase: Schema.NullOr(VcsActionProgressPhase),
    message: TrimmedNonEmptyString,
  }),
]);
export type VcsActionProgressEvent = typeof VcsActionProgressEvent.Type;

export interface VcsProcessErrorContext {
  readonly operation: string;
  readonly command: string;
  readonly cwd: string;
  readonly argumentCount?: number;
}

export interface VcsProcessSpawnFailure {
  readonly cause: unknown;
}

export interface VcsProcessTimeoutFailure {
  readonly timeoutMs: number;
}

export const VcsProcessExitFailureKind = Schema.Literals([
  "authentication",
  "not-found",
  "not-repository",
  "stale-workspace",
  "unresolved-revision",
  "bookmark-conflict",
  "push-rejected",
  "invalid-ref",
  "command-failed",
]);
export type VcsProcessExitFailureKind = typeof VcsProcessExitFailureKind.Type;

export interface VcsProcessExitFailure {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stderrTruncated: boolean;
}

export class VcsProcessSpawnError extends Schema.TaggedErrorClass<VcsProcessSpawnError>()(
  "VcsProcessSpawnError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    argumentCount: Schema.optional(NonNegativeInt),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `VCS process failed to spawn in ${this.operation}: ${this.command} (${this.cwd})`;
  }

  static fromProcessSpawnError(context: VcsProcessErrorContext, error: VcsProcessSpawnFailure) {
    return new VcsProcessSpawnError({
      ...context,
      cause: error.cause,
    });
  }
}

export class VcsProcessExitError extends Schema.TaggedErrorClass<VcsProcessExitError>()(
  "VcsProcessExitError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    argumentCount: Schema.optional(NonNegativeInt),
    exitCode: Schema.Number,
    detail: Schema.String,
    failureKind: Schema.optional(VcsProcessExitFailureKind),
    stderrLength: Schema.optional(NonNegativeInt),
    stderrTruncated: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    return `VCS process failed in ${this.operation}: ${this.command} (${this.cwd}) exited with ${this.exitCode} - ${this.detail}`;
  }

  static fromProcessExit(
    context: VcsProcessErrorContext,
    error: VcsProcessExitFailure,
    failureKind: VcsProcessExitFailureKind,
  ) {
    const detail = (() => {
      switch (failureKind) {
        case "authentication":
          return "Authentication failed.";
        case "not-found":
          return context.command === "glab"
            ? "Merge request not found."
            : context.command === "gh" || context.command === "az"
              ? "Pull request not found."
              : "VCS resource not found.";
        case "not-repository":
          return "The directory is not inside a Jujutsu repository.";
        case "stale-workspace":
          return "The Jujutsu workspace is stale and must be updated.";
        case "unresolved-revision":
          return "The Jujutsu revision could not be resolved.";
        case "bookmark-conflict":
          return "The Jujutsu bookmark is conflicted.";
        case "push-rejected":
          return "Jujutsu rejected the push to protect remote work.";
        case "invalid-ref":
          return "The Jujutsu bookmark cannot be represented by the Git remote.";
        case "command-failed":
          return "Process exited with a non-zero status.";
      }
    })();

    return new VcsProcessExitError({
      ...context,
      exitCode: error.exitCode,
      detail,
      failureKind,
      stderrLength: error.stderr.length,
      stderrTruncated: error.stderrTruncated,
    });
  }
}

export class VcsProcessTimeoutError extends Schema.TaggedErrorClass<VcsProcessTimeoutError>()(
  "VcsProcessTimeoutError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    argumentCount: Schema.optional(NonNegativeInt),
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `VCS process timed out in ${this.operation}: ${this.command} (${this.cwd}) after ${this.timeoutMs}ms`;
  }

  static fromProcessTimeoutError(context: VcsProcessErrorContext, error: VcsProcessTimeoutFailure) {
    return new VcsProcessTimeoutError({
      ...context,
      timeoutMs: error.timeoutMs,
    });
  }
}

const VcsProcessBoundaryErrorFields = {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  argumentCount: Schema.optional(NonNegativeInt),
};

export class VcsProcessStdinWriteError extends Schema.TaggedErrorClass<VcsProcessStdinWriteError>()(
  "VcsProcessStdinWriteError",
  {
    ...VcsProcessBoundaryErrorFields,
    stdinBytes: NonNegativeInt,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `VCS process failed to write ${this.stdinBytes} bytes to stdin in ${this.operation}: ${this.command} (${this.cwd})`;
  }
}

export class VcsProcessOutputReadError extends Schema.TaggedErrorClass<VcsProcessOutputReadError>()(
  "VcsProcessOutputReadError",
  {
    ...VcsProcessBoundaryErrorFields,
    stream: Schema.Literals(["stdout", "stderr", "exitCode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `VCS process failed to read ${this.stream} in ${this.operation}: ${this.command} (${this.cwd})`;
  }
}

export class VcsProcessOutputLimitError extends Schema.TaggedErrorClass<VcsProcessOutputLimitError>()(
  "VcsProcessOutputLimitError",
  {
    ...VcsProcessBoundaryErrorFields,
    stream: Schema.Literals(["stdout", "stderr"]),
    maxBytes: NonNegativeInt,
    observedBytes: NonNegativeInt,
  },
) {
  override get message(): string {
    return `VCS process ${this.stream} produced ${this.observedBytes} bytes in ${this.operation}: ${this.command} (${this.cwd}), exceeding the ${this.maxBytes} byte limit`;
  }
}

export class VcsProcessMissingExitCodeError extends Schema.TaggedErrorClass<VcsProcessMissingExitCodeError>()(
  "VcsProcessMissingExitCodeError",
  VcsProcessBoundaryErrorFields,
) {
  override get message(): string {
    return `VCS process completed without an exit code in ${this.operation}: ${this.command} (${this.cwd})`;
  }
}

export const VcsOutputDecodeError = Schema.Union([
  VcsProcessStdinWriteError,
  VcsProcessOutputReadError,
  VcsProcessOutputLimitError,
  VcsProcessMissingExitCodeError,
]);
export type VcsOutputDecodeError = typeof VcsOutputDecodeError.Type;

export class VcsRepositoryDetectionError extends Schema.TaggedErrorClass<VcsRepositoryDetectionError>()(
  "VcsRepositoryDetectionError",
  {
    operation: Schema.String,
    cwd: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `VCS repository detection failed in ${this.operation}: ${this.cwd} - ${this.detail}`;
  }
}

export class VcsUnsupportedOperationError extends Schema.TaggedErrorClass<VcsUnsupportedOperationError>()(
  "VcsUnsupportedOperationError",
  {
    operation: Schema.String,
    kind: VcsDriverKind,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `VCS operation is unsupported for ${this.kind} in ${this.operation}: ${this.detail}`;
  }
}

export const VcsError = Schema.Union([
  VcsProcessSpawnError,
  VcsProcessExitError,
  VcsProcessTimeoutError,
  VcsProcessStdinWriteError,
  VcsProcessOutputReadError,
  VcsProcessOutputLimitError,
  VcsProcessMissingExitCodeError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  VcsWorkflowError,
]);
export type VcsError = typeof VcsError.Type;
