import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  VcsProcessExitError,
  VcsRepositoryDetectionError,
  type VcsListRemotesResult,
  type VcsRef,
} from "@t3tools/contracts";
import { detectSourceControlProviderFromGitRemoteUrl } from "@t3tools/shared/git";
import {
  JJ_BOOKMARK_JSON_TEMPLATE,
  JJ_CHANGED_FILE_JSON_TEMPLATE,
  JJ_REVISION_JSON_TEMPLATE,
  isJjBookmarkRecord,
  isJjChangedFileRecord,
  isJjRevisionRecord,
  parseJjJsonLines,
  quoteJjSymbol,
  type JjBookmarkRecord,
  type JjChangedFileRecord,
  type JjRevisionRecord,
} from "@t3tools/shared/jjCli";
import { parseTurnDiffFilesFromUnifiedDiff } from "../checkpointing/Diffs.ts";
import * as JjProcess from "./JjProcess.ts";
import * as VcsDriver from "./VcsDriver.ts";

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const REMOTES_MAX_OUTPUT_BYTES = 256 * 1024;
const STATUS_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000;
const FILE_TEMPLATE = 'json(path) ++ "\\n"';
const COUNT_TEMPLATE = 'commit_id ++ "\\n"';

function dataContractError(operation: string, cwd: string, detail: string) {
  return new VcsProcessExitError({
    operation,
    command: "jj",
    cwd,
    exitCode: 0,
    detail,
  });
}

function parseRecords<T>(input: {
  readonly operation: string;
  readonly cwd: string;
  readonly output: string;
  readonly truncated: boolean;
  readonly guard: (value: unknown) => value is T;
  readonly label: string;
}) {
  if (input.truncated) {
    return Effect.fail(
      dataContractError(
        input.operation,
        input.cwd,
        `jj returned truncated ${input.label} machine output.`,
      ),
    );
  }

  return Effect.try({
    try: () => {
      const records = parseJjJsonLines(input.output);
      if (!records.every(input.guard)) {
        throw new Error(`jj returned an invalid ${input.label} JSON record.`);
      }
      return records;
    },
    catch: () =>
      dataContractError(
        input.operation,
        input.cwd,
        `jj returned invalid ${input.label} machine output.`,
      ),
  });
}

function paginateRefs(
  refs: ReadonlyArray<VcsRef>,
  input: { readonly cursor?: number | undefined; readonly limit?: number | undefined },
) {
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? 100;
  const page = refs.slice(cursor, cursor + limit);
  const nextCursor = cursor + page.length < refs.length ? cursor + page.length : null;
  return { refs: page, nextCursor, totalCount: refs.length };
}

function remoteBookmarkName(record: Pick<JjBookmarkRecord, "name" | "remote">): string {
  return record.remote ? `${record.name}@${record.remote}` : record.name;
}

export function collectJjStatusConflicts(input: {
  readonly revision: Pick<JjRevisionRecord, "conflict">;
  readonly changedFiles: ReadonlyArray<Pick<JjChangedFileRecord, "path" | "conflict">>;
  readonly bookmarks: ReadonlyArray<Pick<JjBookmarkRecord, "name" | "remote" | "target">>;
}): ReadonlyArray<
  | {
      readonly kind: "content";
      readonly path: string;
    }
  | {
      readonly kind: "named-ref";
      readonly refName: string;
    }
> {
  const contentConflicts = input.changedFiles
    .filter((file) => file.conflict)
    .map((file) => ({ kind: "content" as const, path: file.path }));
  const namedRefConflicts = input.bookmarks
    .filter((bookmark) => bookmark.target.length > 1)
    .map((bookmark) => ({
      kind: "named-ref" as const,
      refName: remoteBookmarkName(bookmark),
    }));
  return [...contentConflicts, ...namedRefConflicts];
}

const nowFreshness = Effect.fn("JjVcsDriver.nowFreshness")(function* () {
  return {
    source: "live-local" as const,
    observedAt: yield* DateTime.now,
    expiresAt: Option.none(),
  };
});

