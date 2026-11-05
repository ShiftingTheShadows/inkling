#!/usr/bin/env node
// stdio entry point (Claude Code / Claude Desktop / Cursor on the same machine).
// For phones and claude.ai, run http.js instead.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './core.js';

await createServer().connect(new StdioServerTransport());
console.error('inkling-mcp ready');
