import { decodeSqlRows, validateHelperResult } from '../src/modules/sandbox/sql-result';
import { SandboxExecutionError } from '../src/modules/sandbox/sandbox-errors';

const commandId = 'c3def05c-d3d2-48bd-aeef-111111111111';
const envelope = (stdout = 'value\nhello\n', stderr = '') => ({
  version: 1, commandId, stdout, stderr, exitCode: 0, timedOut: false, truncated: false,
});

describe('escaped positional SQL results', () => {
  it('preserves duplicate headers, null, empty, literal null, escapes and Unicode', () => {
    expect(decodeSqlRows('x\tx\tx\tx\tx\tx\n\\N\t\t\\\\N\t\\\\\\t\\r\\n\tλ😀\t\\\\u0061\n'))
      .toEqual([[null, '', '\\N', '\\\t\r\n', 'λ😀', '\\u0061']]);
  });
  it('does not interpret Unicode escape text as JSON', () => {
    expect(decodeSqlRows('x\n\\\\u0061\n')).toEqual([['\\u0061']]);
  });
  test.each(['value', 'value\npartial', 'a\tb\none\n', 'value\nbad\\q\n', 'value\n\\Nextra\n', 'value\nbad\r\n'])(
    'rejects malformed or partial records %s', stdout => {
      expect(() => decodeSqlRows(stdout)).toThrow(new SandboxExecutionError('runtimeUnavailable'));
    },
  );
  it('requires a header but permits a header without rows', () => {
    expect(decodeSqlRows('')).toEqual([]);
    expect(decodeSqlRows('value\n')).toEqual([]);
  });
  test.each([65535, 65536, 65537])('enforces combined UTF-8 bytes at %i', bytes => {
    const result = envelope('v\nλ\n', 'x'.repeat(bytes - 5));
    if (bytes <= 65536) expect(validateHelperResult(result, commandId).stderr).toHaveLength(bytes - 5);
    else expect(() => validateHelperResult(result, commandId)).toThrow();
  });
  test.each([
    { version: 2 }, { commandId: 'other' }, { stdout: 1 }, { stderr: null },
    { exitCode: 0.1 }, { exitCode: undefined }, { timedOut: 1 }, { truncated: 'false' },
    { stdout: '' }, { stdout: 'x\npartial' }, { stdout: 'x\ty\none\n' },
    { timedOut: true, exitCode: 0 },
  ])('rejects malformed envelope %s', override => {
    expect(() => validateHelperResult({ ...envelope(), ...override }, commandId)).toThrow();
  });
  it('rejects transport-envelope overflow independently of output size', () => {
    expect(() => validateHelperResult({ ...envelope(), extra: 'x'.repeat(512 * 1024) }, commandId)).toThrow();
  });
  it('retains explicit incomplete/failure flags and never invents success', () => {
    for (const flags of [{ timedOut: true, exitCode: null }, { truncated: true }, { exitCode: 1 }]) {
      expect(validateHelperResult({ ...envelope(), ...flags }, commandId)).toMatchObject(flags);
    }
    expect(validateHelperResult({ ...envelope(''), exitCode: null, timedOut: true }, commandId).exitCode).toBeNull();
  });
});
