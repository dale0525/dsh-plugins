#!/usr/bin/env node
/**
 * Measure the schema cost of every tool the host actually sends in one request,
 * grouped by namespace, so a migration's saving is a number rather than a claim.
 *
 * Reads a `request/header` tools array dumped to a JSON file (the host records
 * one into every session log) and a keep list module, then prints what is
 * announced now versus what a toolset migration would defer.
 *
 * Usage: node scripts/measure-schema.mjs <tools.json> [keep-module.mjs]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [, , toolsPath, keepModule] = process.argv;
if (!toolsPath) {
  console.error('usage: measure-schema.mjs <tools.json> [keep-module.mjs]');
  process.exit(2);
}

const tools = JSON.parse(readFileSync(toolsPath, 'utf8'));
const size = (tool) => JSON.stringify(tool).length;
const total = tools.reduce((sum, tool) => sum + size(tool), 0);

const namespaceOf = (name) => {
  const match = name.match(/^mcp__([a-z0-9_]+?)__/);
  return match ? `mcp__${match[1]}__` : '(builtin/other)';
};

const groups = new Map();
for (const tool of tools) {
  const key = namespaceOf(tool.name);
  const bucket = groups.get(key) ?? { count: 0, chars: 0 };
  bucket.count += 1;
  bucket.chars += size(tool);
  groups.set(key, bucket);
}

console.log(`total: ${tools.length} tools, ${total} chars`);
for (const [key, bucket] of [...groups.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
  console.log(`  ${key.padEnd(24)} ${String(bucket.count).padStart(3)} tools  ${String(bucket.chars).padStart(7)} chars`);
}

if (keepModule) {
  const { DEFAULT_KEEP } = await import(pathToFileURL(keepModule).href);
  const keep = new Set(DEFAULT_KEEP);
  const announced = tools.filter((tool) => tool.name.startsWith('mcp__') || keep.has(tool.name));
  const announcedChars = announced.reduce((sum, tool) => sum + size(tool), 0);
  console.log('');
  console.log(`announced under current keep: ${announced.length} tools, ${announcedChars} chars`);
  console.log(`saving vs raw: ${total - announcedChars} chars (${Math.round((1 - announcedChars / total) * 100)}%)`);
}
