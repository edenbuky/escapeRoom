import { validateSql } from '../src/modules/sandbox/sql-policy';
import { SandboxExecutionError } from '../src/modules/sandbox/sandbox-errors';

describe('SQL statement policy', () => {
  test.each(['', ' \n ', '-- nothing', '/* nothing ; */', ';', 'SELECT 1; SELECT 2', 'x'.repeat(4097)])(
    'rejects invalid input %s', command => {
      expect(() => validateSql(command)).toThrow(new SandboxExecutionError('policyBlocked'));
    },
  );
  test('distinguishes syntax errors from statement-policy rejection', () => {
    expect(() => validateSql('SELECT FROM')).toThrow(new SandboxExecutionError('syntaxError'));
  });
  test.each([
    'SELECT 1;', "SELECT ';' AS value -- ;\n;",
    "SELECT '/* ; */', 'hello'';world' /* ; */",
    'SELECT e.username FROM employees e JOIN logs l ON e.id=l.employee_id WHERE e.id IN (SELECT id FROM employees);',
    "SELECT E'hello\\\\world', 'λ😀'",
    `SELECT '${'a'.repeat(4087)}'`,
  ])('accepts one complete statement %s', command => {
    expect(() => validateSql(command)).not.toThrow();
  });
  it('never lets a configured policy exceed the engine cap', () => {
    expect(() => validateSql(`SELECT '${'a'.repeat(4090)}'`, 10000)).toThrow();
    expect(() => validateSql('SELECT 1', 7)).toThrow();
  });
});
