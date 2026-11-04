import type { EvaluationView, SessionView } from '../src';
import { view, commandId } from './fixtures';

// @ts-expect-error rejected requires an explicit reason
const rejection: EvaluationView = { commandId, output: '', verdict: 'rejected', reason: null };
// @ts-expect-error solved cannot carry a rejection reason
const solved: EvaluationView = { commandId, output: '', verdict: 'solved', reason: 'wrongAnswer' };
// @ts-expect-error unknown reason must not be silently interpreted
const unknown: EvaluationView = { commandId, output: '', verdict: 'rejected', reason: 'unknown' };
// @ts-expect-error private template material is not a public field
const privateView: SessionView = { ...view, solutionRef: 'private' };
// @ts-expect-error reset is an action, not a puzzle status
const reset: SessionView = { ...view, currentRoom: { ...view.currentRoom, puzzles: [{ ...view.currentRoom.puzzles[0], status: 'reset' }] } };
void [rejection, solved, unknown, privateView, reset];
