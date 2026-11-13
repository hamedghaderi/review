import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
	AGENT_INSTRUCTIONS,
	AGENT_SERVER_NAME,
	AGENT_TOOLS,
	callAgentTool,
	checkoutAt,
	dataDir,
	relationOf,
	storeReader,
} from './agentServer.ts'

/**
 * Review for your coding agent (issue #200): a read-only MCP server on stdio. Your agent starts it from Review's own
 * binary in Node mode (ELECTRON_RUN_AS_NODE=1), so it works while Review is closed and opens no port. Settings ›
 * Coding agents shows the exact command.
 */

const mcp = new Server({ name: AGENT_SERVER_NAME, version: '1' }, { capabilities: { tools: {} }, instructions: AGENT_INSTRUCTIONS })
const deps = {
	readStore: storeReader(join(dataDir(), 'review-store.json')),
	checkout: checkoutAt,
	relation: relationOf,
	cwd: process.cwd(),
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: AGENT_TOOLS.map((t) => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: false } })),
}))
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
	const r = await callAgentTool(req.params.name, req.params.arguments ?? {}, deps)
	return { content: [{ type: 'text', text: r.text }], isError: r.error }
})

void mcp.connect(new StdioServerTransport())
