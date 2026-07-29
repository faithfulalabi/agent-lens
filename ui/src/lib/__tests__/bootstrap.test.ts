import { describe, it, expect } from 'vitest';
import { BootstrapMissingError, readBootstrap, type Bootstrap } from '../bootstrap';

/*
 * AC1 (token half) — the UI reads its credential from the same-origin
 * bootstrap, and fails loudly when the page was not served by agent-lens.
 *
 * `src/server/static-ui.ts` injects `window.__AGENT_LENS__` and refuses to
 * serve a page it could not inject into, so the missing case is only reachable
 * when the bundle is opened outside the server. The failure has to name that,
 * because the alternative symptom is every request 401ing with no explanation.
 *
 * There is no DOM in this project, so the carrier object is injected. That is
 * the same seam Task 5.2's page tests will use.
 */

const INJECTED: Bootstrap = Object.freeze({
  token: 'tok-abc-123',
  tokenHeader: 'x-agentlens-token',
});

describe('readBootstrap', () => {
  it('returns the injected object when the page carries one', () => {
    expect(readBootstrap({ __AGENT_LENS__: INJECTED })).toEqual(INJECTED);
    expect(Object.isFrozen(readBootstrap({ __AGENT_LENS__: INJECTED }))).toBe(true);
  });

  it('throws a named, actionable error when the global is absent', () => {
    expect(() => readBootstrap({})).toThrow(BootstrapMissingError);
    try {
      readBootstrap({});
      expect.unreachable('readBootstrap({}) resolved instead of throwing');
    } catch (error) {
      expect(error).toBeInstanceOf(BootstrapMissingError);
      expect((error as Error).name).toBe('BootstrapMissingError');
      expect(
        (error as Error).message,
        'the message must name the server module that injects the global — ' +
          'otherwise the only symptom is a wall of 401s',
      ).toContain('src/server/static-ui.ts');
      expect((error as Error).message).toContain('__AGENT_LENS__');
    }
  });

  it.each([
    { label: 'no token', value: { tokenHeader: 'x-agentlens-token' } },
    { label: 'empty token', value: { token: '', tokenHeader: 'x-agentlens-token' } },
    { label: 'no tokenHeader', value: { token: 'tok' } },
    { label: 'empty tokenHeader', value: { token: 'tok', tokenHeader: '' } },
  ])('rejects a malformed bootstrap ($label)', ({ value }) => {
    expect(() => readBootstrap({ __AGENT_LENS__: value as Bootstrap })).toThrow(
      BootstrapMissingError,
    );
  });

  it('does not cache across explicit scopes', () => {
    const first: Bootstrap = { token: 'one', tokenHeader: 'x-a' };
    const second: Bootstrap = { token: 'two', tokenHeader: 'x-b' };
    expect(readBootstrap({ __AGENT_LENS__: first }).token).toBe('one');
    expect(readBootstrap({ __AGENT_LENS__: second }).token).toBe('two');
    expect(readBootstrap({ __AGENT_LENS__: first }).token).toBe('one');
  });
});
