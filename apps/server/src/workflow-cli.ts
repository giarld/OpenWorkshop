import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";

type Method = "GET" | "POST" | "PUT" | "DELETE";
type Command = { method: Method; path: (args: string[]) => string; args: number; body?: boolean; file?: boolean; text?: boolean };

const id = (resource: string, suffix = "") => (args: string[]) => `/api/${resource}/${encodeURIComponent(args[0]!)}${suffix}`;
const nested = (resource: string, suffix: string) => (args: string[]) => `/api/${resource}/${encodeURIComponent(args[0]!)}/${suffix.replace(":id", encodeURIComponent(args[1]!))}`;
const taskNumber = (args: string[]) => `/api/projects/${encodeURIComponent(args[0]!)}/tasks/by-number/${encodeURIComponent(args[1]!)}`;

export const WORKFLOW_COMMANDS: Record<string, Command> = {
  "root list": { method: "GET", path: () => "/api/roots", args: 0 },
  "root create": { method: "POST", path: () => "/api/roots", args: 0, body: true },
  "root update": { method: "PUT", path: id("roots"), args: 1, body: true },
  "root browse": { method: "GET", path: id("roots", "/browse"), args: 1 },
  "project list": { method: "GET", path: () => "/api/projects", args: 0 },
  "project create": { method: "POST", path: () => "/api/projects", args: 0, body: true },
  "project get": { method: "GET", path: id("projects"), args: 1 },
  "project update": { method: "PUT", path: id("projects"), args: 1, body: true },
  "project scan": { method: "POST", path: id("projects", "/scan"), args: 1 },
  "project archive": { method: "POST", path: id("projects", "/archive"), args: 1 },
  "commission list": { method: "GET", path: id("projects", "/commissions"), args: 1 },
  "commission create": { method: "POST", path: id("projects", "/commissions"), args: 1, body: true },
  "commission get": { method: "GET", path: id("commissions"), args: 1 },
  "commission delete": { method: "DELETE", path: id("commissions"), args: 1 },
  "commission archive": { method: "POST", path: id("commissions", "/archive"), args: 1 },
  "commission reactivate": { method: "POST", path: id("commissions", "/reactivate"), args: 1 },
  "commission message": { method: "POST", path: id("commissions", "/messages"), args: 1, body: true },
  "commission analyze": { method: "POST", path: id("commissions", "/analyze"), args: 1 },
  "commission requirements": { method: "GET", path: id("commissions", "/requirements"), args: 1 },
  "commission replan": { method: "POST", path: id("commissions", "/replan"), args: 1 },
  "commission attachment": { method: "POST", path: id("commissions", "/attachments"), args: 1, file: true },
  "requirement create-approved": { method: "POST", path: id("commissions", "/requirements/approved"), args: 1, body: true },
  "requirement approve": { method: "POST", path: id("requirements", "/approve"), args: 1 },
  "requirement reject": { method: "POST", path: id("requirements", "/reject"), args: 1, body: true },
  "task list": { method: "GET", path: id("projects", "/tasks"), args: 1 },
  "task create": { method: "POST", path: id("commissions", "/tasks"), args: 1, body: true },
  "task get": { method: "GET", path: id("tasks"), args: 1 },
  "task get-number": { method: "GET", path: taskNumber, args: 2 },
  "task update": { method: "PUT", path: id("tasks"), args: 1, body: true },
  "task delete": { method: "DELETE", path: id("tasks"), args: 1, body: true },
  "task move": { method: "POST", path: id("tasks", "/move"), args: 1, body: true },
  "task reorder": { method: "POST", path: id("tasks", "/reorder"), args: 1, body: true },
  "task archive": { method: "POST", path: id("tasks", "/archive"), args: 1 },
  "task unarchive": { method: "POST", path: id("tasks", "/unarchive"), args: 1 },
  "task dependency-add": { method: "POST", path: id("tasks", "/dependencies"), args: 1, body: true },
  "task dependency-remove": { method: "DELETE", path: nested("tasks", "dependencies/:id"), args: 2 },
  "task comments": { method: "GET", path: id("tasks", "/comments"), args: 1 },
  "task comment-add": { method: "POST", path: id("tasks", "/comments"), args: 1, body: true },
  "task comment-delete": { method: "DELETE", path: nested("tasks", "comments/:id"), args: 2 },
  "task waive": { method: "POST", path: id("tasks", "/waive"), args: 1, body: true },
  "task acceptance": { method: "GET", path: id("tasks", "/acceptance"), args: 1 },
  "task accept": { method: "POST", path: id("tasks", "/accept"), args: 1 },
  "task reject": { method: "POST", path: id("tasks", "/reject"), args: 1, body: true },
  "task trigger": { method: "POST", path: id("tasks", "/trigger"), args: 1 },
  "task pause": { method: "POST", path: id("tasks", "/pause"), args: 1 },
  "task cancel": { method: "POST", path: id("tasks", "/cancel"), args: 1 },
  "task resume": { method: "POST", path: id("tasks", "/resume"), args: 1 },
  "task runs": { method: "GET", path: id("tasks", "/runs"), args: 1 },
  "run get": { method: "GET", path: id("runs"), args: 1 },
  "run events": { method: "GET", path: id("runs", "/events"), args: 1 },
  "run steer": { method: "POST", path: id("runs", "/steer"), args: 1, body: true },
  "run interrupt": { method: "POST", path: id("runs", "/interrupt"), args: 1 },
  "run input": { method: "POST", path: id("runs", "/input"), args: 1, body: true },
  "approval list": { method: "GET", path: () => "/api/approvals", args: 0 },
  "approval decide": { method: "POST", path: id("approvals", "/decide"), args: 1, body: true },
  "document list": { method: "GET", path: id("projects", "/documents"), args: 1 },
  "document get": { method: "GET", path: id("documents"), args: 1 },
  "document update": { method: "PUT", path: id("documents"), args: 1, body: true },
  "document lock": { method: "POST", path: id("documents", "/lock"), args: 1 },
  "document export": { method: "GET", path: id("documents", "/export.md"), args: 1, text: true },
  "document query": { method: "POST", path: id("projects", "/documents/query"), args: 1, body: true },
  "notification list": { method: "GET", path: () => "/api/notifications", args: 0 },
  "notification read": { method: "POST", path: id("notifications", "/read"), args: 1 },
  "notification clear": { method: "DELETE", path: () => "/api/notifications/history", args: 0 },
  "runtime status": { method: "GET", path: () => "/api/runtime/run-status", args: 0 },
  "runtime codex-health": { method: "GET", path: () => "/api/runtime/codex-health", args: 0 }
};

