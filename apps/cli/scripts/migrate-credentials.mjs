#!/usr/bin/env node
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(readArgument('--source') ?? path.join(projectRoot, '.env'));
const maiHome = path.resolve(process.env.MAI_HOME?.trim() || path.join(os.homedir(), '.mai'));
const target = path.resolve(readArgument('--target') ?? path.join(maiHome, 'credentials.env'));
const secretName = /(?:API_KEY|ACCESS_TOKEN|TOKEN|SECRET|PASSWORD)$/;

if (!existsSync(source)) {
  console.log(`No source file found at ${source}; nothing to migrate.`);
  process.exit(0);
}

const sourceText = readFileSync(source, 'utf8');
const sourceLines = sourceText.split(/\r?\n/);
const candidates = new Map();
for (const [index, line] of sourceLines.entries()) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  if (match && secretName.test(match[1])) candidates.set(match[1], { index, line, value: match[2] });
}
if (candidates.size === 0) {
  console.log(`No credential assignments found in ${source}.`);
  process.exit(0);
}

const header = '# Mai provider credentials (chmod 600)\n';
let targetText = existsSync(target) ? readFileSync(target, 'utf8') : header;
const targetValues = new Map();
for (const line of targetText.split(/\r?\n/)) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  if (match) targetValues.set(match[1], match[2]);
}

for (const [name, candidate] of candidates) {
  if (targetValues.has(name) && targetValues.get(name) !== candidate.value) {
    throw new Error(`Credential ${name} differs between ${source} and ${target}; refusing to overwrite either file.`);
  }
  if (!targetValues.has(name)) {
    if (targetText && !targetText.endsWith('\n')) targetText += '\n';
    targetText += `${candidate.line}\n`;
  }
}

mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
writeFileSync(target, targetText, { mode: 0o600 });
chmodSync(target, 0o600);
const migratedIndexes = new Set([...candidates.values()].map((candidate) => candidate.index));
const remaining = sourceLines.filter((_line, index) => !migratedIndexes.has(index)).join('\n');
writeFileSync(source, remaining, { mode: statSync(source).mode & 0o777 });
console.log(`Migrated ${[...candidates.keys()].join(', ')} to ${target}; values were not printed.`);

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