function parseRemoteList(output: string): ReadonlyArray<{ name: string; url: string }> {
  return output.split("\n").flatMap((line) => {
    const match = /^(\S+)\s+(.+)$/.exec(line.trim());
    return match?.[1] && match[2] ? [{ name: match[1], url: match[2] }] : [];
  });
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const jj = yield* JjProcess.JjProcess;

  const capabilities = {
    kind: "jj" as const,
    supportsWorktrees: false,
    supportsBookmarks: true,
    supportsAtomicSnapshot: true,
    supportsPushDefaultRemote: true,
    supportsWorkspaces: true,
    supportsNamedPublishRefs: true,
    supportsSelectedFileFinalize: true,
    supportsThreadLocalRestore: true,
    supportsDefaultRemotePush: true,
    supportsGitProviderCompatibility: true,
    ignoreClassifier: "native" as const,
  };

  const exists = (cwd: string, candidate: string, operation: string) =>
    fileSystem.exists(candidate).pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            operation,
            cwd,
            detail: `Failed to inspect ${candidate}.`,
            cause,
          }),
      ),
    );

  const findMetadataPath = Effect.fn("JjVcsDriver.findMetadataPath")(function* (cwd: string) {
    let current = path.resolve(cwd);
    while (true) {
      const candidate = path.join(current, ".jj");
      if (yield* exists(cwd, candidate, "JjVcsDriver.findMetadataPath")) {
        return candidate;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  });

  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
    jj.run({
      operation: input.operation,
      cwd: input.cwd,
      repository: input.cwd,
      args: input.args,
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: input.appendTruncationMarker }
        : {}),
    });

  const snapshot = (cwd: string, operation: string) =>
    jj
      .run({
        operation,
        cwd,
        repository: cwd,
        args: ["util", "snapshot"],
        timeoutMs: 20_000,
        maxOutputBytes: 256 * 1024,
      })
      .pipe(Effect.asVoid);

  const readRevision = Effect.fn("JjVcsDriver.readRevision")(function* (
    cwd: string,
    revision = "@",
  ) {
    const operation = "JjVcsDriver.readRevision";
    const result = yield* jj.run({
      operation,
      cwd,
      repository: cwd,
      args: ["log", "--no-graph", "--revisions", revision, "--template", JJ_REVISION_JSON_TEMPLATE],
      timeoutMs: 10_000,
      maxOutputBytes: STATUS_MAX_OUTPUT_BYTES,
    });
    const records = yield* parseRecords({
      operation,
      cwd,
      output: result.stdout,
      truncated: result.stdoutTruncated,
      guard: isJjRevisionRecord,
      label: "revision",
    });
    if (records.length !== 1) {
      return yield* dataContractError(
        operation,
        cwd,
        `jj revision query returned ${records.length} records; expected exactly one.`,
      );
    }
    return records[0] as JjRevisionRecord;
  });

  const readChangedFiles = Effect.fn("JjVcsDriver.readChangedFiles")(function* (
    cwd: string,
    revision = "@",
  ) {
    const operation = "JjVcsDriver.readChangedFiles";
    const result = yield* jj.run({
      operation,
      cwd,
      repository: cwd,
      args: [
        "log",
        "--no-graph",
        "--revisions",
        revision,
        "--template",
        JJ_CHANGED_FILE_JSON_TEMPLATE,
      ],
      timeoutMs: 10_000,
      maxOutputBytes: STATUS_MAX_OUTPUT_BYTES,
    });
    return yield* parseRecords({
      operation,
      cwd,
      output: result.stdout,
      truncated: result.stdoutTruncated,
      guard: isJjChangedFileRecord,
      label: "changed-file",
    });
  });

  const readBookmarks = Effect.fn("JjVcsDriver.readBookmarks")(function* (cwd: string) {
    const operation = "JjVcsDriver.readBookmarks";
    const result = yield* jj.run({
      operation,
      cwd,
      repository: cwd,
      args: ["bookmark", "list", "--all-remotes", "--template", JJ_BOOKMARK_JSON_TEMPLATE],
      timeoutMs: 10_000,
      maxOutputBytes: STATUS_MAX_OUTPUT_BYTES,
    });
    return yield* parseRecords({
      operation,
      cwd,
      output: result.stdout,
      truncated: result.stdoutTruncated,
      guard: isJjBookmarkRecord,
      label: "bookmark",
    });
  });

  const readPatch = (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly appendTruncationMarker?: boolean;
  }) =>
    jj.run({
      operation: input.operation,
      cwd: input.cwd,
      repository: input.cwd,
      args: ["diff", "--git", ...input.args],
      timeoutMs: 30_000,
      maxOutputBytes: REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES,
      appendTruncationMarker: input.appendTruncationMarker ?? true,
    });

  const hashDiff = (cwd: string, diff: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(diff)).pipe(
      Effect.map(Encoding.encodeHex),
      Effect.mapError(() =>
        dataContractError("JjVcsDriver.getDiffPreview.hash", cwd, "Failed to hash jj review diff."),
      ),
    );

  const countRevisionRange = Effect.fn("JjVcsDriver.countRevisionRange")(function* (
    cwd: string,
    revision: string,
  ) {
    const result = yield* jj.run({
      operation: "JjVcsDriver.countRevisionRange",
      cwd,
      repository: cwd,
      args: ["log", "--no-graph", "--revisions", revision, "--template", COUNT_TEMPLATE],
      timeoutMs: 10_000,
      maxOutputBytes: STATUS_MAX_OUTPUT_BYTES,
    });
    return result.stdout.split("\n").filter((line) => line.length > 0).length;
  });

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "JjVcsDriver.detectRepository",
  )(function* (cwd) {
    const metadataPath = yield* findMetadataPath(cwd);
    if (metadataPath === null) {
      return null;
    }

    yield* jj.ensureSupportedVersion(cwd);
    const rootResult = yield* jj.run({
      operation: "JjVcsDriver.detectRepository.root",
      cwd,
      repository: cwd,
      args: ["workspace", "root"],
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024,
    });
    const rootPath = rootResult.stdout.trim();
    if (rootPath.length === 0) {
      return yield* new VcsProcessExitError({
        operation: "JjVcsDriver.detectRepository.root",
        command: "jj workspace root",
        cwd,
        exitCode: rootResult.exitCode,
        detail: "jj workspace root returned an empty path.",
      });
    }

    return {
      kind: "jj" as const,
      rootPath,
      metadataPath,
      colocated: yield* exists(cwd, path.join(rootPath, ".git"), "JjVcsDriver.detectRepository"),
      freshness: yield* nowFreshness(),
    };
  });

  const isInsideWorkTree: VcsDriver.VcsDriver["Service"]["isInsideWorkTree"] = (cwd) =>
    findMetadataPath(cwd).pipe(Effect.map((metadataPath) => metadataPath !== null));

  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = Effect.fn(
    "JjVcsDriver.listWorkspaceFiles",
  )(function* (cwd) {
    const result = yield* jj.run({
      operation: "JjVcsDriver.listWorkspaceFiles",
      cwd,
      repository: cwd,
      args: ["file", "list", "--revision", "@", "--template", FILE_TEMPLATE],
      timeoutMs: 20_000,
      maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
      appendTruncationMarker: false,
    });
    if (result.stdoutTruncated) {
      return yield* dataContractError(
        "JjVcsDriver.listWorkspaceFiles",
        cwd,
        "jj file list returned truncated machine output.",
      );
    }
    const records = parseJjJsonLines(result.stdout);
    const paths = records.flatMap((record) => (typeof record === "string" ? [record] : []));
    if (paths.length !== records.length) {
      return yield* new VcsProcessExitError({
        operation: "JjVcsDriver.listWorkspaceFiles",
        command: "jj file list",
        cwd,
        exitCode: 0,
        detail: "jj file list returned a non-string JSON record.",
      });
    }
    return {
      paths,
      truncated: result.stdoutTruncated,
      freshness: yield* nowFreshness(),
    };
  });

  const listRemotes: VcsDriver.VcsDriver["Service"]["listRemotes"] = Effect.fn(
    "JjVcsDriver.listRemotes",
  )(function* (cwd) {
    const result = yield* jj.run({
      operation: "JjVcsDriver.listRemotes",
      cwd,
      repository: cwd,
      args: ["git", "remote", "list"],
      timeoutMs: 5_000,
      maxOutputBytes: REMOTES_MAX_OUTPUT_BYTES,
    });
    const parsed = parseRemoteList(result.stdout);
    const primaryName = parsed.some((remote) => remote.name === "origin")
      ? "origin"
      : (parsed[0]?.name ?? null);
    return {
      remotes: parsed.map((remote) => ({
        ...remote,
        pushUrl: Option.none(),
        isPrimary: remote.name === primaryName,
      })),
      freshness: yield* nowFreshness(),
    };
  });

  const addRemote: VcsDriver.VcsDriver["Service"]["addRemote"] = (input) =>
    jj
      .run({
        operation: "JjVcsDriver.addRemote",
        cwd: input.cwd,
        repository: input.cwd,
        args: ["git", "remote", "add", input.name, input.url],
      })
      .pipe(Effect.asVoid);

  const removeRemote: VcsDriver.VcsDriver["Service"]["removeRemote"] = (input) =>
    jj
      .run({
        operation: "JjVcsDriver.removeRemote",
        cwd: input.cwd,
        repository: input.cwd,
        args: ["git", "remote", "remove", input.name],
      })
      .pipe(Effect.asVoid);

  const resolveDefaultRemote: VcsDriver.VcsDriver["Service"]["resolveDefaultRemote"] = (cwd) =>
    listRemotes(cwd).pipe(
      Effect.map(
        ({ remotes }) =>
          remotes.find((remote) => remote.isPrimary)?.name ?? remotes[0]?.name ?? null,
      ),
    );

  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = Effect.fn(
    "JjVcsDriver.filterIgnoredPaths",
  )(function* (cwd, relativePaths) {
    if (relativePaths.length === 0) {
      return relativePaths;
    }
    const listed = new Set((yield* listWorkspaceFiles(cwd)).paths);
    return yield* Effect.filter(relativePaths, (relativePath) =>
      exists(cwd, path.join(cwd, relativePath), "JjVcsDriver.filterIgnoredPaths").pipe(
        Effect.map((exists) => !exists || listed.has(relativePath)),
      ),
    );
  });

  const readStatusState = Effect.fn("JjVcsDriver.readStatusState")(function* (cwd: string) {
    yield* snapshot(cwd, "JjVcsDriver.readStatusState.snapshot");
    const [revision, changedFiles, patchResult, bookmarks, remotesResult] = yield* Effect.all(
      [
        readRevision(cwd),
        readChangedFiles(cwd),
        readPatch({ cwd, operation: "JjVcsDriver.readStatusState.diff", args: ["-r", "@"] }),
        readBookmarks(cwd),
        listRemotes(cwd),
      ],
      { concurrency: "unbounded" },
    );
    const referenceState = normalizeReferenceState({
      revision,
      bookmarks,
      remotesResult,
    });
    return { ...referenceState, changedFiles, patchResult };
  });

  const normalizeReferenceState = (input: {
    readonly revision: JjRevisionRecord;
    readonly bookmarks: ReadonlyArray<JjBookmarkRecord>;
    readonly remotesResult: VcsListRemotesResult;
  }) => {
    const remoteNames = new Set(input.remotesResult.remotes.map((remote) => remote.name));
    const usableBookmarks = input.bookmarks.filter(
      (bookmark) => bookmark.remote === undefined || remoteNames.has(bookmark.remote),
    );
    const defaultRemoteName =
      input.remotesResult.remotes.find((remote) => remote.isPrimary)?.name ??
      input.remotesResult.remotes[0]?.name ??
      null;
    const remoteBookmarks = usableBookmarks.filter(
      (bookmark) => bookmark.remote === defaultRemoteName,
    );
    const defaultRemoteBookmark =
      remoteBookmarks.find((bookmark) => bookmark.name === "main") ??
      remoteBookmarks.find((bookmark) => bookmark.name === "master") ??
      remoteBookmarks.toSorted((left, right) => left.name.localeCompare(right.name))[0] ??
      null;
    return {
      revision: input.revision,
      bookmarks: usableBookmarks,
      remotesResult: input.remotesResult,
      defaultRemoteName,
      defaultRemoteBookmark,
    };
  };

  const readReferenceState = Effect.fn("JjVcsDriver.readReferenceState")(function* (cwd: string) {
    yield* snapshot(cwd, "JjVcsDriver.readReferenceState.snapshot");
    const [revision, bookmarks, remotesResult] = yield* Effect.all(
      [readRevision(cwd), readBookmarks(cwd), listRemotes(cwd)],
      { concurrency: "unbounded" },
    );
    return normalizeReferenceState({ revision, bookmarks, remotesResult });
  });

  const getLocalStatus: NonNullable<VcsDriver.VcsDriver["Service"]["getLocalStatus"]> = Effect.fn(
    "JjVcsDriver.getLocalStatus",
  )(function* (input) {
    const state = yield* readStatusState(input.cwd);
    if (state.patchResult.stdoutTruncated) {
      return yield* dataContractError(
        "JjVcsDriver.getLocalStatus.diffStats",
        input.cwd,
        "jj status patch output was truncated.",
      );
    }
    const parsedStats = yield* Effect.try({
      try: () => parseTurnDiffFilesFromUnifiedDiff(state.patchResult.stdout),
      catch: () =>
        dataContractError(
          "JjVcsDriver.getLocalStatus.diffStats",
          input.cwd,
          "Failed to parse jj Git-format status patch.",
        ),
    });
    const statsByPath = new Map(parsedStats.map((file) => [file.path, file]));
    let insertions = 0;
    let deletions = 0;
    const files = state.changedFiles
      .map((file) => {
        const stats = statsByPath.get(file.path) ?? { additions: 0, deletions: 0 };
        insertions += stats.additions;
        deletions += stats.deletions;
        return { path: file.path, insertions: stats.additions, deletions: stats.deletions };
      })
      .toSorted((left, right) => left.path.localeCompare(right.path));
    const conflicts = collectJjStatusConflicts(state);
    const primaryRemote =
      state.remotesResult.remotes.find((remote) => remote.isPrimary) ??
      state.remotesResult.remotes[0];
    const sourceControlProvider = primaryRemote
      ? detectSourceControlProviderFromGitRemoteUrl(primaryRemote.url)
      : null;

    return {
      isRepo: true,
      driverKind: "jj" as const,
      workspaceRevision: state.revision.changeId,
      workspaceRevisionDetails: {
        commitId: state.revision.commitId,
        changeId: state.revision.changeId,
        description: state.revision.description,
        parents: [...state.revision.parents],
        empty: state.revision.empty,
      },
      publishRef: null,
      defaultRef: state.defaultRemoteBookmark
        ? remoteBookmarkName(state.defaultRemoteBookmark)
        : null,
      conflicts: [...conflicts],
      ...(sourceControlProvider ? { sourceControlProvider } : {}),
      hasPrimaryRemote: state.defaultRemoteName !== null,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: !state.revision.empty,
      workingTree: { files, insertions, deletions },
    };
  });

  const getRemoteStatus: NonNullable<VcsDriver.VcsDriver["Service"]["getRemoteStatus"]> = Effect.fn(
    "JjVcsDriver.getRemoteStatus",
  )(function* (input) {
    const state = yield* readReferenceState(input.cwd);
    const remoteBookmark = state.defaultRemoteBookmark;
    const trackingTarget =
      remoteBookmark?.tracking_target?.length === 1 ? remoteBookmark.tracking_target[0] : null;
    const workspaceBase = state.revision.parents[0] ?? null;
    if (!remoteBookmark || !state.defaultRemoteName || !trackingTarget || !workspaceBase) {
      return {
        trackedRemote: null,
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      };
    }
    const quotedTrackingTarget = quoteJjSymbol(trackingTarget);
    const quotedWorkspaceBase = quoteJjSymbol(workspaceBase);
    const [aheadCount, behindCount] = yield* Effect.all(
      [
        countRevisionRange(input.cwd, `${quotedTrackingTarget}..${quotedWorkspaceBase}`),
        countRevisionRange(input.cwd, `${quotedWorkspaceBase}..${quotedTrackingTarget}`),
      ],
      { concurrency: "unbounded" },
    );
    return {
      trackedRemote: {
        remoteName: state.defaultRemoteName,
        refName: remoteBookmark.name,
      },
      hasUpstream: true,
      aheadCount,
      behindCount,
      aheadOfDefaultCount: aheadCount,
      pr: null,
    };
  });

  const listRefs: NonNullable<VcsDriver.VcsDriver["Service"]["listRefs"]> = Effect.fn(
    "JjVcsDriver.listRefs",
  )(function* (input) {
    yield* snapshot(input.cwd, "JjVcsDriver.listRefs.snapshot");
    const [bookmarks, remotesResult] = yield* Effect.all(
      [readBookmarks(input.cwd), listRemotes(input.cwd)],
      { concurrency: "unbounded" },
    );
    const remoteNames = new Set(remotesResult.remotes.map((remote) => remote.name));
    const defaultRemoteName =
      remotesResult.remotes.find((remote) => remote.isPrimary)?.name ??
      remotesResult.remotes[0]?.name ??
      null;
    const usableBookmarks = bookmarks.filter(
      (bookmark) => bookmark.remote === undefined || remoteNames.has(bookmark.remote),
    );
    const defaultRemoteBookmark =
      usableBookmarks.find(
        (bookmark) => bookmark.remote === defaultRemoteName && bookmark.name === "main",
      ) ??
      usableBookmarks.find(
        (bookmark) => bookmark.remote === defaultRemoteName && bookmark.name === "master",
      ) ??
      usableBookmarks.find((bookmark) => bookmark.remote === defaultRemoteName) ??
      null;
    const localByName = new Map(
      usableBookmarks
        .filter((bookmark) => bookmark.remote === undefined)
        .map((bookmark) => [bookmark.name, bookmark]),
    );
    const bookmarkByRefName = new Map(
      usableBookmarks.map((bookmark) => [remoteBookmarkName(bookmark), bookmark]),
    );
    const refs: ReadonlyArray<VcsRef> = usableBookmarks.map((bookmark) => {
      const isRemote = bookmark.remote !== undefined;
      return {
        kind: "bookmark",
        name: remoteBookmarkName(bookmark),
        ...(isRemote ? { isRemote: true, remoteName: bookmark.remote } : { isRemote: false }),
        tracked: isRemote && bookmark.tracking_target !== undefined,
        conflicted: bookmark.target.length > 1,
        targetRevision: bookmark.target.length === 1 ? bookmark.target[0] : null,
        current: false,
        isDefault:
          defaultRemoteBookmark !== null &&
          bookmark.name === defaultRemoteBookmark.name &&
          bookmark.remote === defaultRemoteBookmark.remote,
        worktreePath: null,
      } satisfies VcsRef;
    });
    const localNames = new Set(
      refs.filter((ref) => !ref.isRemote).map((ref) => ref.name.toLocaleLowerCase()),
    );
    const dedupedRefs = input.includeMatchingRemoteRefs
      ? refs
      : refs.filter(
          (ref) =>
            !ref.isRemote || !localNames.has(ref.name.replace(/@[^@]+$/, "").toLocaleLowerCase()),
        );
    const refsForKind =
      input.refKind === "local"
        ? dedupedRefs.filter((ref) => !ref.isRemote)
        : input.refKind === "remote"
          ? dedupedRefs.filter((ref) => ref.isRemote)
          : dedupedRefs;
    const normalizedQuery = input.query?.toLocaleLowerCase() ?? "";
    const filteredRefs = refsForKind
      .filter((ref) => ref.name.toLocaleLowerCase().includes(normalizedQuery))
      .toSorted((left, right) => {
        const leftPriority = left.isDefault ? 0 : left.isRemote ? 2 : 1;
        const rightPriority = right.isDefault ? 0 : right.isRemote ? 2 : 1;
        return leftPriority - rightPriority || left.name.localeCompare(right.name);
      });
    const page = paginateRefs(filteredRefs, input);
    const pageRefs = yield* Effect.forEach(
      page.refs,
      (ref) =>
        Effect.gen(function* () {
          let aheadCount = 0;
          let behindCount = 0;
          if (ref.isRemote) {
            const bookmark = bookmarkByRefName.get(ref.name);
            const local = bookmark ? localByName.get(bookmark.name) : undefined;
            const remoteTarget = ref.targetRevision;
            if (local?.target.length === 1 && remoteTarget) {
              const quotedLocalTarget = quoteJjSymbol(local.target[0] as string);
              const quotedRemoteTarget = quoteJjSymbol(remoteTarget);
              [aheadCount, behindCount] = yield* Effect.all(
                [
                  countRevisionRange(input.cwd, `${quotedRemoteTarget}..${quotedLocalTarget}`),
                  countRevisionRange(input.cwd, `${quotedLocalTarget}..${quotedRemoteTarget}`),
                ],
                { concurrency: "unbounded" },
              );
            }
          }
          return { ...ref, aheadCount, behindCount };
        }),
      { concurrency: 4 },
    );
    return {
      refs: pageRefs,
      isRepo: true,
      hasPrimaryRemote: defaultRemoteName !== null,
      nextCursor: page.nextCursor,
      totalCount: page.totalCount,
    };
  });

  const getDiffPreview: NonNullable<VcsDriver.VcsDriver["Service"]["getDiffPreview"]> = Effect.fn(
    "JjVcsDriver.getDiffPreview",
  )(function* (input) {
    yield* snapshot(input.cwd, "JjVcsDriver.getDiffPreview.snapshot");
    const revision = yield* readRevision(input.cwd);
    const baseRef = input.baseRef ?? revision.parents[0] ?? null;
    const workingResult = yield* readPatch({
      cwd: input.cwd,
      operation: "JjVcsDriver.getDiffPreview.workingCopy",
      args: [...(input.ignoreWhitespace ? ["--ignore-all-space"] : []), "--revision", "@"],
    });
    const baseResult = baseRef
      ? yield* readPatch({
          cwd: input.cwd,
          operation: "JjVcsDriver.getDiffPreview.base",
          args: [
            ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
            "--from",
            quoteJjSymbol(baseRef),
            "--to",
            "@",
          ],
        })
      : null;
    const workingDiff = workingResult.stdout;
    const baseDiff = baseResult?.stdout ?? "";
    const [workingDiffHash, baseDiffHash] = yield* Effect.all([
      hashDiff(input.cwd, workingDiff),
      hashDiff(input.cwd, baseDiff),
    ]);
    return {
      cwd: input.cwd,
      generatedAt: yield* DateTime.now,
      sources: [
        {
          id: `jj-working-copy:${revision.changeId}`,
          kind: "working-tree" as const,
          title: "Working-copy change",
          baseRef: revision.parents[0] ?? null,
          headRef: revision.changeId,
          diff: workingDiff,
          diffHash: workingDiffHash,
          truncated: workingResult.stdoutTruncated,
        },
        {
          id: `jj-range:${baseRef ?? "root"}:${revision.changeId}`,
          kind: "branch-range" as const,
          title: baseRef ? `Against ${baseRef}` : "Root change",
          baseRef,
          headRef: revision.changeId,
          diff: baseDiff,
          diffHash: baseDiffHash,
          truncated: baseResult?.stdoutTruncated ?? false,
        },
      ],
    };
  });

  const initRepository: VcsDriver.VcsDriver["Service"]["initRepository"] = Effect.fn(
    "JjVcsDriver.initRepository",
  )(function* (input) {
    yield* jj.ensureSupportedVersion(input.cwd);
    yield* jj.run({
      operation: "JjVcsDriver.initRepository",
      cwd: input.cwd,
      args: ["git", "init", "--colocate", input.cwd],
      timeoutMs: 20_000,
      maxOutputBytes: 256 * 1024,
    });
  });

  const cloneRepository: VcsDriver.VcsDriver["Service"]["cloneRepository"] = Effect.fn(
    "JjVcsDriver.cloneRepository",
  )(function* (input) {
    yield* jj.ensureSupportedVersion(path.dirname(input.destination));
    yield* jj.run({
      operation: "JjVcsDriver.cloneRepository",
      cwd: input.destination,
      args: ["git", "clone", "--colocate", input.source, input.destination],
      timeoutMs: 120_000,
      maxOutputBytes: 1_000_000,
    });
  });

  return VcsDriver.VcsDriver.of({
    capabilities,
    execute,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    addRemote,
    removeRemote,
    resolveDefaultRemote,
    filterIgnoredPaths,
    initRepository,
    cloneRepository,
    getLocalStatus,
    getRemoteStatus,
    listRefs,
    getDiffPreview,
  });
});

export const layer = Layer.effect(VcsDriver.VcsDriver, make).pipe(Layer.provide(JjProcess.layer));
