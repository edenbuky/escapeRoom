import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import type { ComponentFactory } from '../src/modules/components/components';
import { room1Script, room1Templates, ROOM1 } from '../src/modules/script-catalog/room1';
import type { CatalogResolver } from '../src/modules/sessions/catalog-resolver';
import type { Snapshot } from '../src/modules/sessions/core/state';
import { transition } from '../src/modules/sessions/core/transition';
import type { EngineRepository } from '../src/modules/sessions/engine.repository';
import { EngineService } from '../src/modules/sessions/engine.service';

// No database on this path: the manager, repository and catalog are stubs; transition and the log lines are real.
const content = { script: room1Script, templates: Object.fromEntries(room1Templates.map(template => [`${template.key}@${template.version}`, template])) };
const now = new Date('2026-11-04T07:00:00Z');
const start = { type: 'StartSession' as const, sessionId: 'session-1', messageId: 'start-1', payload: { userId: 'owner-1', scriptSlug: 'escape-room' } };

function engineWith(snapshot: Snapshot | null, evaluate: jest.Mock) {
  const manager = { query: jest.fn().mockResolvedValue([]), getRepository: () => ({ create: (row: unknown) => row, insert: jest.fn() }) };
  const repository = { load: jest.fn().mockResolvedValue(snapshot), save: jest.fn() };
  const catalog = { bySlug: jest.fn().mockResolvedValue(content), version: jest.fn().mockResolvedValue(content) };
  const engine = new EngineService({} as DataSource, catalog as unknown as CatalogResolver, { evaluate } as unknown as ComponentFactory,
    repository as unknown as EngineRepository, () => now);
  return (message: Parameters<EngineService['handle']>[0]) => engine['apply'](manager as unknown as EntityManager, message);
}

test('start game and evaluated answers are logged by keys, verdict and reason, never the answer or the revealed password', async () => {
  const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  try {
    await engineWith(null, jest.fn())(start);
    expect(log.mock.calls).toEqual([['Game started sessionId=session-1 roomKey=room-1']]);
    log.mockClear();

    const snapshot = transition(null, start, content, now).next!;
    snapshot.puzzles.find(puzzle => puzzle.key === 'hash-cracker')!.status = 'open';
    const evaluate = jest.fn()
      .mockResolvedValueOnce({ verdict: 'rejected', reason: 'wrongAnswer', output: '' })
      .mockResolvedValueOnce({ verdict: 'solved', reason: null, output: ROOM1.danaPassword });
    const apply = engineWith(snapshot, evaluate);
    for (const [messageId, answer] of [['submit-1', '0'.repeat(64)], ['submit-2', ROOM1.danaPasswordSha256]]) {
      await apply({ type: 'SubmitInput', sessionId: 'session-1', messageId,
        payload: { userId: 'owner-1', puzzleKey: 'hash-cracker', input: { kind: 'answer', answer } } });
    }
    expect(log.mock.calls).toEqual([
      ['Answer evaluated sessionId=session-1 roomKey=room-1 puzzleKey=hash-cracker verdict=rejected reason=wrongAnswer'],
      ['Answer evaluated sessionId=session-1 roomKey=room-1 puzzleKey=hash-cracker verdict=solved reason=none'],
    ]);
    const logged = JSON.stringify(log.mock.calls);
    for (const secret of [ROOM1.danaPassword, ROOM1.danaPasswordSha256, 'owner-1', '0'.repeat(64)]) expect(logged).not.toContain(secret);
  } finally { log.mockRestore(); }
});
