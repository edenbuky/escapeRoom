import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyShownValue, copyTextToClipboard, trimSingleLineInput } from './room-1-ui.helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('trimSingleLineInput', () => {
  it('trims surrounding spaces and line breaks without changing internal text', () => {
    expect(trimSingleLineInput(' \r\n Dana\tSmith \n')).toBe('Dana\tSmith');
  });

  it('preserves empty input', () => {
    expect(trimSingleLineInput(' \r\n\t ')).toBe('');
  });
});

describe('copyTextToClipboard', () => {
  it('reports success only after the browser clipboard resolves', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await expect(copyTextToClipboard('copied value')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('copied value');
  });

  it('reports unavailable when clipboard access is absent', async () => {
    vi.stubGlobal('navigator', {});

    await expect(copyTextToClipboard('select manually')).resolves.toBe(false);
  });

  it('reports unavailable when the browser denies clipboard access', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await expect(copyTextToClipboard('select manually')).resolves.toBe(false);
  });

  it('propagates unexpected clipboard failures', async () => {
    const failure = new Error('unexpected clipboard failure');
    const writeText = vi.fn().mockRejectedValue(failure);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await expect(copyTextToClipboard('value')).rejects.toBe(failure);
  });
});

describe('copyShownValue', () => {
  it('copies, skips while text is selected, and selects the value when the clipboard is unavailable', async () => {
    const shown = document.createElement('span');
    shown.textContent = 'danac';
    document.body.append(shown);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyShownValue(shown, 'danac')).resolves.toBe('copied');
    window.getSelection()?.selectAllChildren(shown);
    await expect(copyShownValue(shown, 'danac')).resolves.toBe('skipped');
    window.getSelection()?.removeAllRanges();
    vi.stubGlobal('navigator', {});
    await expect(copyShownValue(shown, 'danac')).resolves.toBe('selected');
    expect(window.getSelection()?.toString()).toBe('danac');
    window.getSelection()?.removeAllRanges();
    shown.remove();
  });
});
