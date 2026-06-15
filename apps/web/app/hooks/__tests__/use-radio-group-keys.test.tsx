// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useState } from 'react';
import { useRadioGroupKeys } from '../use-radio-group-keys';

afterEach(cleanup);

const OPTS = ['usdc', 'xlm', 'loop_asset'] as const;
type Opt = (typeof OPTS)[number];

function Harness({ onChange }: { onChange?: (v: Opt) => void }): React.JSX.Element {
  const [selected, setSelected] = useState<Opt | null>(null);
  const { rovingTabIndex, onKeyDown } = useRadioGroupKeys<Opt>({
    options: OPTS,
    selected,
    onSelect: (v) => {
      setSelected(v);
      onChange?.(v);
    },
  });
  return (
    <div role="radiogroup" aria-label="Test">
      {OPTS.map((o, i) => (
        <button
          key={o}
          role="radio"
          aria-checked={selected === o}
          tabIndex={rovingTabIndex(i)}
          onKeyDown={(e) => onKeyDown(e, i)}
          onClick={() => setSelected(o)}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

describe('useRadioGroupKeys', () => {
  it('exposes a single roving tab stop (first radio when nothing selected)', () => {
    render(<Harness />);
    const radios = screen.getAllByRole('radio');
    expect(radios[0]!.getAttribute('tabindex')).toBe('0');
    expect(radios[1]!.getAttribute('tabindex')).toBe('-1');
    expect(radios[2]!.getAttribute('tabindex')).toBe('-1');
  });

  it('ArrowRight moves selection to the next radio and updates the roving stop', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const radios = screen.getAllByRole('radio');
    fireEvent.keyDown(radios[0]!, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('xlm');
    expect(radios[1]!.getAttribute('aria-checked')).toBe('true');
    expect(radios[1]!.getAttribute('tabindex')).toBe('0');
    expect(radios[0]!.getAttribute('tabindex')).toBe('-1');
  });

  it('ArrowLeft wraps from the first radio to the last', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const radios = screen.getAllByRole('radio');
    fireEvent.keyDown(radios[0]!, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('loop_asset');
  });

  it('Home / End jump to the first / last radio', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const radios = screen.getAllByRole('radio');
    fireEvent.keyDown(radios[1]!, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('loop_asset');
    fireEvent.keyDown(radios[2]!, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('usdc');
  });

  it('ignores non-navigation keys', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const radios = screen.getAllByRole('radio');
    fireEvent.keyDown(radios[0]!, { key: 'a' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
