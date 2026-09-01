import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandExecutor } from './command-executor.js';
import { wsl_config } from './constants.js';
import { CommandTimeoutError } from './errors.js';

// Runs the real protocol against a real bash (direct mode, no
// wsl.exe wrapper). Skipped on plain Windows where /bin/bash is
// absent; inside WSL or on Linux/macOS it exercises the full path.
const has_bash =
	process.platform !== 'win32' && existsSync('/bin/bash');

describe.runIf(has_bash)(
	'PersistentSession against real bash',
	() => {
		let executor: CommandExecutor;
		const saved = { ...wsl_config };

		beforeAll(() => {
			wsl_config.direct = true;
			wsl_config.persistent = true;
			wsl_config.shell = 'bash';
			executor = new CommandExecutor();
		});

		afterAll(() => {
			executor.dispose();
			Object.assign(wsl_config, saved);
		});

		it('captures stdout, stderr and exit code', async () => {
			const result = await executor.execute_command(
				'echo out; echo err >&2; exit 7',
			);
			expect(result.stdout).toBe('out\n');
			expect(result.stderr).toBe('err\n');
			expect(result.exit_code).toBe(7);
		});

		it('preserves output without trailing newline', async () => {
			const result = await executor.execute_command('printf abc');
			expect(result.stdout).toBe('abc');
			expect(result.exit_code).toBe(0);
		});

		it('honors working_dir without leaking cwd between commands', async () => {
			const in_tmp = await executor.execute_command('pwd', '/tmp');
			expect(in_tmp.stdout.trim()).toBe('/tmp');

			const after = await executor.execute_command('pwd');
			expect(after.stdout.trim()).not.toBe('/tmp');
		});

		it('does not hang on commands that read stdin', async () => {
			const result = await executor.execute_command('cat', undefined, 3000);
			expect(result.exit_code).toBe(0);
			expect(result.stdout).toBe('');
		});

		it('serializes concurrent calls correctly', async () => {
			const [a, b, c] = await Promise.all([
				executor.execute_command('echo A'),
				executor.execute_command('echo B'),
				executor.execute_command('echo C'),
			]);
			expect(a.stdout).toBe('A\n');
			expect(b.stdout).toBe('B\n');
			expect(c.stdout).toBe('C\n');
		});

		it('times out, then recovers on the next command', async () => {
			await expect(
				executor.execute_command('sleep 5', undefined, 300),
			).rejects.toBeInstanceOf(CommandTimeoutError);

			const recovered = await executor.execute_command(
				'echo recovered',
			);
			expect(recovered.stdout).toBe('recovered\n');
		});

		it('truncates huge output without losing the session', async () => {
			const saved_max = wsl_config.max_output_bytes;
			wsl_config.max_output_bytes = 1024;
			try {
				const result = await executor.execute_command(
					'head -c 100000 /dev/zero | tr "\\0" "x"',
				);
				expect(result.stdout).toContain('[output truncated');
				expect(result.stdout.length).toBeLessThan(1200);
			} finally {
				wsl_config.max_output_bytes = saved_max;
			}

			const after = await executor.execute_command('echo alive');
			expect(after.stdout).toBe('alive\n');
		});

		it('handles multi-line commands and quotes', async () => {
			const result = await executor.execute_command(
				`for i in 1 2 3; do
	echo "line $i" # trailing comment
done`,
			);
			expect(result.stdout).toBe('line 1\nline 2\nline 3\n');
		});
	},
);
