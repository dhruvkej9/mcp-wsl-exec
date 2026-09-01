// Commands that can irreversibly destroy data or system state.
// Everything else (redirects, sudo, package managers, mv, chmod,
// kill, service, mount, ...) runs immediately.
export const dangerous_commands = [
	'rm',
	'rmdir',
	'dd',
	'mkfs',
	'mkswap',
	'fdisk',
	'shutdown',
	'reboot',
	'find -delete',
	'truncate',
	'shred',
] as const;

function env_int(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// WSL process configuration
export const wsl_config = {
	/** Binary used to enter WSL. Override for testing only. */
	executable: process.env.MCP_WSL_EXEC_BIN ?? 'wsl.exe',
	/** Optional distro name, passed as `wsl.exe -d <distro>`. */
	distro: process.env.MCP_WSL_DISTRO,
	shell: process.env.MCP_WSL_SHELL ?? 'bash',
	/**
	 * Direct mode: spawn the shell without the wsl.exe wrapper.
	 * For running the server inside Linux/WSL itself, and for tests.
	 */
	direct: process.env.MCP_WSL_DIRECT === '1',
	/**
	 * Persistent session mode (default). Keeps one bash alive inside
	 * WSL and pipes commands to it, avoiding per-command wsl.exe
	 * startup and WSL2 VM cold boots. Set MCP_WSL_PERSISTENT=0 to
	 * fall back to one process per command.
	 */
	persistent: process.env.MCP_WSL_PERSISTENT !== '0',
	/**
	 * Confirmation gate for dangerous commands. Set MCP_WSL_CONFIRM=0
	 * to execute them immediately without a confirm_command round
	 * trip.
	 */
	confirm: process.env.MCP_WSL_CONFIRM !== '0',
	/** Applied whenever a tool call does not pass a timeout. */
	default_timeout: env_int('MCP_WSL_TIMEOUT', 30_000), // 30 seconds
	/** Cap on captured stdout/stderr, each. */
	max_output_bytes: env_int('MCP_WSL_MAX_OUTPUT', 1_048_576), // 1 MiB
};

export function build_wsl_args(trailing: string[]): string[] {
	const args: string[] = [];
	if (wsl_config.distro) {
		args.push('-d', wsl_config.distro);
	}
	// setsid -w detaches the shell from any controlling TTY, so
	// commands that would block on /dev/tty (e.g. sudo password
	// prompts) fail fast instead of hanging the whole session.
	args.push('--exec', 'setsid', '-w', wsl_config.shell, ...trailing);
	return args;
}
