import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../js/", import.meta.url));

test("browser modules have no circular imports or controller dependency on app bootstrap", () => {
  const graph = new Map();
  function visitFile(filename) {
    if (graph.has(filename)) return;
    const source = readFileSync(filename, "utf8");
    const dependencies = [...source.matchAll(/\b(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/g)]
      .map((match) => path.resolve(path.dirname(filename), match[1]));
    graph.set(filename, dependencies);
    dependencies.forEach(visitFile);
  }
  for (const file of readdirSync(directory).filter(file => file.endsWith(".js"))) visitFile(path.join(directory, file));
  const complete = new Set();
  function check(filename, ancestors = []) {
    assert.ok(!ancestors.includes(filename), `Circular dependency: ${[...ancestors, filename].map(file => path.relative(directory, file)).join(" → ")}`);
    if (complete.has(filename)) return;
    for (const dependency of graph.get(filename)) {
      assert.notEqual(path.basename(dependency), "app.js", `${filename} imports bootstrap state`);
      check(dependency, [...ancestors, filename]);
    }
    complete.add(filename);
  }
  for (const filename of graph.keys()) check(filename);
});
