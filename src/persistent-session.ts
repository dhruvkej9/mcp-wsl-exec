import {
	spawn,
	type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { build_wsl_args, wsl_config } from './constants.js';
import { CommandTimeoutError, WslExecutionError } from './errors.js';

export interface SessionResult {
	stdout: string;
	stderr: string;
	exit_code: number;
}

interface StreamState {
	decoder: StringDecoder;
	/** Undecided tail, kept short while waiting for the sentinel. */
	pending: string;
	/** Output collected so far (capped at max_output_bytes). */
	collected: string;
	truncated: boolean;
	done: boolean;
}

interface InFlight {
	id: string;
	out: StreamState;
	err: StreamState;
	exit_code: number;
	settle_ok: (result: SessionResult) => void;
	settle_err: (error: Error) => void;
	timer?: NodeJS.Timeout;
}

const TRUNCATION_NOTICE = (limit: number) =>
	`\n[output truncated at ${limit} bytes]`;

function new_stream_state(): StreamState {
	return {
		decoder: new StringDecoder('utf8'),
		pending: '',
		collected: '',
		truncated: false,
		done: false,
	};
}

function append_collected(state: StreamState, text: string): void {
	if (state.truncated || !text) return;
	const remaining =
		wsl_config.max_output_bytes - state.collected.length;
	if (text.length <= remaining) {
		state.collected += text;
		return;
	}
	state.collected +=
		text.slice(0, Math.max(remaining, 0)) +
		TRUNCATION_NOTICE(wsl_config.max_output_bytes);
	state.truncated = true;
}

/**
 * One long-lived bash process inside WSL. Commands are written to
 * its stdin and delimited with per-command sentinel markers, which
 * avoids paying wsl.exe startup (and WSL2 VM cold boot) on every
 * tool call. Commands run serialized, each inside a subshell with
 * stdin redirected from /dev/null, so state does not leak between
 * commands and nothing can read our protocol stream.
 */
export class PersistentSession {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private current: InFlight | null = null;
	private chain: Promise<void> = Promise.resolve();
	private counter = 0;
	private pending = new Set<{
		resolve: (result: SessionResult) => void;
		reject: (error: Error) => void;
	}>();

	public run(
		full_command: string,
		timeout: number,
	): Promise<SessionResult> {
		return new Promise<SessionResult>((resolve, reject) => {
			const entry = { resolve, reject };
			this.pending.add(entry);
			this.chain = this.chain
				.catch(() => {
					// A failed predecessor must not poison the queue.
				})
				.then(() => this.run_now(full_command, timeout))
				.then(resolve, reject)
				.finally(() => this.pending.delete(entry));
		});
	}

	public dispose(): void {
		const error = new WslExecutionError('WSL session disposed');
		for (const entry of this.pending) entry.reject(error);
		this.pending.clear();
		if (this.proc) {
			this.proc.kill('SIGKILL');
			this.proc = null;
		}
	}

	private ensure_process(): ChildProcessWithoutNullStreams {
		if (
			this.proc &&
			this.proc.exitCode === null &&
			!this.proc.killed
		) {
			return this.proc;
		}

		const proc = wsl_config.direct
			? spawn(wsl_config.shell, [], { windowsHide: true })
			: spawn(wsl_config.executable, build_wsl_args([]), {
					windowsHide: true,
				});

		proc.stdout.on('data', (chunk: Buffer) =>
			this.on_data('out', chunk),
		);
		proc.stderr.on('data', (chunk: Buffer) =>
			this.on_data('err', chunk),
		);
		proc.on('error', (error: Error) => this.on_death(error));
		proc.on('close', (code: number | null) =>
			this.on_death(
				new WslExecutionError(
					`WSL session terminated unexpectedly (exit code ${code})`,
					{ exit_code: code },
				),
			),
		);
		process.once('exit', () => proc.kill('SIGKILL'));

		this.proc = proc;
		return proc;
	}

	private async run_now(
		full_command: string,
		timeout: number,
	): Promise<SessionResult> {
		const proc = this.ensure_process();
		const id = `${++this.counter}_${randomBytes(6).toString('hex')}`;

		return new Promise<SessionResult>((resolve, reject) => {
			const in_flight: InFlight = {
				id,
				out: new_stream_state(),
				err: new_stream_state(),
				exit_code: -1,
				settle_ok: resolve,
				settle_err: reject,
			};
			this.current = in_flight;

			in_flight.timer = setTimeout(() => {
				this.current = null;
				this.kill_session();
				reject(new CommandTimeoutError(timeout));
			}, timeout);

			// The subshell isolates cwd/env changes; the brace group
			// tolerates trailing comments in the user command; the
			// /dev/null redirect keeps interactive reads from
			// swallowing our protocol lines. printf emits the
			// sentinels: stdout carries the exit code, stderr marks
			// end-of-stderr. The leading \n guarantees the sentinel
			// is not glued to unterminated output (stripped later).
			const payload = [
				`( { ${full_command}`,
				`} ) < /dev/null`,
				`__mcp_ec=$?`,
				`printf '\\n__MCP_DONE_${id}_%s__\\n' "$__mcp_ec"`,
				`printf '\\n__MCP_DONE_${id}__\\n' >&2`,
				``,
			].join('\n');

			proc.stdin.write(payload, (error) => {
				if (error && this.current === in_flight) {
					this.current = null;
					if (in_flight.timer) clearTimeout(in_flight.timer);
					this.kill_session();
					reject(
						new WslExecutionError(
							`Failed to write to WSL session: ${error.message}`,
						),
					);
				}
			});
		});
	}

	private on_data(stream: 'out' | 'err', chunk: Buffer): void {
		const in_flight = this.current;
		if (!in_flight) return; // Output between commands is dropped.

		const state = stream === 'out' ? in_flight.out : in_flight.err;
		if (state.done) return;

		state.pending += state.decoder.write(chunk);

		const marker = `__MCP_DONE_${in_flight.id}_`;
		const err_marker = `__MCP_DONE_${in_flight.id}__`;

		if (stream === 'out') {
			const index = state.pending.indexOf(marker);
			if (index === -1) {
				this.flush_pending(state, marker.length);
				return;
			}
			const close = state.pending.indexOf(
				'__',
				index + marker.length,
			);
			if (close === -1) return; // Exit code digits still streaming.
			append_collected(
				state,
				strip_injected_newline(state.pending.slice(0, index)),
			);
			in_flight.exit_code = Number.parseInt(
				state.pending.slice(index + marker.length, close),
				10,
			);
			state.done = true;
		} else {
			const index = state.pending.indexOf(err_marker);
			if (index === -1) {
				this.flush_pending(state, err_marker.length);
				return;
			}
			append_collected(
				state,
				strip_injected_newline(state.pending.slice(0, index)),
			);
			state.done = true;
		}

		if (in_flight.out.done && in_flight.err.done) {
			this.current = null;
			if (in_flight.timer) clearTimeout(in_flight.timer);
			in_flight.settle_ok({
				stdout: in_flight.out.collected,
				stderr: in_flight.err.collected,
				exit_code: Number.isFinite(in_flight.exit_code)
					? in_flight.exit_code
					: -1,
			});
		}
	}

	/**
	 * Move everything except a sentinel-sized tail from pending into
	 * collected, so memory stays bounded no matter how much a
	 * command prints before finishing.
	 */
	private flush_pending(state: StreamState, keep: number): void {
		if (state.pending.length <= keep) return;
		const cut = state.pending.length - keep;
		append_collected(state, state.pending.slice(0, cut));
		state.pending = state.pending.slice(cut);
	}

	private on_death(error: Error): void {
		this.proc = null;
		const in_flight = this.current;
		if (!in_flight) return;
		this.current = null;
		if (in_flight.timer) clearTimeout(in_flight.timer);
		in_flight.settle_err(error);
	}

	private kill_session(): void {
		const proc = this.proc;
		this.proc = null;
		if (proc) {
			proc.removeAllListeners('close');
			proc.removeAllListeners('error');
			proc.on('error', () => {});
			proc.kill('SIGKILL');
		}
	}
}

/**
 * The protocol prints a '\n' before each sentinel so unterminated
 * command output cannot glue to it. Remove exactly that one byte.
 */
function strip_injected_newline(text: string): string {
	return text.endsWith('\n') ? text.slice(0, -1) : text;
}
