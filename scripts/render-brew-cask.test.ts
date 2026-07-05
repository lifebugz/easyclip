import { expect, test } from 'bun:test';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SCRIPT = join(ROOT, 'scripts', 'render-brew-cask.sh');
const GOOD_SHA = '87c8548b878e35ab6a7a802e9c4512a829a28305924456632909f5f3313d1e42';

function render(args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['bash', SCRIPT, ...args]);
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString()
  };
}

test('renders byte-identical to the audited tap cask for 0.2.0', async () => {
  // Fixture fetched verbatim from tap PR #1's Casks/easyclip.rb (the brew-audited
  // file) - the first render must reproduce it exactly, trailing newline included.
  const expected = await Bun.file(
    join(import.meta.dir, 'testdata', 'easyclip-cask-0.2.0.rb')
  ).text();
  const { code, stdout, stderr } = render(['0.2.0', GOOD_SHA]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
  expect(stdout).toBe(expected);
});

test('output ends with exactly one final newline (brew style final-newline rule)', () => {
  const { stdout } = render(['0.2.0', GOOD_SHA]);
  expect(stdout.endsWith('end\n')).toBe(true);
  expect(stdout.endsWith('end\n\n')).toBe(false);
});

test('substitutes version everywhere it appears as a placeholder', () => {
  const { stdout } = render(['9.8.7', GOOD_SHA]);
  expect(stdout).toContain('version "9.8.7"');
  expect(stdout).not.toContain('__VERSION__');
  expect(stdout).not.toContain('__SHA256__');
  // Ruby-side interpolation must survive untouched (quoted heredoc guarantee):
  expect(stdout).toContain('EasyClip_#{version}_aarch64.dmg');
  expect(stdout).toContain('#{appdir}/EasyClip.app');
});

const badInvocations: { name: string; args: string[] }[] = [
  { name: 'no args', args: [] },
  { name: 'one arg', args: ['0.2.0'] },
  { name: 'three args', args: ['0.2.0', GOOD_SHA, 'extra'] },
  { name: 'v-prefixed version', args: ['v0.2.0', GOOD_SHA] },
  { name: 'two-part version', args: ['0.2', GOOD_SHA] },
  { name: 'suffixed version', args: ['0.2.0-rc1', GOOD_SHA] },
  { name: 'sha too short (63)', args: ['0.2.0', GOOD_SHA.slice(0, 63)] },
  { name: 'sha too long (65)', args: ['0.2.0', `${GOOD_SHA}0`] },
  { name: 'uppercase sha', args: ['0.2.0', GOOD_SHA.toUpperCase()] },
  { name: 'non-hex sha', args: ['0.2.0', `${GOOD_SHA.slice(0, 63)}z`] }
];

for (const { name, args } of badInvocations) {
  test(`rejects ${name}: exit 1, message on stderr, nothing rendered`, () => {
    const { code, stdout, stderr } = render(args);
    expect(code).toBe(1);
    expect(stdout).toBe(''); // never render garbage
    expect(stderr).not.toBe('');
  });
}
