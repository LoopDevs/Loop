// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Card } from '../Card';

afterEach(cleanup);

// FE-31: `interactive` advertises clickability (hover-lift + cursor-pointer)
// but historically shipped as a bare <div onClick> — invisible to keyboard
// and screen-reader users. An interactive Card must expose button semantics
// and activate on Enter/Space; a non-interactive Card must be left untouched.
describe('Card — interactive keyboard/role scaffolding (FE-31)', () => {
  it('exposes button role + tabIndex=0 when interactive', () => {
    render(
      <Card interactive onClick={() => {}}>
        row
      </Card>,
    );
    const el = screen.getByRole('button', { name: /row/ });
    expect(el.getAttribute('tabindex')).toBe('0');
  });

  it('activates onClick on Enter and Space (keyboard parity with a mouse tap)', () => {
    const onClick = vi.fn();
    render(
      <Card interactive onClick={onClick}>
        row
      </Card>,
    );
    const el = screen.getByRole('button', { name: /row/ });
    fireEvent.keyDown(el, { key: 'Enter' });
    fireEvent.keyDown(el, { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('does not activate on other keys', () => {
    const onClick = vi.fn();
    render(
      <Card interactive onClick={onClick}>
        row
      </Card>,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: /row/ }), { key: 'a' });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('leaves a non-interactive Card without button role or focusability', () => {
    render(<Card onClick={() => {}}>plain</Card>);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('plain').getAttribute('tabindex')).toBeNull();
  });

  it('still fires a caller-supplied onKeyDown alongside activation', () => {
    const onClick = vi.fn();
    const onKeyDown = vi.fn();
    render(
      <Card interactive onClick={onClick} onKeyDown={onKeyDown}>
        row
      </Card>,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: /row/ }), { key: 'Enter' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('honors an explicit role/tabIndex override (e.g. a Card that is really a link)', () => {
    render(
      <Card interactive role="link" tabIndex={-1} onClick={() => {}}>
        link-card
      </Card>,
    );
    const el = screen.getByRole('link', { name: /link-card/ });
    expect(el.getAttribute('tabindex')).toBe('-1');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
