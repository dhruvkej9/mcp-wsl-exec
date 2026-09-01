import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';

// Drives the server exactly as Claude Desktop does on Windows:
// powershell.exe -> wsl -> node dist/index.js, then speaks the MCP
// stdio protocol. Exercises the real production path (Windows-side
// wsl.exe, persistent session, setsid hang-proofing, confirmation
// gate). Skipped where the Windows-side binaries are absent.
const WSL = '/mnt/c/WINDOWS/system32/wsl.exe';
const PS =
	'/mnt/c/WINDOWS/system32/WindowsPowerShell/v1.0/powershell.exe';
const has_windows_wsl = existsSync(WSL) && existsSync(PS);
const REPO_ROOT = new URL('..', import.meta.url).pathname;
const SERVER = `${REPO_ROOT}dist/index.js`;

class MCPClient {
	private proc: ChildProcess;
	private buffer = '';
	private pending = new Map<number, (msg: any) => void>();
	private next_id = 1;

	constructor(proc: ChildProcess) {
		this.proc = proc;
		proc.stdout?.on('data', (chunk: Buffer) => {
			this.buffer += chunk.toString();
			let nl: number;
			while ((nl = this.buffer.indexOf('\n')) !== -1) {
				const line = this.buffer.slice(0, nl).trim();
				this.buffer = this.buffer.slice(nl + 1);
				if (!line) continue;
				try {
					const msg = JSON.parse(line);
					if (
						msg &&
						typeof msg.id === 'number' &&
						this.pending.has(msg.id)
					) {
						const resolve = this.pending.get(msg.id)!;
						this.pending.delete(msg.id);
						resolve(msg);
					}
				} catch {
					// Not a complete JSON-RPC message; keep buffering.
				}
			}
		});
	}

	async call(method: string, params: unknown): Promise<any> {
		const id = this.next_id++;
		// Real-timer guard: this suite deliberately exercises the
		// server's timeout behavior against the platform clock, so
		// deterministic fake timers cannot be used.
		const { promise, resolve, reject } = Promise.withResolvers<any>();
		const timer = setTimeout(() => {
			this.pending.delete(id);
			reject(new Error(`MCP call ${method} timed out`));
		}, 30_000);
		this.pending.set(id, (msg) => {
			clearTimeout(timer);
			resolve(msg);
		});
		this.proc.stdin!.write(
			JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
		);
		return promise;
	}

	notify(method: string, params: unknown): void {
		this.proc.stdin!.write(
			JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n',
		);
	}

	async init(): Promise<void> {
		await this.call('initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'windows-mcp-test', version: '1' },
		});
		this.notify('notifications/initialized', {});
	}

	async execute_command(
		command: string,
		extra?: Record<string, unknown>,
	): Promise<any> {
		const msg = await this.call('tools/call', {
			name: 'execute_command',
			arguments: { command, ...extra },
		});
		return msg.result;
	}

	close(): void {
		this.proc.kill();
	}
}

function spawn_server(env?: Record<string, string>): MCPClient {
	const inner = env
		? `wsl bash -c "${Object.entries(env)
				.map(([k, v]) => `${k}=${v}`)
				.join(' ')} exec node ${SERVER}"`
		: `wsl node ${SERVER}`;
	const proc = spawn(PS, ['-NoProfile', '-Command', inner], {
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	return new MCPClient(proc);
}

describe.runIf(has_windows_wsl)(
	'Windows-side MCP (Claude Desktop path)',
	() => {
		beforeAll(() => {
			if (!existsSync(SERVER)) {
				execSync('npm run build', {
					cwd: REPO_ROOT,
					stdio: 'inherit',
				});
			}
		});

		it('executes a command over the production path', async () => {
			const client = spawn_server();
			try {
				await client.init();
				const result = await client.execute_command('echo hello');
				expect(result.content[0].text).toContain('Exit Code: 0');
				expect(result.content[0].text).toContain('hello');
			} finally {
				client.close();
			}
		});

		it('caps very large output without hanging', async () => {
			const client = spawn_server();
			try {
				await client.init();
				const result = await client.execute_command(
					"head -c 5000000 /dev/zero | tr '\\0' 'x'",
				);
				expect(result.content[0].text).toContain('Exit Code: 0');
			} finally {
				client.close();
			}
		});

		it('times out a long command and recovers', async () => {
			const client = spawn_server();
			try {
				await client.init();
				const result = await client.execute_command('sleep 30', {
					timeout: 2000,
				});
				expect(result.isError).toBe(true);
				expect(result.content[0].text).toMatch(/timed out/i);
				const recovered =
					await client.execute_command('echo recovered');
				expect(recovered.content[0].text).toContain('recovered');
			} finally {
				client.close();
			}
		});

		it('does not hang on sudo (setsid fix)', async () => {
			const client = spawn_server();
			try {
				await client.init();
				const result = await client.execute_command('sudo echo hi');
				expect(result.content[0].text).toContain('Exit Code: 1');
				const after = await client.execute_command('echo after');
				expect(after.content[0].text).toContain('after');
			} finally {
				client.close();
			}
		});

		it('completes 5 parallel commands without hanging', async () => {
			const client = spawn_server();
			try {
				await client.init();
				const results = await Promise.all([
					client.execute_command('sleep 0.4; echo A'),
					client.execute_command('sleep 0.8; echo B'),
					client.execute_command('sleep 1.2; echo C'),
					client.execute_command('echo D'),
					client.execute_command('echo E'),
				]);
				const texts = results.map((r) => r.content[0].text);
				expect(texts[0]).toContain('A');
				expect(texts[1]).toContain('B');
				expect(texts[2]).toContain('C');
				expect(texts[3]).toContain('D');
				expect(texts[4]).toContain('E');
			} finally {
				client.close();
			}
		});

		it('requires confirmation for rm but not redirects', async () => {
			const client = spawn_server();
			try {
				await client.init();
				const rm = await client.execute_command('rm -rf /tmp/xx');
				expect(rm.content[0].text).toMatch(/requires confirmation/i);
				const redirect = await client.execute_command(
					'echo hi > /tmp/xx',
				);
				expect(redirect.content[0].text).toContain('Exit Code:');
			} finally {
				client.close();
			}
		});

		it('runs dangerous commands immediately with MCP_WSL_CONFIRM=0', async () => {
			const client = spawn_server({ MCP_WSL_CONFIRM: '0' });
			try {
				await client.init();
				const rm = await client.execute_command('rm -rf /tmp/xx');
				expect(rm.content[0].text).toContain('Exit Code:');
			} finally {
				client.close();
			}
		});
	},
);
