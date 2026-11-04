import type { PuzzleInput } from '../../contracts/outputs';
import type { SessionView } from '../../contracts/view';
import type { SubmitResult } from '../api';
export type { SubmitResult };
export interface PuzzleScreenProps {
  puzzle: SessionView['currentRoom']['puzzles'][number];
  view: SessionView;
  submit: (input: PuzzleInput) => Promise<SubmitResult>;
  close: () => void;
}