// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Avatar } from '../Avatar';

afterEach(cleanup);

describe('Avatar', () => {
  it('renders an image when src is provided', () => {
    render(<Avatar name="Ada Lovelace" src="https://x.test/a.png" />);
    const img = screen.getByAltText('Ada Lovelace');
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe('https://x.test/a.png');
    // no initials disc when an image is shown
    expect(screen.queryByText('AL')).toBeNull();
  });

  it("falls the img alt back to 'Account' when there is no name", () => {
    render(<Avatar src="https://x.test/a.png" />);
    expect(screen.queryByAltText('Account')).not.toBeNull();
  });

  it('renders an initials disc (not an image) when there is no src', () => {
    render(<Avatar name="John Doe" />);
    expect(screen.getByText('JD')).not.toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it.each([
    ['ash@ashfrancis.com', 'AS'], // email local-part, single token → first two chars
    ['John Doe', 'JD'], // two words → first letter of each
    ['jane.smith', 'JS'], // dotted
    ['ash_francis', 'AF'], // underscored
    ['first.last@example.com', 'FL'], // dotted email local-part
    ['a', 'A'], // single char
  ])('derives initials for %s → %s', (name, expected) => {
    render(<Avatar name={name} />);
    expect(screen.getByText(expected)).not.toBeNull();
  });

  it.each<[string, string | null]>([
    ['empty string', ''],
    ['null', null],
  ])('shows "?" for a missing name (%s)', (_label, name) => {
    render(<Avatar name={name} />);
    expect(screen.getByText('?')).not.toBeNull();
  });

  it('shows "?" when the name prop is omitted entirely', () => {
    render(<Avatar />);
    expect(screen.getByText('?')).not.toBeNull();
  });
});
