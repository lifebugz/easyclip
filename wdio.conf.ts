// wdio.conf.ts — macOS L2 spike via tauri-webdriver-automation (Phase 1 Task 21c).
// Source: https://github.com/danielraffel/tauri-webdriver
import type { Options } from '@wdio/types';

export const config: Options.Testrunner = {
  runner: 'local',
  specs: ['./tests/wd-macos-spike.spec.ts'],
  maxInstances: 1,
  capabilities: [
    {
      'tauri:options': {
        binary: './src-tauri/target/debug/easyclip'
      }
    } as WebdriverIO.Capabilities
  ],
  hostname: 'localhost',
  port: 4444,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 60000 },
  logLevel: 'info',
  outputDir: './tests/wd-out'
};
