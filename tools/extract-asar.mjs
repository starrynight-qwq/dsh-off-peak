// Minimal asar extractor: pulls a subtree out of an Electron asar archive.
// Usage: node extract-asar.mjs <archive> <innerPrefix> <outDir>
import { createReadStream, openSync, readSync, closeSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const [, , archive, prefix = 'dsh', outDir = './_dsh_src'] = process.argv;
if (!archive) {
  console.error('usage: node extract-asar.mjs <archive> <innerPrefix> <outDir>');
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

let written = 0;
let skippedUnpacked = 0;
function walk(node, path) {
  if (!node) return;
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) walk(child, path ? `${path}/${name}` : name);
    return;
  }
  if (node.unpacked) { skippedUnpacked++; return; }
  if (typeof node.offset !== 'string' && typeof node.offset !== 'number') return;
  const size = Number(node.size);
  const off = baseOffset + Number(node.offset);
  const target = join(outDir, path.slice(prefix.length).replace(/^\//, ''));
  mkdirSync(dirname(target), { recursive: true });
  const buf = Buffer.alloc(size);
  readSync(fd, buf, 0, size, off);
  writeFileSync(target, buf);
  written++;
}
const root = header.files?.[prefix];
if (!root) {
  console.error(`prefix not found: ${prefix}`);
  process.exit(1);
}
walk(root, prefix);
closeSync(fd);
console.log(JSON.stringify({ extracted: written, skippedUnpacked, baseOffset, outDir }));
