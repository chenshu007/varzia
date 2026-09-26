import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function sourceFiles(directory) {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return entry.isFile() && /\.(?:js|mjs)$/.test(entry.name) ? [relative] : [];
  });
}

// Tests are parsed by the test runner; check browser entrypoints and CLI sources
// without importing them or executing their side effects.
const files = [...sourceFiles("js"), ...sourceFiles("scripts")].sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${files.length} source files.`);
