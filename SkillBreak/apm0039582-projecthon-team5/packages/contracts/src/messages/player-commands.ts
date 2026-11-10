import type { Command } from './envelope';
import type { PuzzleInput } from './value-types';

/** userId comes from gateway authentication; input must not be copied to public views/logs. */
export type PlayerCommand =
  | Command<'StartSession', { userId: string; scriptSlug: string }>
  | Command<'SubmitInput', { userId: string; puzzleKey: string; input: PuzzleInput }>
  | Command<'OpenDoor', { userId: string; roomKey: string }>
  | Command<'EnterRoom', { userId: string; roomKey: string }>
  | Command<'RequestHint', { userId: string }>
  | Command<'PlayerReconnected', { userId: string }>
  | Command<'AbandonSession', { userId: string }>;
