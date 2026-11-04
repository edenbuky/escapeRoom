import type { SubmitResult } from '../../api';

const MESSAGES: Record<Exclude<SubmitResult, 'accepted'>['error'], string> = {
  network: 'Connection lost. Try again.',
  unauthorized: 'Your sign-in expired. Sign in again.',
  forbidden: 'This action is not allowed.',
  notFound: 'Game session not found.',
  conflict: 'This puzzle is not accepting answers right now.',
  unavailable: 'Game service unavailable. Try again.',
};

/** English text for a rejected submit; the result itself still comes only from the session view. */
export function submitErrorMessage(result: Exclude<SubmitResult, 'accepted'>): string {
  return MESSAGES[result.error];
}
