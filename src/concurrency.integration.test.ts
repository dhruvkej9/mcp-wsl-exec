import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandExecutor } from './command-executor.js';
import { wsl_config } from './constants.js';

// Runs many commands concurrently against one live persistent
// session and asserts that (a) nothing hangs, (b) commands are
// serialized through the shared shell, and (c) each response maps
// to the right command. Skipped on plain Windows where /bin/bash is
// absent; inside WSL or on Linux/macOS it exercises the real path.
const has_bash =
	process.platform !== 'win32' && existsSync('/bin/bash');

describe.runIf(has_bash)(
	'concurrent commands on a live session',
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
			Object.assign(wsl_config, saved);
			executor.dispose();
		});

		it('completes 5 concurrent commands without hanging', async () => {
			const started = Date.now();
			const [a, b, c, d, e] = await Promise.all([
				executor.execute_command('sleep 0.4; echo A'),
				executor.execute_command('sleep 0.8; echo B'),
				executor.execute_command('sleep 1.2; echo C'),
				executor.execute_command('echo D'),
				executor.execute_command('echo E'),
			]);
			const elapsed = Date.now() - started;

			expect(a.stdout).toBe('A\n');
			expect(b.stdout).toBe('B\n');
			expect(c.stdout).toBe('C\n');
			expect(d.stdout).toBe('D\n');
			expect(e.stdout).toBe('E\n');
			// Every call must resolve; nothing may hang the session.
			expect(elapsed).toBeLessThan(10_000);
		});

		it('serializes concurrent commands through the shared shell', async () => {
			const started = Date.now();
			await Promise.all([
				executor.execute_command('sleep 0.5'),
				executor.execute_command('sleep 0.5'),
				executor.execute_command('sleep 0.5'),
			]);
			const elapsed = Date.now() - started;

			// Serialized: ~1.5s total. Truly parallel would be ~0.5s.
			// Bounds are generous to stay deterministic on slow runners.
			expect(elapsed).toBeGreaterThan(1_200);
			expect(elapsed).toBeLessThan(5_000);
		});

		it('maps each response to its own command under concurrency', async () => {
			const results = await Promise.all(
				Array.from({ length: 8 }, (_, i) =>
					executor.execute_command(`echo cmd-${i}`),
				),
			);
			results.forEach((result, i) => {
				expect(result.stdout).toBe(`cmd-${i}\n`);
				expect(result.exit_code).toBe(0);
			});
		});
	},
);
