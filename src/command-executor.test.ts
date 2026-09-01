import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { CommandExecutor } from './command-executor.js';
import { wsl_config } from './constants.js';
import {
	CommandTimeoutError,
	CommandValidationError,
} from './errors.js';
import { PersistentSession } from './persistent-session.js';

vi.mock('node:child_process', () => ({
	spawn: vi.fn(),
}));

const mock_spawn = vi.mocked(spawn);

function fake_process() {
	const proc = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		stdin: { write: ReturnType<typeof vi.fn> };
		kill: ReturnType<typeof vi.fn>;
		exitCode: number | null;
		killed: boolean;
	};
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.stdin = {
		write: vi.fn((_data: string, cb?: (e?: Error) => void) => {
			cb?.();
			return true;
		}),
	};
	proc.kill = vi.fn();
	proc.exitCode = null;
	proc.killed = false;
	return proc;
}

function one_shot_process({
	stdout = 'ok\n',
	stderr = '',
	code = 0,
}: {
	stdout?: string;
	stderr?: string;
	code?: number;
}) {
	const proc = fake_process();
	mock_spawn.mockReturnValue(proc as never);
	queueMicrotask(() => {
		if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
		if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
		proc.emit('close', code);
	});
	return proc;
}

/** Extract the per-command sentinel id from the written payload. */
function payload_id(payload: string): string {
	const match = /__MCP_DONE_([0-9a-z_]+)_%s__/.exec(payload);
	if (!match) throw new Error('no sentinel id in payload');
	return match[1];
}

function complete_command(
	proc: ReturnType<typeof fake_process>,
	call_index: number,
	{
		stdout = '',
		stderr = '',
		code = 0,
	}: { stdout?: string; stderr?: string; code?: number },
) {
	const payload = proc.stdin.write.mock.calls[
		call_index
	][0] as string;
	const id = payload_id(payload);
	if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
	proc.stdout.emit(
		'data',
		Buffer.from(`\n__MCP_DONE_${id}_${code}__\n`),
	);
	if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
	proc.stderr.emit('data', Buffer.from(`\n__MCP_DONE_${id}__\n`));
}

