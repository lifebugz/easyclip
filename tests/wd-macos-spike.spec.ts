// Phase 1 macOS L2 early spike (M4)
import { browser, expect } from '@wdio/globals';

describe('Phase 1 macOS L2 spike', () => {
  it('opens the Tauri window and reads the placeholder heading', async () => {
    const heading = await browser.$('h1');
    await expect(heading).toBeExisting();
    const text = await heading.getText();
    if (!text.includes('EasyClip')) {
      throw new Error(`expected heading to contain "EasyClip"; got "${text}"`);
    }
  });
});
