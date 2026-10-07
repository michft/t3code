import type { VcsDriverKind } from "@t3tools/contracts";

export interface VcsPresentation {
  readonly systemLabel: string;
  readonly refSingular: string;
  readonly refPlural: string;
  readonly workspaceSingular: string;
  readonly workspacePlural: string;
  readonly currentRefFallback: string;
}

const PRESENTATION_BY_KIND = {
  git: {
    systemLabel: "Git",
    refSingular: "branch",
    refPlural: "branches",
    workspaceSingular: "worktree",
    workspacePlural: "worktrees",
    currentRefFallback: "Detached HEAD",
  },
  jj: {
    systemLabel: "Jujutsu",
    refSingular: "bookmark",
    refPlural: "bookmarks",
    workspaceSingular: "workspace",
    workspacePlural: "workspaces",
    currentRefFallback: "Unbookmarked change",
  },
  unknown: {
    systemLabel: "Version control",
    refSingular: "named ref",
    refPlural: "named refs",
    workspaceSingular: "workspace",
    workspacePlural: "workspaces",
    currentRefFallback: "Unnamed revision",
  },
} satisfies Record<VcsDriverKind, VcsPresentation>;

export function getVcsPresentation(kind: VcsDriverKind | null | undefined): VcsPresentation {
  return PRESENTATION_BY_KIND[kind ?? "unknown"];
}

export function capitalizeVcsTerm(term: string): string {
  return term.length === 0 ? term : `${term[0]?.toUpperCase()}${term.slice(1)}`;
}