export type WorkflowRequest = { method: Method; path: string; query: Record<string, unknown>; body?: string | Uint8Array; contentType?: string; headers?: Record<string, string>; text?: boolean; output: string; serverUrl?: string };

export async function parseWorkflowCommand(argv: string[]): Promise<WorkflowRequest> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      data: { type: "string" },
      "data-file": { type: "string" },
      query: { type: "string" },
      "query-file": { type: "string" },
      file: { type: "string" },
      "content-type": { type: "string" },
      "server-url": { type: "string" },
      output: { type: "string", default: "pretty" }
    }
  });
  if (values.data && values["data-file"]) throw new Error("Use only one of --data or --data-file");
  if (values.query && values["query-file"]) throw new Error("Use only one of --query or --query-file");
  const generic = positionals[0] === "api";
  const key = generic ? "api" : `${positionals[0] ?? ""} ${positionals[1] ?? ""}`;
  const command = generic ? genericCommand(positionals) : WORKFLOW_COMMANDS[key];
  if (!command) throw new Error(`Unsupported workflow command: ${key.trim()}`);
  const args = positionals.slice(generic ? 3 : 2);
  if (args.length !== command.args) throw new Error(`Usage error: ${key} expects ${command.args} positional argument(s)`);
  const body = values.file ? new Uint8Array(await readFile(values.file)) : values["data-file"] ? await readJsonFile(values["data-file"]) : values.data;
  if (command.body && body === undefined) throw new Error(`${key} requires --data or --data-file`);
  if (command.file && !values.file) throw new Error(`${key} requires --file`);
  if (typeof body === "string") JSON.parse(body);
  const queryJson = values["query-file"] ? await readJsonFile(values["query-file"]) : values.query;
  const query = queryJson ? JSON.parse(queryJson) as Record<string, unknown> : {};
  if (!query || Array.isArray(query) || typeof query !== "object") throw new Error("--query must be a JSON object");
  if (!['pretty', 'json'].includes(values.output!)) throw new Error("--output must be pretty or json");
  return { method: command.method, path: command.path(args), query, ...(body === undefined ? {} : { body }), ...(body === undefined ? {} : { contentType: values["content-type"] ?? (values.file ? "application/octet-stream" : "application/json") }), ...(values.file ? { headers: { "X-File-Name": encodeURIComponent(basename(values.file)) } } : {}), ...(command.text ? { text: true } : {}), output: values.output!, ...(values["server-url"] ? { serverUrl: values["server-url"] } : {}) };
}

async function readJsonFile(path: string): Promise<string> {
  return (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
}

function genericCommand(positionals: string[]): Command {
  const method = positionals[1]?.toUpperCase();
  const path = positionals[2];
  if (!path?.startsWith("/api/")) throw new Error("api path must start with /api/");
  if (!(["GET", "POST", "PUT", "DELETE"] as string[]).includes(method ?? "")) throw new Error("api method must be GET, POST, PUT, or DELETE");
  return { method: method as Method, path: () => path, args: 0 };
}

export function workflowHelp(): string {
  const families = [...new Set(Object.keys(WORKFLOW_COMMANDS).map((key) => key.split(" ")[0]))];
  return `Workflow commands:\n  ${families.join(", ")}\n\nUsage:\n  workshop <family> <action> [id ...] [--query '{...}' | --query-file path] [--data '{...}' | --data-file path] [--output json]\n  workshop commission attachment <id> --file path [--content-type type]\n  workshop api <GET|POST|PUT|DELETE> /api/path [--query '{...}' | --query-file path] [--data '{...}' | --data-file path]\n\nRun "workshop <family> help" to list actions.`;
}

export function familyHelp(family: string): string {
  const actions = Object.entries(WORKFLOW_COMMANDS).filter(([key]) => key.startsWith(`${family} `)).map(([key, command]) => `${key.slice(family.length + 1)}${" <id>".repeat(command.args)}${command.body ? " --data '{...}'" : ""}${command.file ? " --file <path>" : ""}`);
  if (!actions.length) throw new Error(`Unknown command family: ${family}`);
  return `${family} actions: ${actions.join(", ")}`;
}
