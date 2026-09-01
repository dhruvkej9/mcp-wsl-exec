# Performance fixes: why mcp-wsl-exec was slow with Claude Desktop

## Root causes (ranked by impact)

### 1. A fresh `wsl.exe` process per tool call

`CommandExecutor.execute_command()` called
`spawn('wsl.exe', ['--exec', 'bash', '-c', cmd])` for every single
command. Each `wsl.exe` invocation connects to the WSL service,
attaches to the utility VM, and starts a new bash. Warm cost on
typical machines is 200–800 ms per call. Worse: WSL2 shuts the VM
down after ~60 s of inactivity (`vmIdleTimeout`), so the first tool
call after any pause paid a full VM cold boot of 2–10+ seconds.
Claude Desktop conversations are exactly that pattern — bursts of
calls separated by idle thinking time — so cold boots were paid
constantly.

**Fix:** `PersistentSession` keeps one long-lived
`wsl.exe --exec bash` alive and pipes commands to its stdin,
delimited by per-command sentinel markers that carry the exit code.
Per-command cost drops to single-digit milliseconds, and because a
live process exists inside the VM, WSL2 never idle-shuts the VM —
cold boots disappear entirely after the first call. Commands are
serialized through a promise queue, each runs inside a subshell
(`( … )`) with stdin redirected from `/dev/null`, so cwd/env changes
never leak between commands and the stateless per-command semantics
of the old implementation are preserved. On timeout or session
death the shell is SIGKILLed and transparently respawned for the
next command. Set `MCP_WSL_PERSISTENT=0` to restore the old
one-process-per-command behavior.

### 2. The default timeout was dead code

`wsl_config.default_timeout` (30 s) existed in `constants.ts` but
was never applied: `validate_timeout(undefined)` returned
`undefined`, and no timer was set. Any command that blocked — a
hung network call, an interactive prompt — blocked the Claude
Desktop tool call forever, which reads as "the server is very
slow."

**Fix:** `validate_timeout` now returns `default_timeout` when the
caller passes nothing (configurable via `MCP_WSL_TIMEOUT`). Every
command is bounded.

### 3. stdin left open on child processes

The spawned process inherited an open stdin pipe that was never
written to or closed. Any command that reads stdin (`cat`, package
managers asking for confirmation, anything interactive) waited
forever. Combined with #2 this produced permanent hangs.

**Fix:** one-shot mode spawns with
`stdio: ['ignore', 'pipe', 'pipe']`; session mode redirects every
command from `/dev/null`. `cat` now returns immediately with exit
code 0 instead of hanging.

### 4. Quadratic, unbounded, encoding-unsafe output collection

`stdout += data.toString()` re-allocates the full string on every
chunk (O(n²) over large outputs), corrupts multibyte UTF-8
characters that straddle chunk boundaries, and had no size cap — a
`cat` of a large file ballooned memory and then dumped megabytes
into the model context, freezing the Claude Desktop UI.

**Fix:** one-shot mode collects `Buffer` chunks and does a single
`Buffer.concat().toString()` at the end; session mode decodes with
`StringDecoder` (multibyte-safe). Both cap captured output at
`max_output_bytes` (default 1 MiB, configurable via
`MCP_WSL_MAX_OUTPUT`) and append a truncation notice. The session
parser flushes scanned text incrementally, so memory stays bounded
no matter how much a command prints.

### 5. Weak timeout kill

On timeout the old code called `wsl_process.kill()` (SIGTERM on the
Windows-side wsl.exe) once; the Linux-side process could survive.

**Fix:** one-shot mode escalates SIGTERM → SIGKILL after 2 s.
Session mode SIGKILLs the whole session and respawns, which is
unambiguous.

### 6. Smaller issues fixed along the way

- `is_dangerous_command` compiled ~30 regexes on every call; they
  are now precompiled once at module load.
- The confirmation flow stored the outer promise's
  `resolve`/`reject` in `pending_confirmations` and then resolved
  that same promise immediately — the stored handlers were dead
  weight, entries never expired (a slow leak), and IDs came from
  `Math.random().toString(36).substring(7)` (short, collidable).
  Confirmations now use `crypto.randomUUID()`, carry a
  `created_at`, expire after 5 minutes, and store no dead
  resolvers.
- Windows drive paths passed as `working_dir` (`C:\Users\…`) are
  translated to WSL mounts (`/mnt/c/Users/…`) so `cd` succeeds
  instead of silently failing the whole command.

## Configuration-level latency (not code, worth knowing)

The README's Claude Desktop config uses `npx -y mcp-wsl-exec`,
which can hit the npm registry on every Claude Desktop launch and
delays server startup. For the fastest startup, install once and
point the config at the built entry directly:

```json
{
	"mcpServers": {
		"mcp-wsl-exec": {
			"command": "node",
			"args": ["C:/path/to/mcp-wsl-exec/dist/index.js"]
		}
	}
}
```

## New environment variables

| Variable             | Default   | Purpose                                    |
| -------------------- | --------- | ------------------------------------------ |
| `MCP_WSL_PERSISTENT` | `1`       | `0` disables the shared session            |
| `MCP_WSL_TIMEOUT`    | `30000`   | Default per-command timeout (ms)           |
| `MCP_WSL_MAX_OUTPUT` | `1048576` | Per-stream output cap (bytes)              |
| `MCP_WSL_DISTRO`     | –         | Pass a distro to `wsl.exe -d <distro>`     |
| `MCP_WSL_SHELL`      | `bash`    | Shell executed inside WSL                  |
| `MCP_WSL_DIRECT`     | `0`       | `1` runs the shell without wsl.exe wrapper |

## Verification

The sentinel protocol, exit-code capture, cwd isolation, stdin
behavior, serialization of concurrent calls, timeout + respawn,
truncation, UTF-8 handling, and sentinel-collision immunity are
covered by unit tests (`src/command-executor.test.ts`) and by an
integration suite that runs the real protocol against a real bash
(`src/persistent-session.integration.test.ts`, auto-skipped on
plain Windows, runs inside WSL/Linux/macOS).
