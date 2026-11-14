import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Fingerprint of the code a server runs. The launcher compares it with the files
// on disk, so a server left running from an earlier build is never silently
// reused, even when the version number has not changed.
export function buildId() {
  const hash = createHash('sha256');
  const files = ['server.mjs', 'package-lock.json', ...['src', 'public'].flatMap(dir =>
    readdirSync(path.join(root, dir), { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => `${dir}/${entry.name}`).sort())];
  for (const file of files) { hash.update(file + '\0'); hash.update(readFileSync(path.join(root, file))); }
  return hash.digest('hex').slice(0, 12);
}
