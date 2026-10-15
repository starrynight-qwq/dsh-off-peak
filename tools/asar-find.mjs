// List asar entries whose path matches a regular expression, or extract one.
// Usage: node asar-find.mjs <archive> <regex> [--extract <innerPath> <outFile>]
import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [, , archive, pattern, ...rest] = process.argv;
if (!archive || !pattern) {
  console.error('usage: node asar-find.mjs <archive> <regex> [--extract <innerPath> <outFile>]');
  process.exit(2);
}

const fd = openSync(archive, 'r');
const head = Buffer.alloc(16);
readSync(fd, head, 0, 16, 0);
const jsonSize = head.readUInt32LE(12);
const headerBuf = Buffer.alloc(jsonSize);
readSync(fd, headerBuf, 0, jsonSize, 16);
const header = JSON.parse(headerBuf.toString('utf8'));
const baseOffset = 16 + jsonSize;

const paths = [];
const nodes = new Map();
function walk(node, path) {
  if (!node) return;
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) walk(child, path ? `${path}/${name}` : name);
    return;
  }
  paths.push(path);
  nodes.set(path, node);
}
for (const [name, child] of Object.entries(header.files ?? {})) walk(child, name);

const mode = rest[0];
if (mode === '--extract') {
  const innerPath = rest[1];
  const outFile = rest[2];
  const node = nodes.get(innerPath);
  if (!node) {
    console.error(`not found: ${innerPath}`);
    process.exit(1);
  }
  const size = Number(node.size);
  const buf = Buffer.alloc(size);
  readSync(fd, buf, 0, size, baseOffset + Number(node.offset));
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, buf);
  console.log(JSON.stringify({ extracted: innerPath, size, outFile }));
} else {
  const re = new RegExp(pattern, 'i');
  const hits = paths.filter(path => re.test(path));
  console.log(JSON.stringify({ total: paths.length, matches: hits.length }, null, 1));
  for (const hit of hits.slice(0, 60)) console.log(` ${hit} ${nodes.get(hit).size ?? ''}`);
}
closeSync(fd);
