/**
 * Keeps the runtime mark and the generated icons from drifting apart.
 *
 * The Riyal glyph exists twice by necessity: `brand/build-icons.py` generates
 * favicon.ico and friends at build time and is Python, and `src/lib/brand.ts`
 * feeds the loader at runtime and is TypeScript. Neither can import the other.
 *
 * Two copies of a 900-character path string is exactly the kind of duplication
 * that survives one careless edit and then quietly ships a loader that no
 * longer matches the tab icon — a difference nobody notices deliberately, but
 * which makes the app look assembled from parts. So: assert they agree.
 *
 * The arrow geometry is checked too. The loader redraws the arrows in TSX
 * rather than embedding the SVG, so the same four constants live on both sides.
 *
 * Run: npm run test:brand
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "..");

const { RIYAL_PATHS, RIYAL_VIEWBOX, BRAND } = await import(
  pathToFileURL(path.join(WEB, "src", "lib", "brand.ts")).href
);

const py = readFileSync(path.join(WEB, "brand", "build-icons.py"), "utf8");
const tsx = readFileSync(path.join(WEB, "src", "components", "ui", "loader.tsx"), "utf8");

let failures = 0;
function check(what, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`  PASS  ${what}`);
  } catch {
    failures += 1;
    console.log(`  FAIL  ${what}\n          got      ${actual}\n          expected ${expected}`);
  }
}

console.log("\n[1] RIYAL GLYPH");

// Both sides wrap the literal across lines as adjacent string chunks, so
// rejoin before comparing — reflowing either source should not fail the test.
// A new path always starts with a move command, which is the seam to split on.
const rejoin = (chunks) =>
  chunks.reduce((acc, chunk) => {
    if (/^M[\d.]/.test(chunk)) acc.push(chunk);
    else acc[acc.length - 1] += chunk;
    return acc;
  }, []);

const open = py.indexOf("RIYAL = (");
const pyGlyph = rejoin(
  py
    .slice(open, py.indexOf("\n)", open))
    .match(/"([^"]*)"/g)
    .map((s) => s.slice(1, -1)),
);

check("two paths on the Python side", pyGlyph.length, 2);
check("path 1 matches src/lib/brand.ts", pyGlyph[0], RIYAL_PATHS[0]);
check("path 2 matches src/lib/brand.ts", pyGlyph[1], RIYAL_PATHS[1]);

console.log("\n[2] GLYPH VIEWBOX");
const pyW = Number(py.match(/RIYAL_W,\s*RIYAL_H\s*=\s*([\d.]+),\s*([\d.]+)/)[1]);
const pyH = Number(py.match(/RIYAL_W,\s*RIYAL_H\s*=\s*([\d.]+),\s*([\d.]+)/)[2]);
check("width", pyW, RIYAL_VIEWBOX.width);
check("height", pyH, RIYAL_VIEWBOX.height);

console.log("\n[3] BRAND COLOURS");
check("credit", py.match(/^CREDIT = "(#[0-9A-Fa-f]{6})"/m)[1], BRAND.credit);
check("debit", py.match(/^DEBIT = "(#[0-9A-Fa-f]{6})"/m)[1], BRAND.debit);

console.log("\n[4] ARROW GEOMETRY, icon vs loader");
const pyGeom = {
  hw: Number(py.match(/hw,\s*sw\s*=\s*(\d+),\s*(\d+)/)[1]),
  sw: Number(py.match(/hw,\s*sw\s*=\s*(\d+),\s*(\d+)/)[2]),
  top: Number(py.match(/top,\s*bot,\s*head\s*=\s*(\d+),\s*(\d+),\s*(\d+)/)[1]),
  bot: Number(py.match(/top,\s*bot,\s*head\s*=\s*(\d+),\s*(\d+),\s*(\d+)/)[2]),
  head: Number(py.match(/top,\s*bot,\s*head\s*=\s*(\d+),\s*(\d+),\s*(\d+)/)[3]),
};
const tsxGeom = {
  hw: Number(tsx.match(/HALF_WIDTH = (\d+)/)[1]),
  sw: Number(tsx.match(/const SHAFT = (\d+)/)[1]),
  head: Number(tsx.match(/const HEAD = (\d+)/)[1]),
};
const tsxSpan = tsx.match(/isMark \? \[(\d+), (\d+)\] : \[\d+, \d+\];\s*\n\s*const travel/);
const tsxCx = tsx.match(/isMark \? \[(\d+), (\d+)\] : \[\d+, \d+\];/);

check("arrowhead half-width", tsxGeom.hw, pyGeom.hw);
check("shaft width", tsxGeom.sw, pyGeom.sw);
check("head height", tsxGeom.head, pyGeom.head);
check("arrow x positions", [Number(tsxCx[1]), Number(tsxCx[2])], [84, 428]);
check("arrow y span", [Number(tsxSpan[1]), Number(tsxSpan[2])], [pyGeom.top, pyGeom.bot]);

console.log("\n" + "=".repeat(70));
if (failures) {
  console.log(`${failures} BRAND CHECK${failures === 1 ? "" : "S"} FAILED`);
  console.log("=".repeat(70));
  process.exit(1);
}
console.log("ALL BRAND CHECKS PASS — icon and loader draw the same mark");
console.log("=".repeat(70));
