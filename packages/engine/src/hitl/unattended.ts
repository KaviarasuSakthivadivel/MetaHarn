/**
 * Unattended mode — a per-session toggle for *where the human is reached*.
 *
 * It does NOT change the autonomy ceiling (the permission mode does that). When a session is
 * unattended, anything that would prompt inline (approval / question) is routed to the Inbox
 * (see inbox.ts) and the agent suspends until answered elsewhere. This registry just persists
 * the per-session flag — a direct port of OpenWorker's coworker/unattended.py.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class UnattendedRegistry {
  private readonly path?: string;
  private flags: Record<string, boolean> = {};

  constructor(path?: string) {
    this.path = path;
    if (this.path && existsSync(this.path)) {
      this.flags = JSON.parse(readFileSync(this.path, "utf-8")) as Record<string, boolean>;
    }
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.flags, null, 2), "utf-8");
  }

  isUnattended(sessionId: string): boolean {
    return Boolean(this.flags[sessionId]);
  }

  set(sessionId: string, unattended: boolean): void {
    if (unattended) {
      this.flags[sessionId] = true;
    } else {
      delete this.flags[sessionId];
    }
    this.save();
  }

  /** Session ids currently flagged unattended. */
  sessions(): string[] {
    return Object.keys(this.flags).filter((sid) => this.flags[sid]);
  }
}
