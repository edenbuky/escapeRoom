import type { ComponentType } from 'react';
import type { PuzzleScreenProps } from '../types';

/**
 * A slot a later Room 2 task replaces in `ROOM_2_SCREENS`. It only says the screen is not built yet:
 * it submits nothing and decides nothing about the puzzle.
 */
export function placeholderScreen(title: string): ComponentType<PuzzleScreenProps> {
  function PlaceholderScreen({ close }: PuzzleScreenProps) {
    return <>
      <div className="modal-title">{title}</div>
      <div className="t5-panel-state" data-slot="placeholder"><p>Unavailable</p><button type="button" onClick={close}>← Back</button></div>
      <div className="modal-note">Click outside the window or press Esc to go back</div>
    </>;
  }
  PlaceholderScreen.displayName = `PlaceholderScreen(${title})`;
  return PlaceholderScreen;
}
