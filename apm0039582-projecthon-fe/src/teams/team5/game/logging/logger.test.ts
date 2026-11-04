import { logger } from './logger';

describe('logger', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('writes the event with only the known context keys', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    logger.info('input accepted', { sessionId: 's-1', commandId: 'c-1', password: 'secret' } as never);
    expect(info).toHaveBeenCalledWith('[team5] input accepted', { sessionId: 's-1', commandId: 'c-1' });
  });

  it('writes failures as warnings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    logger.warn('input failed', { puzzleKey: 'idan-db', status: 503 });
    expect(warn).toHaveBeenCalledWith('[team5] input failed', { puzzleKey: 'idan-db', status: 503 });
  });
});
