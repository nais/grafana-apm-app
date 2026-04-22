import { renderHook, act } from '@testing-library/react';
import { useTableSort } from './SortableTable';

describe('useTableSort', () => {
  it('initializes with provided field and direction', () => {
    const { result } = renderHook(() => useTableSort<'name' | 'rate'>('rate', 'desc'));
    expect(result.current.sortField).toBe('rate');
    expect(result.current.sortDir).toBe('desc');
  });

  it('defaults to desc direction', () => {
    const { result } = renderHook(() => useTableSort<'name'>('name'));
    expect(result.current.sortDir).toBe('desc');
  });

  it('toggles direction when clicking same field', () => {
    const { result } = renderHook(() => useTableSort<'name' | 'rate'>('rate', 'desc'));
    act(() => result.current.toggleSort('rate'));
    expect(result.current.sortField).toBe('rate');
    expect(result.current.sortDir).toBe('asc');
  });

  it('switches to new field with desc direction', () => {
    const { result } = renderHook(() => useTableSort<'name' | 'rate'>('rate', 'asc'));
    act(() => result.current.toggleSort('name'));
    expect(result.current.sortField).toBe('name');
    expect(result.current.sortDir).toBe('desc');
  });

  it('comparator sorts numbers correctly', () => {
    const { result } = renderHook(() => useTableSort<'rate'>('rate', 'desc'));
    const items = [{ rate: 10 }, { rate: 50 }, { rate: 20 }];
    const sorted = [...items].sort(result.current.comparator);
    expect(sorted.map((i) => i.rate)).toEqual([50, 20, 10]);
  });

  it('comparator sorts strings correctly in asc', () => {
    const { result } = renderHook(() => useTableSort<'name'>('name', 'asc'));
    const items = [{ name: 'charlie' }, { name: 'alice' }, { name: 'bob' }];
    const sorted = [...items].sort(result.current.comparator);
    expect(sorted.map((i) => i.name)).toEqual(['alice', 'bob', 'charlie']);
  });
});
