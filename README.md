# pi-supacode

A [Pi](https://github.com/mariozechner/pi-coding-agent) extension that integrates with [Supacode](https://github.com/supabitapp/supacode), reporting agent lifecycle status back to the Supacode macOS app via its Unix domain socket — the same mechanism used by the built-in Claude and Codex integrations.

## What it does

When Pi runs inside a Supacode-managed terminal, this extension:

- **Shows a busy indicator** on the tab while Pi is working
- **Fires a notification** (bell + macOS system notification) when Pi finishes a turn, including the last assistant message as the notification body
- **Clears the busy state** on shutdown / session end

All of this happens automatically. If the Supacode environment variables are absent (i.e. Pi is running outside Supacode), the extension is a no-op.

### Hook event mapping

| Pi event | Supacode message | Claude / Codex equivalent |
|---|---|---|
| `agent_start` | `busy = 1` | `UserPromptSubmit` |
| `agent_end` | `busy = 0` + `Stop` notification | `Stop` |
| `session_shutdown` | `busy = 0` | `SessionEnd` |

## Prerequisites

- **[Pi](https://github.com/mariozechner/pi-coding-agent)** — the coding agent this extension runs inside
- **[Supacode](https://github.com/supabitapp/supacode)** — the macOS app that manages your agent sessions
- **Node.js ≥ 18** — already required by Pi; no extra install needed
- No npm dependencies — uses only `node:net` from the Node.js standard library

## Installation

Pi auto-discovers extensions from `~/.pi/agent/extensions/*/index.ts`. The simplest install is a symlink (so you get updates via `git pull`):

```bash
# Clone
git clone https://github.com/DxVapor/pi-supacode.git ~/path/to/pi-supacode

# Symlink into Pi's global extension directory
ln -s ~/path/to/pi-supacode ~/.pi/agent/extensions/pi-supacode
```

Or copy directly:

```bash
cp -r ~/path/to/pi-supacode ~/.pi/agent/extensions/pi-supacode
```

Restart Pi (or run `/reload` inside an active session) to pick up the extension.

### Alternative: project-local

To enable only for a specific repo, symlink into its `.pi/extensions/` directory:

```bash
ln -s ~/path/to/pi-supacode /your/repo/.pi/extensions/pi-supacode
```

### Alternative: `settings.json`

Add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/absolute/path/to/pi-supacode"]
}
```

## Usage

Open Pi inside a Supacode-managed terminal. The extension activates automatically — no configuration required.

### Verify it's working: `/supacode`

The extension registers a `/supacode` diagnostic command you can run at any time:

```
/supacode
```

This will:
1. Print the status of all four required environment variables
2. Send a real **busy pulse** to the socket (watch the tab indicator flicker in Supacode)
3. Send a **test notification** (check the notification bell on the worktree)

Example output when everything is wired up:

```
── Supacode env ──────────────────────────────────
SUPACODE_SOCKET_PATH  ✓  /tmp/supacode-501/pid-12345
SUPACODE_WORKTREE_ID  ✓  my-repo%2Ffeature-branch
SUPACODE_TAB_ID       ✓  550e8400-e29b-41d4-a716-446655440000
SUPACODE_SURFACE_ID   ✓  6ba7b810-9dad-11d1-80b4-00c04fd430c8

── Socket test ───────────────────────────────────
Socket send:   ✓  (busy pulse sent — watch the tab indicator)
Notification:  ✓  (check notification bell in Supacode)
```

### Manual socket test (no Pi required)

From any Supacode terminal you can simulate the hook messages directly:

```bash
# Busy = 1
echo "$SUPACODE_WORKTREE_ID $SUPACODE_TAB_ID $SUPACODE_SURFACE_ID 1" \
  | /usr/bin/nc -U -w1 "$SUPACODE_SOCKET_PATH"

# Busy = 0 + Stop notification
{ printf '%s pi\n' "$SUPACODE_WORKTREE_ID $SUPACODE_TAB_ID $SUPACODE_SURFACE_ID"
  echo '{"hook_event_name":"Stop","last_assistant_message":"manual test"}'; } \
  | /usr/bin/nc -U -w1 "$SUPACODE_SOCKET_PATH"
```

### Watch macOS logs

```bash
log stream \
  --predicate 'subsystem == "app.supabit.supacode" AND category == "AgentHookSocket"' \
  --level debug
```

## Supacode app integration (for contributors to Supacode)

The extension's socket messages are already handled transparently by `AgentHookSocketServer` — the agent string `"pi"` flows through without any Swift changes. For full first-class UI support (settings toggle, install/uninstall flow) the following additions are needed in the Supacode macOS app:

<details>
<summary>Swift changes needed</summary>

**1. Add `SkillAgent.pi`**

```swift
// SupacodeSettingsShared/Models/SkillAgent.swift
public enum SkillAgent: Equatable, Sendable, CaseIterable {
  case claude
  case codex
  case pi               // ← add

  public var configDirectoryName: String {
    switch self {
    case .claude: ".claude"
    case .codex:  ".codex"
    case .pi:     ".pi"
    }
  }
}
```

**2. Add `PiSettingsClient`** following the `ClaudeSettingsClient` / `CodexSettingsClient` pattern. The "install" action symlinks this extension into `~/.pi/agent/extensions/`.

**3. No socket changes needed** — `AgentHookSocketServer` already accepts arbitrary agent names.

</details>

## How it works

Supacode injects four environment variables into every terminal it opens:

| Variable | Purpose |
|---|---|
| `SUPACODE_SOCKET_PATH` | Unix domain socket path (`/tmp/supacode-<uid>/pid-<pid>`) |
| `SUPACODE_WORKTREE_ID` | Percent-encoded worktree path |
| `SUPACODE_TAB_ID` | UUID of the terminal tab |
| `SUPACODE_SURFACE_ID` | UUID of the terminal surface |

The extension reads those on startup. If any are missing it returns immediately.

**Busy flag** wire format — single line, no JSON:
```
<worktreeID> <tabID> <surfaceID> 1|0\n
```

**Notification** wire format — header line + JSON body:
```
<worktreeID> <tabID> <surfaceID> pi\n
{"hook_event_name":"Stop","last_assistant_message":"..."}\n
```

These formats match `AgentHookSettingsCommand.busyCommand()` and `AgentHookSettingsCommand.notificationCommand("pi")` in the Supacode source, and are parsed by `AgentHookSocketServer.parse()`.

## Contributing

Contributions welcome. The codebase is a single TypeScript file with no build step.

```bash
git clone https://github.com/DxVapor/pi-supacode.git
cd pi-supacode
```

**Areas to improve:**
- Support for the `Notification` hook event (e.g. `pi.on("message_end")` for mid-session notifications)
- Surface the worktree / session name in notification titles
- Tests using a mock Unix socket

Please open an issue before starting significant work so we can discuss approach. For small fixes and typos, PRs are welcome directly.

## License

MIT — see [LICENSE](./LICENSE).
