export function trimSingleLineInput(value: string): string {
  return value.trim();
}

export async function copyTextToClipboard(value: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch (error) {
    if (
      error instanceof DOMException &&
      ['NotAllowedError', 'NotSupportedError', 'SecurityError'].includes(error.name)
    ) {
      return false;
    }

    throw error;
  }
}

/**
 * Click-to-copy on a value shown on screen (no separate Copy button, as in the design HTML).
 * A click that ends a text selection does not copy; when the clipboard is unavailable the value is selected
 * so the player can copy it manually.
 */
export async function copyShownValue(shown: Element, value: string): Promise<'copied' | 'selected' | 'skipped'> {
  if (window.getSelection()?.toString()) return 'skipped';
  if (await copyTextToClipboard(value).catch(() => false)) return 'copied';
  window.getSelection()?.selectAllChildren(shown);
  return 'selected';
}
