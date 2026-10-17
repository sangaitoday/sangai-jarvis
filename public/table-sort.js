'use strict';
(function () {
  function nextSort(state, key) {
    if (!state || state.key !== key) return { key, dir: 'asc' };
    return state.dir === 'asc' ? { key, dir: 'desc' } : null;
  }

  function compareValues(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  function sortBy(items, state, valueOf) {
    if (!state) return items.slice();
    const sign = state.dir === 'desc' ? -1 : 1;
    return items
      .map((item, index) => ({ item, index, value: valueOf(item, state.key) }))
      .sort((x, y) => {
        const xMissing = x.value == null || x.value === '';
        const yMissing = y.value == null || y.value === '';
        if (xMissing !== yMissing) return xMissing ? 1 : -1;
        return (xMissing ? 0 : sign * compareValues(x.value, y.value)) || x.index - y.index;
      })
      .map((entry) => entry.item);
  }

  function optionsFrom(values) {
    const counts = new Map();
    for (const value of values) {
      if (value != null && value !== '') counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => compareValues(a.value, b.value));
  }

  // A sortable header is a focusable th: click, Enter or Space moves it through asc, desc, none.
  function bindHeader(th, key, getState, apply) {
    if (!th) return;
    const activate = () => apply(nextSort(getState(), key));
    th.addEventListener('click', activate);
    th.addEventListener('keydown', (e) => {
      if (e.code !== 'Enter' && e.code !== 'Space') return;
      e.preventDefault?.();
      activate();
    });
  }

  function markHeader(th, key, state) {
    th?.setAttribute('aria-sort', state && state.key === key ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  }

  // Filter choices come from the rows on screen, each with its count; a choice that vanished resets.
  function fillSelect(select, allLabel, values) {
    if (!select) return;
    const current = select.value;
    const all = document.createElement('option');
    all.value = '';
    all.textContent = allLabel;
    const options = optionsFrom(values).map(({ value, count }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = `${value} (${count})`;
      return option;
    });
    select.replaceChildren(all, ...options);
    select.value = options.some((option) => option.value === current) ? current : '';
  }

  const api = { nextSort, sortBy, optionsFrom, bindHeader, markHeader, fillSelect };
  if (typeof window !== 'undefined') window.TableSort = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