describe('CommandExecutor (one-shot mode)', () => {
	beforeEach(() => {
		mock_spawn.mockReset();
		wsl_config.persistent = false;
	});

	afterEach(() => {
		wsl_config.persistent = true;
	});

	it('executes commands through WSL with stdin closed', async () => {
		one_shot_process({ stdout: 'hello\n' });

		const result = await new CommandExecutor().execute_command(
			'echo hello; rm -rf /',
			'/tmp/project',
		);

		expect(mock_spawn).toHaveBeenCalledWith(
			'wsl.exe',
			[
				'--exec',
				'bash',
				'-c',
				"cd -- '/tmp/project' && echo hello; rm -rf /",
			],
			{ stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
		);
		expect(result).toEqual(
			expect.objectContaining({
				stdout: 'hello\n',
				exit_code: 0,
				command: 'echo hello; rm -rf /',
				working_dir: '/tmp/project',
			}),
		);
	});

	it('converts Windows drive paths to WSL mounts', async () => {
		one_shot_process({ stdout: '' });

		await new CommandExecutor().execute_command(
			'ls',
			'C:\\Users\\dev\\project',
		);

		expect(mock_spawn).toHaveBeenCalledWith(
			'wsl.exe',
			[
				'--exec',
				'bash',
				'-c',
				"cd -- '/mnt/c/Users/dev/project' && ls",
			],
			expect.anything(),
		);
	});

	it('rejects empty commands', async () => {
		await expect(
			new CommandExecutor().execute_command('   '),
		).rejects.toBeInstanceOf(CommandValidationError);
	});

	it('applies the default timeout when none is given', async () => {
		vi.useFakeTimers();
		try {
			const proc = fake_process();
			mock_spawn.mockReturnValue(proc as never);

			const pending = new CommandExecutor().execute_command(
				'sleep 999',
			);
			const expectation = expect(pending).rejects.toBeInstanceOf(
				CommandTimeoutError,
			);

			await vi.advanceTimersByTimeAsync(
				wsl_config.default_timeout + 1,
			);
			await expectation;
			expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
		} finally {
			vi.useRealTimers();
		}
	});

	it('truncates oversized output', async () => {
		const original = wsl_config.max_output_bytes;
		wsl_config.max_output_bytes = 8;
		try {
			one_shot_process({ stdout: '0123456789ABCDEF' });
			const result = await new CommandExecutor().execute_command(
				'echo big',
			);
			expect(result.stdout).toBe(
				'01234567\n[output truncated at 8 bytes]',
			);
		} finally {
			wsl_config.max_output_bytes = original;
		}
	});

	it('detects dangerous commands', () => {
		const executor = new CommandExecutor();

		expect(executor.is_dangerous_command('sudo rm -rf /tmp/x')).toBe(
			true,
		);
		expect(executor.is_dangerous_command('apt-get update')).toBe(
			true,
		);
		expect(executor.is_dangerous_command('echo hi > file')).toBe(
			true,
		);
		expect(executor.is_dangerous_command('echo safe')).toBe(false);
		expect(executor.is_dangerous_command('format_output()')).toBe(
			false,
		);
		// Backslash-escaped command names must not bypass the matcher.
		expect(executor.is_dangerous_command('\\rm -rf /tmp/x')).toBe(
			true,
		);
		expect(executor.is_dangerous_command('\\r\\m -rf /tmp/x')).toBe(
			true,
		);
	});
});

describe('PersistentSession (protocol)', () => {
	beforeEach(() => {
		mock_spawn.mockReset();
	});

	it('runs a command over the shared shell and parses the sentinels', async () => {
		const proc = fake_process();
		mock_spawn.mockReturnValue(proc as never);
		const session = new PersistentSession();

		const pending = session.run('echo hello', 5000);
		await vi.waitFor(() =>
			expect(proc.stdin.write).toHaveBeenCalled(),
		);

		const payload = proc.stdin.write.mock.calls[0][0] as string;
		expect(payload).toContain('( { echo hello');
		expect(payload).toContain('< /dev/null');

		complete_command(proc, 0, {
			stdout: 'hello\n',
			stderr: 'warn\n',
			code: 3,
		});

		await expect(pending).resolves.toEqual({
			stdout: 'hello\n',
			stderr: 'warn\n',
			exit_code: 3,
		});
	});

	it('preserves output without a trailing newline', async () => {
		const proc = fake_process();
		mock_spawn.mockReturnValue(proc as never);
		const session = new PersistentSession();

		const pending = session.run('printf abc', 5000);
		await vi.waitFor(() =>
			expect(proc.stdin.write).toHaveBeenCalled(),
		);
		complete_command(proc, 0, { stdout: 'abc', code: 0 });

		await expect(pending).resolves.toEqual(
			expect.objectContaining({ stdout: 'abc' }),
		);
	});

	it('reuses one process across sequential commands', async () => {
		const proc = fake_process();
		mock_spawn.mockReturnValue(proc as never);
		const session = new PersistentSession();

		const first = session.run('echo one', 5000);
		await vi.waitFor(() =>
			expect(proc.stdin.write).toHaveBeenCalledTimes(1),
		);
		complete_command(proc, 0, { stdout: 'one\n' });
		await first;

		const second = session.run('echo two', 5000);
		await vi.waitFor(() =>
			expect(proc.stdin.write).toHaveBeenCalledTimes(2),
		);
		complete_command(proc, 1, { stdout: 'two\n' });
		await second;

		expect(mock_spawn).toHaveBeenCalledTimes(1);
	});

	it('kills the session on timeout and respawns for the next command', async () => {
		const procs: ReturnType<typeof fake_process>[] = [];
		mock_spawn.mockImplementation(() => {
			const proc = fake_process();
			procs.push(proc);
			return proc as never;
		});
		const session = new PersistentSession();

		const timed_out = session.run('sleep 999', 30);
		await expect(timed_out).rejects.toBeInstanceOf(
			CommandTimeoutError,
		);
		expect(procs[0].kill).toHaveBeenCalledWith('SIGKILL');

		const recovered = session.run('echo back', 5000);
		await vi.waitFor(() => expect(procs.length).toBe(2));
		await vi.waitFor(() =>
			expect(procs[1].stdin.write).toHaveBeenCalled(),
		);
		complete_command(procs[1], 0, { stdout: 'back\n' });

		await expect(recovered).resolves.toEqual(
			expect.objectContaining({ stdout: 'back\n' }),
		);
	});

	it('rejects the in-flight command when the session dies', async () => {
		const proc = fake_process();
		mock_spawn.mockReturnValue(proc as never);
		const session = new PersistentSession();

		const pending = session.run('echo doomed', 5000);
		await vi.waitFor(() =>
			expect(proc.stdin.write).toHaveBeenCalled(),
		);
		proc.emit('close', 1);

		await expect(pending).rejects.toThrow(
			'WSL session terminated unexpectedly',
		);
	});
});
