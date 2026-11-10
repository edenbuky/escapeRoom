import { createHash } from 'node:crypto';
import { ArgumentsHost, Logger, NotFoundException } from '@nestjs/common';
import { CatalogErrorFilter } from '../src/modules/script-catalog/catalog.controller';
import type { PuzzleInput } from '@team5/contracts';
import { ROOM1, room1GameplayScript, room1Script, room1Templates } from '../src/modules/script-catalog/room1';
import { matchesInternalToken } from '../src/config/internal-token';

describe('published room-1 content adapted from Amit source', () => {
  test('new gameplay version removes locks and automatic transitions without mutating v1', () => {
    expect(room1GameplayScript.version).toBe(3);
    expect(room1GameplayScript.states[0].puzzles.every(puzzle => puzzle.opensAfter.length === 0)).toBe(true);
    expect(room1GameplayScript.states[0].transitions).toEqual([]);
    expect(room1Script.states[0].transitions).toEqual([{ on: 'AllSolved', to: 'room-2' }]);
  });
  test('has three ordered puzzles, a non-final room 2 and a single 45-minute clock', () => {
    expect(room1Script.durationMinutes).toBe(45);
    expect(room1Script.initialState).toBe('room-1');
    expect(room1Script.states[0].puzzles.map(puzzle => puzzle.key)).toEqual(['idan-db', 'hash-cracker', 'dana-login']);
    expect(room1Script.states[0].puzzles.map(puzzle => puzzle.opensAfter)).toEqual([[], ['idan-db'], ['hash-cracker']]);
    expect(room1Script.states[0].transitions).toEqual([{ on: 'AllSolved', to: 'room-2' }]);
    expect(room1Script.states[1]).toMatchObject({ key: 'room-2', puzzles: [], transitions: [] });
    expect(room1Script.finalStates).toEqual([]);
    expect(room1Script.states[0].puzzles.map(puzzle => puzzle.templateRef))
      .toEqual(room1Templates.map(template => `${template.key}@${template.version}`));
  });
  test('keeps matching solutions in private templates, not script or browser contracts', () => {
    expect(JSON.stringify(room1Script)).not.toContain(ROOM1.danaPassword);
    expect(JSON.stringify(room1Script)).not.toContain(ROOM1.danaPasswordSha256);
    expect(createHash('sha256').update(ROOM1.danaPassword).digest('hex')).toBe(ROOM1.danaPasswordSha256);
    expect(room1Templates[0].definition).toMatchObject({
      goal: { value: ROOM1.danaPasswordSha256 }, policy: { readOnly: true }, seedRef: 'room1-sql-v1',
    });
    expect(room1Templates[1].definition).toMatchObject({ seed: {
      expectedHashHex: ROOM1.danaPasswordSha256, revealedPassword: ROOM1.danaPassword,
    } });
    expect(room1Templates[2].definition).toMatchObject({ seed: { fields: {
      username: ROOM1.danaUsername, password: ROOM1.danaPassword,
    } } });
  });
  test('input policies use the unchanged baseline PuzzleInput discriminators', () => {
    const inputs: PuzzleInput[] = [
      { kind: 'command', command: 'SELECT 1' },
      { kind: 'answer', answer: ROOM1.danaPasswordSha256 },
      { kind: 'credentials', username: ROOM1.danaUsername, password: ROOM1.danaPassword },
    ];
    for (const [index, input] of inputs.entries()) {
      const schema = room1Templates[index].definition.inputSchema;
      expect(schema.required).toEqual(Object.keys(input));
      expect(schema.properties).toMatchObject({ kind: { const: input.kind } });
      expect(Object.keys(schema.properties as object)).toEqual(Object.keys(input));
      expect(schema.additionalProperties).toBe(false);
    }
  });
});

test('internal token comparison rejects missing, duplicate and incorrect headers', () => {
  const token = Buffer.alloc(32, 7).toString('base64');
  expect(matchesInternalToken(token, token)).toBe(true);
  for (const received of [undefined, [token, token], '', token.slice(1), Buffer.alloc(32, 8).toString('base64')]) {
    expect(matchesInternalToken(received, token)).toBe(false);
  }
});

test('catalog filter logs unexpected failures by name and code and keeps the bare status body', () => {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const json = jest.fn();
  const response: { setHeader: jest.Mock; status: jest.Mock; json: jest.Mock } = { setHeader: jest.fn(), status: jest.fn(), json };
  response.setHeader.mockReturnValue(response);
  response.status.mockReturnValue(response);
  const host = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
  new CatalogErrorFilter().catch(Object.assign(new Error('private SQL'), { code: '42P01' }), host);
  expect(response.status).toHaveBeenCalledWith(503);
  expect(json).toHaveBeenCalledWith({ statusCode: 503 });
  expect(warn).toHaveBeenCalledWith('Catalog request failed: Error code=42P01');
  new CatalogErrorFilter().catch(new NotFoundException(), host);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
  warn.mockRestore();
});
