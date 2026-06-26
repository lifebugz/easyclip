#!/usr/bin/env bun
import { Glob } from 'bun';
import { readFile } from 'node:fs/promises';

export interface HardcodedString {
  literal: string;
}

const TEXT_RE = />([^<{][^<]*[A-Za-z][^<]*)</g;
const SCRIPT_BLOCK_RE = /<script[^>]*>[\s\S]*?<\/script>/g;
const STYLE_BLOCK_RE = /<style[^>]*>[\s\S]*?<\/style>/g;

export function findHardcodedStrings(input: string): HardcodedString[] {
  const stripped = input.replace(SCRIPT_BLOCK_RE, '').replace(STYLE_BLOCK_RE, '');
  const violations: HardcodedString[] = [];
  let m: RegExpExecArray | null;
  TEXT_RE.lastIndex = 0;
  while ((m = TEXT_RE.exec(stripped)) !== null) {
    // m[1] is guaranteed by the capture group; noUncheckedIndexedAccess types it as string|undefined
    const text = (m[1] ?? '').trim();
    if (text === '' || text.startsWith('{') || text.includes('{$t(')) continue;
    violations.push({ literal: text });
  }
  return violations;
}

async function main(): Promise<void> {
  const glob = new Glob('src/lib/components/**/*.svelte');
  let total = 0;
  for await (const file of glob.scan('.')) {
    const content = await readFile(file, 'utf8');
    const hits = findHardcodedStrings(content);
    if (hits.length > 0) {
      console.error(`${file}:`);
      for (const h of hits) console.error(`  literal: ${JSON.stringify(h.literal)}`);
      total += hits.length;
    }
  }
  if (total > 0) {
    console.error(
      `\nFound ${total.toString()} hardcoded user-facing string(s). Wrap in $t('key').`
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
