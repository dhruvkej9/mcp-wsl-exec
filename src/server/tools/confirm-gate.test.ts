import { describe, expect, it, vi } from 'vitest';

// The confirm gate is read from the environment at module load, so
// set it before importing the module graph under test. Static
// imports would hoist above this assignment, so the module is loaded
// dynamically instead.
process.env.MCP_WSL_CONFIRM = '0';

const { CommandExecutor } = await import('../../command-executor.js');
const { register_tools } = await import('./index.js');

interface RegisteredTool {
	definition: {
		name: string;
	};
	handler: (args: any) => Promise<any>;
}

const create_mock_server = () => {
	const tools: RegisteredTool[] = [];
	return {
		tools,
		server: {
			tool: (
				definition: RegisteredTool['definition'],
				handler: RegisteredTool['handler'],
			) => {
				tools.push({ definition, handler });
			},
		},
	};
};

describe('confirm gate (MCP_WSL_CONFIRM=0)', () => {
	it('runs dangerous commands immediately without confirmation', async () => {
		const execute_spy = vi
			.spyOn(CommandExecutor.prototype, 'execute_command')
			.mockResolvedValue({
				stdout: 'done\n',
				stderr: '',
				exit_code: 0,
				command: 'sudo reboot',
			});
		vi.spyOn(
			CommandExecutor.prototype,
			'is_dangerous_command',
		).mockReturnValue(true);
		const { tools, server } = create_mock_server();
		register_tools(server as any);
		const execute = tools.find(
			(entry) => entry.definition.name === 'execute_command',
		)!;
		const response = await execute.handler({
			command: 'sudo reboot',
		});
		expect(execute_spy).toHaveBeenCalledWith(
			'sudo reboot',
			undefined,
			undefined,
		);
		expect(response.content[0].text).toContain('Exit Code: 0');
	});
});
