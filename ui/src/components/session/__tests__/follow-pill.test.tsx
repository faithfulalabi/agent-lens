import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { pillLabel } from '../../../lib/live';
import { FollowPill } from '../FollowPill';

/*
 * AC3's pill, rendered. Props-in, so `renderToStaticMarkup` can read it — the
 * page module that owns the state cannot be rendered past its pending branch.
 */

describe('the follow pill draws only while paused (AC3)', () => {
  it.each([true, false])('renders nothing with an empty backlog (following: %s)', (following) => {
    expect(renderToStaticMarkup(<FollowPill label={pillLabel({ following, pending: 0 })} />)).toBe(
      '',
    );
  });

  it('spells the backlog, and carries the slot the render gate drives', () => {
    const markup = renderToStaticMarkup(
      <FollowPill label={pillLabel({ following: false, pending: 7 })} />,
    );

    expect(markup).toContain('data-slot="follow-pill"');
    expect(markup).toContain('Following paused — 7 new events');
    expect(markup, 'the pill is the resume control, so it has to be a button').toContain(
      '<button type="button"',
    );
  });

  it('says "1 new event" rather than "1 new events"', () => {
    const markup = renderToStaticMarkup(
      <FollowPill label={pillLabel({ following: false, pending: 1 })} />,
    );
    expect(markup).toContain('1 new event<');
  });
});
