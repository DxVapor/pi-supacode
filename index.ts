/**
 * pi-supacode — Pi extension for Supacode integration
 *
 * Reports agent lifecycle hooks back to Supacode via the Unix domain socket
 * it injects into every managed terminal session, matching the semantics of
 * the existing Claude and Codex hook integrations.
 *
 * Required env vars (injected automatically by Supacode):
 *   SUPACODE_SOCKET_PATH  — path to the Unix domain socket
 *   SUPACODE_WORKTREE_ID  — worktree identifier
 *   SUPACODE_TAB_ID       — tab UUID
 *   SUPACODE_SURFACE_ID   — terminal surface UUID
 *
 * Hook event mapping:
 *   Pi agent_start      → busy = 1       (UserPromptSubmit equivalent)
 *   Pi agent_end        → busy = 0       (Stop equivalent)
 *                       → notification with last_assistant_message
 *   Pi session_shutdown → busy = 0       (SessionEnd equivalent)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createConnection } from "node:net";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SupacodeEnv {
  socketPath: string;
  worktreeId: string;
  tabId: string;
  surfaceId: string;
}

interface HookPayload {
  hook_event_name: string;
  title?: string;
  message?: string;
  last_assistant_message?: string;
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function readSupacodeEnv(): SupacodeEnv | null {
  const socketPath = process.env["SUPACODE_SOCKET_PATH"];
  const worktreeId = process.env["SUPACODE_WORKTREE_ID"];
  const tabId = process.env["SUPACODE_TAB_ID"];
  const surfaceId = process.env["SUPACODE_SURFACE_ID"];

  if (!socketPath || !worktreeId || !tabId || !surfaceId) return null;
  return { socketPath, worktreeId, tabId, surfaceId };
}

// ---------------------------------------------------------------------------
// Socket transport
// ---------------------------------------------------------------------------

/**
 * Sends raw bytes to a Unix domain socket and closes the connection.
 * Times out after 1 s and swallows all errors — hook delivery is best-effort.
 */
function sendToSocket(socketPath: string, data: Buffer): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const timer = setTimeout(() => {
      client.destroy();
      done();
    }, 1000);

    const client = createConnection({ path: socketPath });

    client.on("connect", () => {
      client.write(data, () => {
        client.end();
        clearTimeout(timer);
        done();
      });
    });

    client.on("close", done);
    client.on("error", () => {
      clearTimeout(timer);
      done();
    });
  });
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

/**
 * Busy flag: `<worktreeID> <tabID> <surfaceID> 1|0\n`
 *
 * Matches the format produced by AgentHookSettingsCommand.busyCommand().
 */
function sendBusy(env: SupacodeEnv, active: boolean): Promise<void> {
  const flag = active ? "1" : "0";
  const message = `${env.worktreeId} ${env.tabId} ${env.surfaceId} ${flag}\n`;
  return sendToSocket(env.socketPath, Buffer.from(message, "utf8"));
}

/**
 * Notification: `<worktreeID> <tabID> <surfaceID> pi\n<JSON payload>\n`
 *
 * Matches the format produced by AgentHookSettingsCommand.notificationCommand("pi").
 * The JSON body is decoded on the Supacode side via AgentHookPayload.
 */
function sendNotification(env: SupacodeEnv, payload: HookPayload): Promise<void> {
  const header = `${env.worktreeId} ${env.tabId} ${env.surfaceId} pi\n`;
  const body = JSON.stringify(payload) + "\n";
  return sendToSocket(env.socketPath, Buffer.from(header + body, "utf8"));
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

/**
 * Walks session entries backwards to find the most recent assistant text.
 * Uses the same pattern as the auto-commit-on-exit built-in example.
 */
function lastAssistantText(ctx: { sessionManager: { getEntries(): any[] } }): string | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    if (entry.message.role !== "assistant") continue;

    const content = entry.message.content;
    if (!Array.isArray(content)) continue;

    const text = content
      .filter((c: { type: string; text?: string }) => c.type === "text" && typeof c.text === "string")
      .map((c: { text: string }) => c.text)
      .join("")
      .trim();

    if (text.length > 0) return text;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const env = readSupacodeEnv();

  // ---------------------------------------------------------------------------
  // /supacode  — diagnostic command (always registered, works with or without env)
  // ---------------------------------------------------------------------------
  pi.registerCommand("supacode", {
    description: "Show Supacode hook status and test socket connectivity",
    handler: async (_args, ctx) => {
      const socketPath = process.env["SUPACODE_SOCKET_PATH"];
      const worktreeId = process.env["SUPACODE_WORKTREE_ID"];
      const tabId = process.env["SUPACODE_TAB_ID"];
      const surfaceId = process.env["SUPACODE_SURFACE_ID"];

      const present = (v: string | undefined) => (v ? `✓  ${v}` : "✗  (not set)");

      const lines = [
        "── Supacode env ──────────────────────────────────",
        `SUPACODE_SOCKET_PATH  ${present(socketPath)}`,
        `SUPACODE_WORKTREE_ID  ${present(worktreeId)}`,
        `SUPACODE_TAB_ID       ${present(tabId)}`,
        `SUPACODE_SURFACE_ID   ${present(surfaceId)}`,
      ];

      if (!socketPath || !worktreeId || !tabId || !surfaceId) {
        lines.push("", "Extension is DISABLED — not running under Supacode.");
        ctx.ui.notify(lines.join("\n"), "warning");
        return;
      }

      lines.push("", "── Socket test ───────────────────────────────────");

      // Fire a real busy=1 then busy=0 ping so the Supacode UI flickers.
      try {
        await sendBusy({ socketPath, worktreeId, tabId, surfaceId }, true);
        await new Promise<void>((r) => setTimeout(r, 400));
        await sendBusy({ socketPath, worktreeId, tabId, surfaceId }, false);
        lines.push("Socket send: ✓  (busy pulse sent — watch the tab indicator)");
      } catch (err: any) {
        lines.push(`Socket send: ✗  ${err?.message ?? err}`);
      }

      // Send a test notification.
      try {
        await sendNotification(
          { socketPath, worktreeId, tabId, surfaceId },
          {
            hook_event_name: "Stop",
            last_assistant_message: "pi-supacode diagnostic ping",
          },
        );
        lines.push("Notification:  ✓  (check notification bell in Supacode)");
      } catch (err: any) {
        lines.push(`Notification:  ✗  ${err?.message ?? err}`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // Not running under Supacode — skip lifecycle hooks.
  if (!env) return;

  // ------------------------------------------------------------------
  // agent_start → busy = 1  (mirrors UserPromptSubmit in Claude/Codex)
  // ------------------------------------------------------------------
  pi.on("agent_start", async (_event, _ctx) => {
    await sendBusy(env, true);
  });

  // ------------------------------------------------------------------
  // agent_end → busy = 0 + Stop notification  (mirrors Stop event)
  // ------------------------------------------------------------------
  pi.on("agent_end", async (_event, ctx) => {
    await sendBusy(env, false);

    const lastMessage = lastAssistantText(ctx);
    await sendNotification(env, {
      hook_event_name: "Stop",
      last_assistant_message: lastMessage,
    });
  });

  // ------------------------------------------------------------------
  // session_shutdown → busy = 0  (mirrors SessionEnd in Claude)
  // ------------------------------------------------------------------
  pi.on("session_shutdown", async (_event, _ctx) => {
    await sendBusy(env, false);
  });
}
