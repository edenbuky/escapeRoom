import type { EvaluationView, PuzzleView, RoomFile, RoomView, SessionView } from '@team5/contracts';
import type { ProjectionRecord } from './projection.repository';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid projection object');
  return value as Record<string, unknown>;
}
export function text(value: unknown, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.length)) throw new Error('Invalid projection text');
  return value;
}
export function uuid(value: unknown): string {
  const result = text(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new Error('Invalid projection identity');
  }
  return result.toLowerCase();
}
export function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('Invalid projection integer');
  return value;
}
export function timestamp(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(result) || !Number.isFinite(Date.parse(result))
    || new Date(result).toISOString() !== result.replace(/(?<=:\d\d)Z$/, '.000Z')) throw new Error('Invalid projection timestamp');
  return result;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  const found = choices.find(candidate => candidate === value);
  if (found === undefined) throw new Error('Invalid projection enum');
  return found;
}
function unique<T>(value: unknown, parse: (item: unknown) => T, key: (item: T) => string): T[] {
  if (!Array.isArray(value)) throw new Error('Invalid projection list');
  const items = value.map(parse);
  if (new Set(items.map(key)).size !== items.length) throw new Error('Duplicate projection key');
  return items;
}
export function evaluation(value: unknown): EvaluationView | null {
  if (value === null) return null;
  const item = object(value);
  const commandId = uuid(item.commandId);
  const output = text(item.output, true);
  if (item.verdict === 'rejected') return { commandId, output, verdict: 'rejected',
    reason: choice(item.reason, ['wrongAnswer', 'policyBlocked', 'sandboxRestarting', 'timeUp', 'noHint', 'puzzleLocked', 'sessionEnded']) };
  if (item.reason !== null) throw new Error('Invalid result reason');
  return { commandId, output, verdict: choice(item.verdict, ['progress', 'solved', 'ruined']), reason: null };
}
export function puzzle(value: unknown): PuzzleView {
  const item = object(value);
  const sandbox = object(item.sandbox);
  return { key: text(item.key), family: choice(item.family, ['sql', 'terminal-git', 'hash', 'rsa', 'tls', 'answer']),
    status: choice(item.status, ['locked', 'open', 'solved']),
    sandbox: { generation: integer(sandbox.generation), status: choice(sandbox.status, ['none', 'provisioning', 'ready', 'failed']) },
    latestResult: evaluation(item.latestResult) };
}
export function files(value: unknown): RoomFile[] {
  return unique(value, raw => { const item = object(raw); return { name: text(item.name), content: text(item.content, true) }; }, item => item.name);
}
export function room(value: unknown): RoomView {
  const item = object(value);
  return { key: text(item.key), puzzles: unique(item.puzzles, puzzle, item => item.key), files: files(item.files) };
}
export function publicView(value: unknown): SessionView {
  const item = object(value);
  const status = choice(item.status, ['Active', 'Abandoned', 'Escaped', 'Expired']);
  const endedAt = item.endedAt === null ? null : timestamp(item.endedAt);
  if ((status === 'Active') !== (endedAt === null)) throw new Error('Invalid session end state');
  if (!Array.isArray(item.revealedHints) || item.revealedHints.length) throw new Error('Hints are outside projection scope');
  return { sessionId: uuid(item.sessionId), version: integer(item.version, 1), status, currentRoom: room(item.currentRoom),
    deadlineAt: timestamp(item.deadlineAt), endedAt, latestResult: evaluation(item.latestResult), revealedHints: [] };
}

export function reduceProjection(current: ProjectionRecord | null, input: unknown): { ownerId: string; view: SessionView } {
  const event = object(input), payload = object(event.payload);
  const sessionId = uuid(event.sessionId), version = integer(event.sessionVersion, 1);
  timestamp(event.occurredAt);
  if (event.type === 'SessionStarted') {
    if (current) throw new Error('Session already projected');
    timestamp(payload.startedAt);
    text(payload.scriptId);
    integer(payload.scriptVersion, 1);
    const firstRoom = room(payload.room);
    for (const item of firstRoom.puzzles) {
      if (item.latestResult !== null) throw new Error('Unexpected initial puzzle result');
    }
    return { ownerId: uuid(payload.ownerId), view: publicView({ sessionId, version, status: 'Active',
      currentRoom: firstRoom, deadlineAt: timestamp(payload.deadlineAt), endedAt: null, latestResult: null, revealedHints: [] }) };
  }
  if (!current) throw new Error('Projection prerequisite missing');
  const view = publicView(current.view);
  if (view.sessionId !== sessionId) throw new Error('Projection session mismatch');
  if (view.status !== 'Active' && event.type !== 'CommandEvaluated') throw new Error('Terminal projection transition');
  switch (event.type) {
    case 'PuzzleOpened': {
      timestamp(payload.openedAt);
      if (text(payload.roomKey) !== view.currentRoom.key) throw new Error('Projection room mismatch');
      const next = puzzle(payload.puzzle);
      const index = view.currentRoom.puzzles.findIndex(item => item.key === next.key);
      if (index < 0) throw new Error('Projection puzzle missing');
      const previous = view.currentRoom.puzzles[index];
      if (previous.family !== next.family || next.sandbox.generation < previous.sandbox.generation
        || (previous.status === 'solved' && next.status !== 'solved') || (previous.status === 'open' && next.status === 'locked')) {
        throw new Error('Projection puzzle regression');
      }
      view.currentRoom.puzzles[index] = next;
      break;
    }
    case 'CommandEvaluated': {
      const result = evaluation(payload.result);
      if (!result || result.commandId !== uuid(payload.commandId)) throw new Error('Projection result mismatch');
      if (view.status !== 'Active' && result.verdict !== 'rejected') throw new Error('Terminal projection result');
      const roomKey = text(payload.roomKey);
      const puzzleKey = payload.puzzleKey === null ? null : text(payload.puzzleKey);
      view.latestResult = result;
      if (roomKey === view.currentRoom.key && puzzleKey !== null) {
        const target = view.currentRoom.puzzles.find(item => item.key === puzzleKey);
        if (!target) throw new Error('Projection puzzle missing');
        target.latestResult = result;
      }
      break;
    }
    case 'PuzzleSolved': {
      timestamp(payload.solvedAt);
      integer(payload.solveSeconds);
      if (text(payload.roomKey) !== view.currentRoom.key) throw new Error('Projection room mismatch');
      const target = view.currentRoom.puzzles.find(item => item.key === text(payload.puzzleKey));
      if (!target || target.status !== 'open') throw new Error('Projection puzzle is not open');
      target.status = 'solved';
      view.currentRoom.files = files(payload.files);
      break;
    }
    case 'RoomEntered':
      timestamp(payload.enteredAt);
      view.currentRoom = room(payload.room);
      break;
    case 'SessionAbandoned':
      view.status = 'Abandoned';
      view.endedAt = timestamp(payload.endedAt);
      break;
    default: throw new Error('Unsupported projection transition');
  }
  view.version = version;
  return { ownerId: current.ownerId, view };
}
