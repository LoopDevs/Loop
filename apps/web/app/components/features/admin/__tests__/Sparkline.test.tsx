// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Sparkline, toPoints } from '../Sparkline';

afterEach(cleanup);

describe('toPoints', () => {
  it('returns an empty string for an empty series', () => {
    expect(toPoints([])).toBe('');
  });

  it('renders a single value at x=0 baseline y', () => {
    expect(toPoints([10])).toBe('0.0,2.0');
  });

  it('keeps an all-zero series at the baseline without divide-by-zero', () => {
    const pts = toPoints([0, 0, 0]).split(' ');
    const ys = pts.map((p) => Number(p.split(',')[1]));
    expect(new Set(ys).size).toBe(1);
    expect(ys[0]).toBe(62);
  });

  it('distributes x evenly from 0 to WIDTH', () => {
    const pts = toPoints([1, 2, 3]).split(' ');
    const xs = pts.map((p) => Number(p.split(',')[0]));
    expect(xs[0]).toBe(0);
    expect(xs[2]).toBe(560);
  });
});

describe('<Sparkline />', () => {
  it('renders a spinner in the pending state', () => {
    const { container } = render(
      <Sparkline
        title="x"
        subtitle="y"
        ariaLabel="l"
        series={[]}
        isPending={true}
        isError={false}
        errorMessage="err"
      />,
    );
    expect(container.querySelector('svg')).toBeDefined();
  });

  it('renders the error message in the error state', () => {
    render(
      <Sparkline
        title="x"
        subtitle="y"
        ariaLabel="l"
        series={[]}
        isPending={false}
        isError={true}
        errorMessage="something blew up"
      />,
    );
    expect(screen.getByText('something blew up')).toBeDefined();
  });

  it('renders title + subtitle + legend + one polyline per series', () => {
    const { container } = render(
      <Sparkline
        title="Throughput (7d)"
        subtitle="42 created · 40 fulfilled"
        ariaLabel="throughput chart"
        isPending={false}
        isError={false}
        errorMessage=""
        series={[
          {
            label: 'Created',
            values: [1, 2, 3],
            colorClass: 'text-blue-500',
            swatchClass: 'bg-blue-500',
          },
          {
            label: 'Fulfilled',
            values: [1, 1, 2],
            colorClass: 'text-green-500',
            swatchClass: 'bg-green-500',
          },
        ]}
      />,
    );
    expect(screen.getByText('Throughput (7d)')).toBeDefined();
    expect(screen.getByText('42 created · 40 fulfilled')).toBeDefined();
    expect(screen.getByText('Created')).toBeDefined();
    expect(screen.getByText('Fulfilled')).toBeDefined();
    // One <polyline> per series.
    expect(container.querySelectorAll('polyline')).toHaveLength(2);
  });

  it('skips rendering a polyline for an empty-values series', () => {
    const { container } = render(
      <Sparkline
        title="x"
        subtitle="y"
        ariaLabel="l"
        isPending={false}
        isError={false}
        errorMessage=""
        series={[
          {
            label: 'Nothing',
            values: [],
            colorClass: 'text-gray-500',
            swatchClass: 'bg-gray-500',
          },
        ]}
      />,
    );
    expect(container.querySelectorAll('polyline')).toHaveLength(0);
    // Legend entry still renders even when the line is absent.
    expect(screen.getByText('Nothing')).toBeDefined();
  });
});
