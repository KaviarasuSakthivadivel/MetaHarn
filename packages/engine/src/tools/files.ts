/**
 * Base file tools — read_file, write_file, replace_in_file, list_files.
 *
 * Not part of the OpenWorker feature catalog (docs/research/openworker-feature-catalog.md):
 * OpenWorker gets these for free from aisuite's own file toolkit, external to the parts this
 * package ported. Every safety module already built here — `permissions/engine.ts`'s
 * `DEFAULT_WRITE_PATH_ARGS`, `permissions/risk.ts`'s `WRITE_TOOL_NAMES` — was written assuming
 * tools named exactly `write_file` and `replace_in_file`, each taking a top-level `path`
 * argument, so those names are load-bearing, not a style choice.
 */
import { readFile, readdir, stat, writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { ToolDefinition } from "../types.js";

const MAX_READ_CHARS = 200_000;
const MAX_LIST_ENTRIES = 500;

function resolveInWorkspace(workspace: string, path: string): string {
  return isAbsolute(path) ? path : join(workspace, path);
}

export function createReadFileTool(workspace: string): ToolDefinition {
  return {
    name: "read_file",
    schema: {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read a text file. Optionally a line range via offset (1-based, default 1) and limit " +
          "(default: whole file, capped at 200,000 characters). Returns lines prefixed with their " +
          "line number, matching the convention most coding agents already use.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path, absolute or relative to the workspace." },
            offset: { type: "integer", description: "1-based line number to start from." },
            limit: { type: "integer", description: "Maximum number of lines to return." },
          },
          required: ["path"],
        },
      },
    },
    metadata: { category: "filesystem", riskLevel: "low", risk: "read", requiresApproval: false },
    execute: async (args) => {
      const target = resolveInWorkspace(workspace, String(args.path ?? ""));
      let text: string;
      try {
        text = await readFile(target, "utf8");
      } catch (err) {
        return { error: `could not read ${target}: ${(err as Error).message}` };
      }
      const lines = text.split("\n");
      const offset = typeof args.offset === "number" && args.offset > 0 ? args.offset : 1;
      const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : lines.length;
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((line, i) => `${offset + i}\t${line}`).join("\n");
      return numbered.length > MAX_READ_CHARS
        ? { truncated: true, text: numbered.slice(0, MAX_READ_CHARS) }
        : { truncated: false, text: numbered };
    },
  };
}

export function createWriteFileTool(workspace: string): ToolDefinition {
  return {
    name: "write_file",
    schema: {
      type: "function",
      function: {
        name: "write_file",
        description:
          "Create a file, or overwrite one completely, with the given content. For an existing " +
          "file where only part needs to change, prefer replace_in_file instead of rewriting the " +
          "whole thing.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path, absolute or relative to the workspace." },
            content: { type: "string", description: "The full file content." },
          },
          required: ["path", "content"],
        },
      },
    },
    // risk left undeclared here (falls through to permissions/risk.ts's by-name floor for
    // "write_file") — the floor exists specifically so this doesn't have to get it right.
    metadata: { category: "filesystem", riskLevel: "high", requiresApproval: true },
    execute: async (args) => {
      const target = resolveInWorkspace(workspace, String(args.path ?? ""));
      try {
        await mkdir(dirname(target), { recursive: true });
        await fsWriteFile(target, String(args.content ?? ""), "utf8");
      } catch (err) {
        return { error: `could not write ${target}: ${(err as Error).message}` };
      }
      return { ok: true, path: relative(workspace, target) || target };
    },
  };
}

export function createReplaceInFileTool(workspace: string): ToolDefinition {
  return {
    name: "replace_in_file",
    schema: {
      type: "function",
      function: {
        name: "replace_in_file",
        description:
          "Replace one exact occurrence of old_string with new_string in an existing file. " +
          "old_string must match exactly once in the file — include enough surrounding context " +
          "to make it unique. Fails rather than guessing if it matches zero or multiple times.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path, absolute or relative to the workspace." },
            old_string: { type: "string", description: "The exact text to replace." },
            new_string: { type: "string", description: "The text to replace it with." },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    },
    metadata: { category: "filesystem", riskLevel: "high", requiresApproval: true },
    execute: async (args) => {
      const target = resolveInWorkspace(workspace, String(args.path ?? ""));
      const oldString = String(args.old_string ?? "");
      let text: string;
      try {
        text = await readFile(target, "utf8");
      } catch (err) {
        return { error: `could not read ${target}: ${(err as Error).message}` };
      }
      const occurrences = oldString ? text.split(oldString).length - 1 : 0;
      if (occurrences === 0) return { error: "old_string not found in file" };
      if (occurrences > 1) return { error: `old_string matches ${occurrences} times — make it unique` };
      const updated = text.replace(oldString, String(args.new_string ?? ""));
      try {
        await fsWriteFile(target, updated, "utf8");
      } catch (err) {
        return { error: `could not write ${target}: ${(err as Error).message}` };
      }
      return { ok: true, path: relative(workspace, target) || target };
    },
  };
}

export function createListFilesTool(workspace: string): ToolDefinition {
  return {
    name: "list_files",
    schema: {
      type: "function",
      function: {
        name: "list_files",
        description: "List the entries of a directory (non-recursive). Defaults to the workspace root.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path, absolute or relative to the workspace." },
          },
        },
      },
    },
    metadata: { category: "filesystem", riskLevel: "low", risk: "read", requiresApproval: false },
    execute: async (args) => {
      const target = resolveInWorkspace(workspace, String(args.path ?? "."));
      let entries;
      try {
        entries = await readdir(target, { withFileTypes: true });
      } catch (err) {
        return { error: `could not list ${target}: ${(err as Error).message}` };
      }
      const rows = await Promise.all(
        entries.slice(0, MAX_LIST_ENTRIES).map(async (entry) => {
          const isDir = entry.isDirectory();
          let size: number | null = null;
          if (!isDir) {
            try {
              size = (await stat(join(target, entry.name))).size;
            } catch {
              size = null;
            }
          }
          return { name: entry.name, isDirectory: isDir, size };
        }),
      );
      return { entries: rows, truncated: entries.length > MAX_LIST_ENTRIES };
    },
  };
}

export function createFileTools(workspace: string): ToolDefinition[] {
  return [
    createReadFileTool(workspace),
    createWriteFileTool(workspace),
    createReplaceInFileTool(workspace),
    createListFilesTool(workspace),
  ];
}
