#!/usr/bin/env bun
import { Glob } from 'bun';
import { readFile } from 'node:fs/promises';

export interface Violation {
  kind: 'identifier' | 'step-name';
  match: string;
}

// Match the forbidden identifiers at either a word boundary (start of identifier:
// `editMode`) OR at a camelCase boundary inside an identifier (lowercase→uppercase:
// `setEditingMode`, `TrimmingMode` after a leading word boundary). Lookahead/
// lookbehind are zero-width so `m[0]` captures only the matched substring. The
// first letter is normalized to lowercase for stable reporting (so `EditingMode`
// from `setEditingMode` is reported as `editingMode`).
const IDENTIFIER_RE =
  /(?:\b|(?<=[a-z])(?=[A-Z]))([Ee]diting|[Tt]rimming|[Cc]utting|[Ee]dit|[Tt]rim|[Cc]ut)Mode\b/g;
const STEP_NAME_RE =
  /'(trim-sides|remove-sections|cut-middle|edit-trim|edit-cuts|trim-step|cut-step)'/g;

export function findEditModeViolations(input: string): Violation[] {
  const violations: Violation[] = [];
  IDENTIFIER_RE.lastIndex = 0;
  STEP_NAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IDENTIFIER_RE.exec(input)) !== null) {
    const normalized = m[0].charAt(0).toLowerCase() + m[0].slice(1);
    violations.push({ kind: 'identifier', match: normalized });
  }
  while ((m = STEP_NAME_RE.exec(input)) !== null) {
    violations.push({ kind: 'step-name', match: m[0] });
  }
  return violations;
}

async function main(): Promise<void> {
  const glob = new Glob('src/lib/**/*.{svelte,ts}');
  let totalViolations = 0;
  for await (const file of glob.scan('.')) {
    const content = await readFile(file, 'utf8');
    const violations = findEditModeViolations(content);
    if (violations.length > 0) {
      console.error(`${file}:`);
      for (const v of violations) console.error(`  [${v.kind}] ${v.match}`);
      totalViolations += violations.length;
    }
  }
  if (totalViolations > 0) {
    console.error(
      `\nFound ${totalViolations.toString()} edit-mode violation(s). The unified editor has no two-mode design — see docs/superpowers/decisions/2026-05-01-unified-editor-no-modes.md.`
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
