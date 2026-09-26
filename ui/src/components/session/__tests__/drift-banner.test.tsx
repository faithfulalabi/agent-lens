import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { DriftBanner } from '../DriftBanner';

/*
 * AC2's alarm and AC3's silence, rendered. Props-in, so `renderToStaticMarkup`
 * can read it — the page module that owns the row cannot be rendered past its
 * pending branch. `follow-pill.test.tsx` is the shape.
 */

describe('the drift banner raises on the row it is given (AC2)', () => {
  it('carries the slot the render gate drives and the copy, with no link to a raw API route', () => {
    const markup = renderToStaticMarkup(
      <DriftBanner sessionId="session-a" hasDrift harnessVersion="2.2.0" />,
    );

    expect(markup).toContain('data-slot="drift-banner"');
    expect(markup).toContain('aria-label="Dismiss unrecognized records notice"');
    expect(markup, 'louder than the truncation strip next door').toContain('role="alert"');
    expect(markup).toContain('Unrecognized records in this session.');
    expect(markup, 'the culprit release is the whole point of the alarm').toContain('2.2.0');
    // A browser navigation to /api/* carries no token and always 401s (task 0.16).
    expect(markup).not.toContain('href="/api/');
  });

  it('still raises when the transcript named no version', () => {
    const markup = renderToStaticMarkup(
      <DriftBanner sessionId="session-a" hasDrift harnessVersion={null} />,
    );
    expect(markup).toContain('data-slot="drift-banner"');
    expect(markup).not.toContain('null');
  });
});

describe('the drift banner is silent on a clean session (AC3)', () => {
  it('renders nothing at all — no wrapper, no slot, no border', () => {
    // Total, on `components.test.tsx:105-112`'s shape: an empty string is the
    // only reading that proves no strip was drawn. A "does not contain the
    // copy" assertion would pass over an empty bordered box.
    expect(
      renderToStaticMarkup(
        <DriftBanner sessionId="session-a" hasDrift={false} harnessVersion="2.1.212" />,
      ),
    ).toBe('');
    expect(
      renderToStaticMarkup(
        <DriftBanner sessionId="session-a" hasDrift={false} harnessVersion={null} />,
      ),
    ).toBe('');
  });
});
