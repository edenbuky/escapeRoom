import type { GameEvent, PlayerCommand, PuzzleView, RoomView } from '@team5/contracts';
import type { SandboxOutcome } from '../../sandbox/sandbox.contracts';
import type { StateDef } from '../../script-catalog/catalog.types';
import { commandRejection } from './eligibility';
import { sandboxIdentity, uuidV5 } from './ids';
import type { Evaluation, PuzzleState, ResolvedScript, Snapshot, TransitionResult } from './state';

export type EngineMessage = PlayerCommand | { type: 'SandboxOutcome'; messageId: string; sessionId: string; payload: SandboxOutcome };

function puzzleView(puzzle: PuzzleState): PuzzleView {
  return { key: puzzle.key, family: puzzle.family, status: puzzle.status,
    sandbox: { ...puzzle.sandbox }, latestResult: puzzle.latestResult ? { ...puzzle.latestResult } : null };
}

export function transition(snapshot: Snapshot | null, message: EngineMessage, content: ResolvedScript,
  now: Date, evaluation?: Evaluation): TransitionResult {
  const result: TransitionResult = { next: snapshot ? structuredClone(snapshot) : null,
    gameEvents: [], sandboxJobs: [], changed: false };
  const occurredAt = now.toISOString();
  const version = (snapshot?.version ?? 0) + 1;
  function emit<Type extends GameEvent['type']>(type: Type, payload: Extract<GameEvent, { type: Type }>['payload']) {
    const eventId = uuidV5(`${message.messageId}:${version}:${result.gameEvents.length}:${type}`);
    result.gameEvents.push({ type, payload, messageId: eventId, eventId,
      sessionId: message.sessionId, occurredAt, sessionVersion: version } as GameEvent);
  }
  function roomView(current: Snapshot, roomKey: string): RoomView {
    const room = content.script.states.find(state => state.key === roomKey);
    if (!room) throw new Error('Missing pinned room');
    return { key: room.key, files: structuredClone(room.files),
      puzzles: current.puzzles.filter(puzzle => puzzle.roomKey === roomKey).map(puzzleView) };
  }
  function addRoom(room: StateDef): PuzzleState[] {
    return room.puzzles.map(definition => {
      const template = content.templates[definition.templateRef];
      if (!template) throw new Error('Missing pinned template');
      return { key: definition.key, roomKey: room.key, family: template.engine, templateRef: definition.templateRef,
        status: 'locked', sandbox: { status: 'none', generation: template.engine === 'sql' ? 1 : 0 },
        latestResult: null, openedAt: null, attempts: 0, wrongAttempts: 0 };
    });
  }
  function destroy(puzzle: PuzzleState) {
    if (puzzle.family !== 'sql' || puzzle.sandbox.status === 'none') return;
    result.sandboxJobs.push({ ...sandboxIdentity(message.sessionId, puzzle.key, puzzle.sandbox.generation),
      jobId: uuidV5(`${message.messageId}:destroy:${puzzle.key}:${puzzle.sandbox.generation}`), operation: 'destroy' });
  }
  function open(puzzle: PuzzleState) {
    puzzle.status = 'open';
    puzzle.openedAt = occurredAt;
    const template = content.templates[puzzle.templateRef];
    if (template.engine === 'sql') {
      puzzle.sandbox.status = 'provisioning';
      result.sandboxJobs.push({ ...sandboxIdentity(message.sessionId, puzzle.key, puzzle.sandbox.generation),
        jobId: uuidV5(`${message.messageId}:provision:${puzzle.key}:${puzzle.sandbox.generation}`),
        operation: 'provision', imageDigest: template.definition.imageDigest,
        seedRef: template.definition.seedRef, policyRef: puzzle.templateRef });
    }
    emit('PuzzleOpened', { roomKey: puzzle.roomKey, puzzle: puzzleView(puzzle), openedAt: puzzle.openedAt });
  }
  function openEligible(current: Snapshot, room: StateDef) {
    for (const definition of room.puzzles) {
      const puzzle = current.puzzles.find(candidate => candidate.key === definition.key && candidate.roomKey === room.key)!;
      if (puzzle.status === 'locked' && definition.opensAfter.every(key => current.puzzles.some(candidate =>
        candidate.roomKey === room.key && candidate.key === key && candidate.status === 'solved'))) open(puzzle);
    }
  }
  function end(current: Snapshot, status: 'Expired' | 'Abandoned') {
    current.status = status;
    current.endedAt = occurredAt;
    current.puzzles.forEach(destroy);
    if (status === 'Expired') emit('SessionExpired', { endedAt: occurredAt });
    if (status === 'Abandoned') emit('SessionAbandoned', { endedAt: occurredAt });
  }
  if (message.type === 'StartSession') {
    if (snapshot) return result;
    const initial = content.script.states.find(state => state.key === content.script.initialState);
    if (!initial) throw new Error('Missing initial room');
    result.next = { id: message.sessionId, ownerId: message.payload.userId, scriptId: content.script.scriptId,
      scriptVersion: content.script.version, version, status: 'Active', roomKey: initial.key, visitedRooms: [initial.key],
      startedAt: occurredAt, deadlineAt: new Date(now.getTime() + content.script.durationMinutes * 60000).toISOString(),
      endedAt: null, puzzles: addRoom(initial) };
    emit('SessionStarted', { ownerId: result.next.ownerId, scriptId: result.next.scriptId,
      scriptVersion: result.next.scriptVersion, startedAt: occurredAt, deadlineAt: result.next.deadlineAt,
      room: roomView(result.next, initial.key) });
    openEligible(result.next, initial);
  } else {
    const current = result.next;
    if (!current || current.id !== message.sessionId) return result;
    if (message.type !== 'SandboxOutcome' && message.payload.userId !== current.ownerId) return result;
    const expired = current.status === 'Active' && now.getTime() >= Date.parse(current.deadlineAt);
    if (message.type === 'SandboxOutcome') {
      const outcome = message.payload;
      const puzzle = current.puzzles.find(candidate => candidate.key === outcome.puzzleKey);
      if (current.status !== 'Active' || !puzzle || puzzle.family !== 'sql' || puzzle.status === 'locked'
        || outcome.generation !== puzzle.sandbox.generation) return result;
      const identity = sandboxIdentity(current.id, puzzle.key, puzzle.sandbox.generation);
      if (outcome.podName !== identity.podName || outcome.namespace !== identity.namespace) return result;
      if (expired) end(current, 'Expired');
      else {
        const status = outcome.kind === 'ready' ? 'ready' : outcome.kind === 'failed' ? 'failed' : 'none';
        if (puzzle.sandbox.status === status) return result;
        puzzle.sandbox.status = status;
        emit('PuzzleOpened', { roomKey: puzzle.roomKey, puzzle: puzzleView(puzzle), openedAt: puzzle.openedAt! });
      }
    } else if (message.type === 'SubmitInput') {
      const reason = commandRejection(current, message.payload.puzzleKey, now);
      const outcome = reason ? { verdict: 'rejected' as const, reason, output: '' } : evaluation;
      if (!outcome) throw new Error('Evaluation required');
      const puzzle = current.puzzles.find(candidate => candidate.key === message.payload.puzzleKey);
      const evaluated = { ...outcome, commandId: message.messageId };
      emit('CommandEvaluated', { commandId: message.messageId, roomKey: puzzle?.roomKey ?? current.roomKey,
        puzzleKey: puzzle?.key ?? null, result: evaluated });
      if (puzzle) puzzle.latestResult = evaluated;
      if (expired) end(current, 'Expired');
      if (!reason && puzzle) {
        puzzle.attempts++;
        if (outcome.verdict === 'rejected' && outcome.reason === 'wrongAnswer') puzzle.wrongAttempts++;
        const room = content.script.states.find(state => state.key === puzzle.roomKey)!;
        if (outcome.verdict === 'ruined') throw new Error('Ruin handling is not implemented in Feature 1');
        if (outcome.verdict === 'solved' && puzzle.status !== 'solved') {
          puzzle.status = 'solved';
          emit('PuzzleSolved', { roomKey: room.key, puzzleKey: puzzle.key, solvedAt: occurredAt,
            solveSeconds: Math.max(0, Math.floor((now.getTime() - Date.parse(puzzle.openedAt!)) / 1000)),
            files: structuredClone(room.files) });
          openEligible(current, room);
          const target = room.transitions.find(candidate => candidate.on === 'AllSolved' && room.puzzles.every(definition =>
            current.puzzles.some(entry => entry.roomKey === room.key && entry.key === definition.key && entry.status === 'solved')));
          if (target && current.roomKey === room.key) {
            const nextRoom = content.script.states.find(state => state.key === target.to);
            if (!nextRoom) throw new Error('Missing target room');
            current.roomKey = nextRoom.key;
            if (!current.visitedRooms.includes(nextRoom.key)) {
              current.visitedRooms.push(nextRoom.key);
              current.puzzles.push(...addRoom(nextRoom));
            }
            emit('RoomEntered', { room: roomView(current, nextRoom.key), enteredAt: occurredAt });
            openEligible(current, nextRoom);
          }
        }
      }
    } else if (current.status === 'Active') {
      if (expired) end(current, 'Expired');
      else if (message.type === 'AbandonSession') end(current, 'Abandoned');
      else if (message.type === 'RequestHint') emit('CommandEvaluated', { commandId: message.messageId,
        roomKey: current.roomKey, puzzleKey: null,
        result: { commandId: message.messageId, verdict: 'rejected', reason: 'noHint', output: '' } });
    } else return result;
  }
  result.changed = true;
  result.next!.version = version;
  return result;
}