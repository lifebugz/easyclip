#!/usr/bin/env bun
import { Glob } from 'bun';
import { readFile } from 'node:fs/promises';

export interface Violation {
  kind: 'class' | 'css';
  match: string;
}

const CLASS_RE = /\b([mp][lr])-[\w./-]+/g;
const CSS_RE = /\b(left|right)\s*:/g;

export function findPhysicalAxisViolations(input: string): Violation[] {
  const violations: Violation[] = [];
  let m: RegExpExecArray | null;
  CLASS_RE.lastIndex = 0;
  CSS_RE.lastIndex = 0;
  while ((m = CLASS_RE.exec(input)) !== null) {
    violations.push({ kind: 'class', match: m[0] });
  }
  while ((m = CSS_RE.exec(input)) !== null) {
    violations.push({ kind: 'css', match: m[0] });
  }
  return violations;
}

async function main(): Promise<void> {
  const glob = new Glob('src/lib/**/*.{svelte,ts,css}');
  let totalViolations = 0;
  for await (const file of glob.scan('.')) {
    const content = await readFile(file, 'utf8');
    const violations = findPhysicalAxisViolations(content);
    if (violations.length > 0) {
      console.error(`${file}:`);
      for (const v of violations) console.error(`  [${v.kind}] ${v.match}`);
      totalViolations += violations.length;
    }
  }
  if (totalViolations > 0) {
    console.error(
      `\nFound ${totalViolations.toString()} physical-axis violation(s). Use logical properties instead (ms-/me-/ps-/pe-, inset-inline-start/end).`
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
