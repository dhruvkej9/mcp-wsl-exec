import { spawn } from 'node:child_process';
import {
	build_wsl_args,
	dangerous_commands,
	wsl_config,
} from './constants.js';
import {
	CommandTimeoutError,
	CommandValidationError,
} from './errors.js';
import { PersistentSession } from './persistent-session.js';
import type { CommandResponse } from './types.js';

export function quote_shell_arg(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escape_regexp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Precompiled once at module load instead of on every call.
type DangerMatcher = (command: string) => boolean;
const danger_matchers: readonly DangerMatcher[] =
	dangerous_commands.map((dangerous) => {
		const term = dangerous.toLowerCase();

		if (term.includes(' ') || /[^\w-]/.test(term)) {
			return (command: string) =>
				command.toLowerCase().includes(term);
		}

		const pattern = new RegExp(
			`(^|[\\s;&|()])${escape_regexp(term)}(?=$|[\\s;&|()])`,
			'i',
		);
		return (command: string) => pattern.test(command);
	});

/**
 * Convert a Windows drive path (C:\Users\x or C:/Users/x) to its
 * WSL mount (/mnt/c/Users/x) so `cd` inside WSL succeeds.
 */
function to_wsl_path(path: string): string {
	const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
	if (!match) return path;
	return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

export class CommandExecutor {
	private session: PersistentSession | null = null;

	private validate_command(command: string): string {
		const validated = command.trim();

		if (!validated) {
			throw new CommandValidationError('Invalid command: empty');
		}

		if (validated.includes('\0')) {
			throw new CommandValidationError(
				'Invalid command: contains null byte',
			);
		}

		return validated;
	}

	private validate_working_dir(
		working_dir?: string,
	): string | undefined {
		if (!working_dir) return undefined;

		const validated = to_wsl_path(working_dir.trim()).replace(
			/\\/g,
			'/',
		);

		if (!validated) {
			throw new CommandValidationError('Invalid working directory');
		}

		if (validated.includes('\0')) {
			throw new CommandValidationError(
				'Invalid working directory: contains null byte',
			);
		}

		return validated;
	}

	private validate_timeout(timeout?: number): number {
		if (timeout === undefined || timeout === null || timeout === 0) {
			return wsl_config.default_timeout;
		}

		if (isNaN(timeout) || timeout < 0) {
			throw new CommandValidationError('Invalid timeout value');
		}

		return timeout;
	}

	public is_dangerous_command(command: string): boolean {
		return danger_matchers.some((matches) => matches(command));
	}

	public dispose(): void {
		this.session?.dispose();
		this.session = null;
	}

	public async execute_command(
		command: string,
		working_dir?: string,
		timeout?: number,
	): Promise<CommandResponse> {
		const validated_command = this.validate_command(command);
		const validated_dir = this.validate_working_dir(working_dir);
		const validated_timeout = this.validate_timeout(timeout);

		const cd_command = validated_dir
			? `cd -- ${quote_shell_arg(validated_dir)} && `
			: '';
		const full_command = `${cd_command}${validated_command}`;

		const result = wsl_config.persistent
			? await this.run_in_session(full_command, validated_timeout)
			: await this.run_one_shot(full_command, validated_timeout);

		return {
			...result,
			command: validated_command,
			working_dir: validated_dir,
		};
	}

	private run_in_session(
		full_command: string,
		timeout: number,
	): Promise<{
		stdout: string;
		stderr: string;
		exit_code: number | null;
	}> {
		this.session ??= new PersistentSession();
		return this.session.run(full_command, timeout);
	}

	private run_one_shot(
		full_command: string,
		timeout: number,
	): Promise<{
		stdout: string;
		stderr: string;
		exit_code: number | null;
	}> {
		return new Promise((resolve, reject) => {
			const wsl_process = wsl_config.direct
				? spawn(wsl_config.shell, ['-c', full_command], {
						stdio: ['ignore', 'pipe', 'pipe'],
						windowsHide: true,
					})
				: spawn(
						wsl_config.executable,
						build_wsl_args(['-c', full_command]),
						{
							stdio: ['ignore', 'pipe', 'pipe'],
							windowsHide: true,
						},
					);

			const stdout_chunks: Buffer[] = [];
			const stderr_chunks: Buffer[] = [];
			let stdout_bytes = 0;
			let stderr_bytes = 0;

			const collect = (
				chunks: Buffer[],
				total: number,
				data: Buffer,
			): number => {
				if (total >= wsl_config.max_output_bytes) return total;
				const remaining = wsl_config.max_output_bytes - total;
				chunks.push(
					data.length <= remaining
						? data
						: data.subarray(0, remaining),
				);
				return total + data.length;
			};

			wsl_process.stdout?.on('data', (data: Buffer) => {
				stdout_bytes = collect(stdout_chunks, stdout_bytes, data);
			});

			wsl_process.stderr?.on('data', (data: Buffer) => {
				stderr_bytes = collect(stderr_chunks, stderr_bytes, data);
			});

			let settled = false;
			let kill_escalation: NodeJS.Timeout | undefined;

			const timeout_id = setTimeout(() => {
				settled = true;
				wsl_process.kill('SIGTERM');
				kill_escalation = setTimeout(() => {
					wsl_process.kill('SIGKILL');
				}, 2000);
				reject(new CommandTimeoutError(timeout));
			}, timeout);

			const finalize = (chunks: Buffer[], total: number): string => {
				let text = Buffer.concat(chunks).toString('utf8');
				if (total > wsl_config.max_output_bytes) {
					text += `\n[output truncated at ${wsl_config.max_output_bytes} bytes]`;
				}
				return text;
			};

			wsl_process.on('close', (code: number | null) => {
				clearTimeout(timeout_id);
				if (kill_escalation) clearTimeout(kill_escalation);
				if (settled) return;
				resolve({
					stdout: finalize(stdout_chunks, stdout_bytes),
					stderr: finalize(stderr_chunks, stderr_bytes),
					exit_code: code,
				});
			});

			wsl_process.on('error', (error: Error) => {
				clearTimeout(timeout_id);
				if (kill_escalation) clearTimeout(kill_escalation);
				if (settled) return;
				settled = true;
				reject(error);
			});
		});
	}
}
