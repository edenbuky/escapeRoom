import type { ComponentType } from 'react';
import { CaptureViewerScreen } from './capture-viewer';
import { DanaLoginScreen } from './dana-login';
import { DoorKeypadScreen } from './door-keypad';
import { HashCrackerScreen } from './hash-cracker';
import { IdanSqlScreen } from './idan-sql';
import { NathanelGitScreen } from './nethanel-git';
import { RsaDecryptorScreen } from './rsa-decryptor';
import { TlsDecryptorScreen } from './tls-decryptor';
import type { PuzzleScreenProps } from './types';

/** Room 1 puzzle screens by puzzle key, as the session view names them. */
export const ROOM_1_SCREENS: Record<string, ComponentType<PuzzleScreenProps>> = {
  'idan-db': IdanSqlScreen,
  'hash-cracker': HashCrackerScreen,
  'dana-login': DanaLoginScreen,
};

/**
 * Room 2 screens by slot key: a puzzle key from the session view, or `capture-viewer` for the desktop's pcap icon.
 * Every slot starts as a placeholder; the task that builds the screen swaps its line for the real component:
 * R2-03 `nethanel-git`, R2-05 `capture-viewer`, R2-06 `rsa-decryptor`, R2-07 `tls-decryptor`, R2-08 `door`.
 */
export const ROOM_2_SCREENS: Record<string, ComponentType<PuzzleScreenProps>> = {
  'nethanel-git': NathanelGitScreen,
  'capture-viewer': CaptureViewerScreen,
  'rsa-decryptor': RsaDecryptorScreen,
  'tls-decryptor': TlsDecryptorScreen,
  door: DoorKeypadScreen,
};
