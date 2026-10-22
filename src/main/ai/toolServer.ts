import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ReviewTools } from './lookup.ts'

export const TOOL_SERVER_NAME = 'review'

export interface ToolServer {
	/** A file holding the `--mcp-config` JSON for this server; written owner-only, since it holds the token. */
	configPath: string
	/** The tools as a CLI names them: `mcp__review__read_file`. */
	toolNames: Array<string>
	close(): Promise<void>
}

/**
 * Serves one request's lookups to a CLI over MCP (Streamable HTTP), on 127.0.0.1 only, for as long as that request
 * runs. Every call goes through `tools`, so its budget, clipping and log apply exactly as for an API provider. Other
 * programs on this computer can reach the port, so each server has its own random token and answers nothing without it.
 */
export async function startToolServer(tools: ReviewTools, signal: AbortSignal): Promise<ToolServer> {
	const token = randomBytes(32).toString('hex')
	const expected = Buffer.from(`Bearer ${token}`)
	const mcp = new Server({ name: TOOL_SERVER_NAME, version: '1' }, { capabilities: { tools: {} } })
	mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.definitions.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.parameters as { type: 'object' },
			annotations: { readOnlyHint: true },
		})),
	}))
	mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
		const r = await tools.call(req.params.name, req.params.arguments ?? {}, signal)
		return { content: [{ type: 'text', text: r.text }], isError: r.error }
	})

	let transport: StreamableHTTPServerTransport | null = null
	const http_ = http.createServer((req, res) => {
		const got = Buffer.from(req.headers.authorization ?? '')
		if (!transport || req.url !== '/mcp' || got.length !== expected.length || !timingSafeEqual(got, expected)) {
			res.writeHead(401).end()
			return
		}
		void transport.handleRequest(req, res)
	})
	await new Promise<void>((resolve, reject) => {
		http_.once('error', reject)
		http_.listen(0, '127.0.0.1', resolve)
	})
	const url = `http://127.0.0.1:${(http_.address() as AddressInfo).port}/mcp`
	transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: () => randomUUID(),
		enableDnsRebindingProtection: true,
		allowedHosts: [new URL(url).host],
	})
	let dir: string | null = null
	const close = async (): Promise<void> => {
		await mcp.close().catch(() => {})
		http_.closeAllConnections()
		await new Promise<void>((resolve) => http_.close(() => resolve()))
		if (dir) await rm(dir, { recursive: true, force: true })
	}
	// Once listening, a failure must still close the port, or it would keep the app's event loop alive.
	try {
		await mcp.connect(transport)
		dir = await mkdtemp(join(tmpdir(), 'review-tools-'))
		const configPath = join(dir, 'mcp.json')
		const config = { mcpServers: { [TOOL_SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }
		await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
		return { configPath, toolNames: tools.definitions.map((t) => `mcp__${TOOL_SERVER_NAME}__${t.name}`), close }
	} catch (e) {
		await close()
		throw e
	}
}
