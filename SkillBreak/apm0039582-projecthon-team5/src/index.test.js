const { helloWorld } = require('./index');

describe('helloWorld', () => {
  test('returns default greeting', () => {
    expect(helloWorld()).toBe('Hello, World!');
  });

  test('returns personalized greeting', () => {
    expect(helloWorld('TDP')).toBe('Hello, TDP!');
  });
});
