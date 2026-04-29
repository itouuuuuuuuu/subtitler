#!/usr/bin/env node
// Sync extension/manifest.json "version" with the version in package.json.
// Invoked automatically by `npm version` via the "version" lifecycle script.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifestPath = resolve(root, 'extension/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (manifest.version === pkg.version) {
  console.log(`[sync-version] manifest.json already at ${pkg.version}`);
  process.exit(0);
}

const previous = manifest.version;
manifest.version = pkg.version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`[sync-version] manifest.json: ${previous} -> ${pkg.version}`);
