import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 't', version: '1' });
await c.connect(new StdioClientTransport({ command: 'npx', args: ['tsx', 'server/mcp.ts'], env: { ...process.env, ZIV_USER: process.argv[2] }, stderr: 'inherit' }));
const { tools } = await c.listTools();
console.log('tools', tools.map((t) => t.name).join(', '));
const r = await c.callTool({ name: 'who_knows', arguments: { ref: 'payments-api' } });
console.log(r.content[0].text.slice(0, 700));
await c.close();
