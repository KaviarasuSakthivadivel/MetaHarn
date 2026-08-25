/**
 * Commit-graph lane assignment — the same algorithm every real git-graph
 * tool uses (GitLens, GitKraken, `git log --graph` itself): walk commits
 * newest-first, track which lane each is "waiting" to reach next (its
 * first parent continues straight down its lane; additional parents open
 * or rejoin other lanes). Pure data transform, no React — reused by both
 * GitPanel.tsx's Log tab and BranchExplorer.tsx so the two views can never
 * drift into two different (and possibly wrong) graph algorithms.
 *
 * Must be recomputed over the FULL accumulated commit list every time
 * "Load more" appends a page — lanes are stateful across the whole loaded
 * set, not per-page. Cheap at the scale this ever runs at (a few hundred
 * loaded commits before a user pages further, not thousands re-laid-out
 * per render).
 */

export interface GraphCommitInput {
  hash: string;
  parents: string[];
}

export type GraphConnectionKind = "diverge" | "converge";

export interface GraphConnection {
  /** The commit row this connection is drawn at. */
  fromHash: string;
  fromLane: number;
  toLane: number;
  kind: GraphConnectionKind;
}

export interface GraphNode {
  lane: number;
}

export interface GraphLayout {
  nodes: Map<string, GraphNode>;
  connections: GraphConnection[];
  laneCount: number;
}

/**
 * `commits` must be newest-first (children before their parents) — exactly
 * what `getGitLog` already returns. Commits whose parents fall outside the
 * loaded page (the common case: the oldest loaded commit's parent hasn't
 * been fetched yet) simply never get "found" by a later iteration — their
 * lane just continues open, which is correct: the line should visually run
 * off the bottom of the loaded list, not snap closed.
 */
export function assignGraphLanes(commits: GraphCommitInput[]): GraphLayout {
  const activeLanes: (string | null)[] = [];
  const nodes = new Map<string, GraphNode>();
  const connections: GraphConnection[] = [];

  const findFreeLane = (): number => {
    const idx = activeLanes.indexOf(null);
    if (idx !== -1) return idx;
    activeLanes.push(null);
    return activeLanes.length - 1;
  };

  for (const commit of commits) {
    const waitingLanes: number[] = [];
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] === commit.hash) waitingLanes.push(i);
    }

    let myLane: number;
    if (waitingLanes.length > 0) {
      myLane = waitingLanes[0];
      for (const extraLane of waitingLanes.slice(1)) {
        connections.push({ fromHash: commit.hash, fromLane: extraLane, toLane: myLane, kind: "converge" });
        activeLanes[extraLane] = null;
      }
    } else {
      myLane = findFreeLane();
    }

    nodes.set(commit.hash, { lane: myLane });
    activeLanes[myLane] = null;

    commit.parents.forEach((parentHash, i) => {
      if (i === 0) {
        activeLanes[myLane] = parentHash;
        return;
      }
      const existing = activeLanes.indexOf(parentHash);
      if (existing !== -1) {
        connections.push({ fromHash: commit.hash, fromLane: myLane, toLane: existing, kind: "diverge" });
      } else {
        const newLane = findFreeLane();
        activeLanes[newLane] = parentHash;
        connections.push({ fromHash: commit.hash, fromLane: myLane, toLane: newLane, kind: "diverge" });
      }
    });
  }

  return { nodes, connections, laneCount: activeLanes.length };
}
