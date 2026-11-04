import type { ComponentType } from 'react';
import { DanaLoginScreen } from './dana-login';
import { HashCrackerScreen } from './hash-cracker';
import { IdanSqlScreen } from './idan-sql';
import type { PuzzleScreenProps } from './types';

/** Room 1 puzzle screens by puzzle key, as the session view names them. */
export const ROOM_1_SCREENS: Record<string, ComponentType<PuzzleScreenProps>> = {
  'idan-db': IdanSqlScreen,
  'hash-cracker': HashCrackerScreen,
  'dana-login': DanaLoginScreen,
};
