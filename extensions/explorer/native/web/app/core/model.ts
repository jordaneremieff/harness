(() => {
  
  const listeners: ((event: ExplorerEvent) => void)[] = [];
  const eventTypes = new Set(['files.changed', 'notes.changed', 'live', 'open', 'promptState']);
  async function request<K extends keyof ExplorerRequests>(type: K, ...args: undefined extends ExplorerRequests[K][0] ? [fields?: ExplorerRequests[K][0]] : [fields: ExplorerRequests[K][0]]): Promise<ExplorerRequests[K][1]> {
    const channel = (window as Window & { webkit?: { messageHandlers?: { explorer?: { postMessage(value: object): Promise<unknown> } } } }).webkit?.messageHandlers?.explorer;
    if (!channel) throw Object.assign(new Error('The Explorer host is unavailable.'), { code: 'unavailable' });
    const packet = JSON.parse(JSON.stringify({ ...args[0], v: 1, type })) as object;
    const result = await channel.postMessage(packet) as { ok?: unknown; error?: { code?: string; message?: string; retryable?: boolean } };
    if (result?.ok !== true) throw Object.assign(new Error(result?.error?.message ?? 'The host did not confirm the request.'), { code: result?.error?.code, retryable: result?.error?.retryable });
    return result as ExplorerRequests[K][1];
  }

  function lines(text: string | null | undefined): string[] {
    return text ? text.replace(/\n$/, '').split('\n') : [];
  }

  const languages: [string, string, string, string][] = [
    ['typescript', 'TypeScript', 'TS', 'ts tsx mts cts'], ['javascript', 'JavaScript', 'JS', 'js jsx mjs cjs'],
    ['swift', 'Swift', 'SW', 'swift'], ['json', 'JSON', '{}', 'json jsonc jsonl'], ['markdown', 'Markdown', 'M↓', 'md mdx markdown'],
    ['css', 'CSS', '#', 'css scss less'], ['html', 'HTML', '<>', 'html htm xml svg'], ['bash', 'Shell', '>_', 'sh bash zsh fish'],
    ['yaml', 'YAML', 'Y', 'yaml yml'], ['python', 'Python', 'PY', 'py pyw'], ['rust', 'Rust', 'RS', 'rs'], ['go', 'Go', 'GO', 'go'],
    ['sql', 'SQL', 'SQ', 'sql'], ['diff', 'Diff', '±', 'diff patch'],
  ];
  const byExtension = new Map(languages.flatMap(([id, label, mark, extensions]) => extensions.split(' ').map(extension => [extension, { id, label, mark }] as const)));
  function language(path: string): ExplorerLanguage {
    const name = path.toLowerCase().split('/').at(-1) ?? '';
    return byExtension.get(name.split('.').at(-1) ?? '') ?? { id: 'text', label: 'Plain text', mark: '' };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep source coordinates and their matching or projection rules in one pass.
  function fuzzy(paths: string[], query: string, limit = 100): ExplorerHit[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return paths.slice(0, limit).map(path => ({ path, score: 0 }));
    const matches: ExplorerHit[] = [];
    for (const path of paths) {
      const value = path.toLowerCase();
      const leaf = value.lastIndexOf('/') + 1;
      const exact = value.indexOf(needle);
      if (exact >= 0) { matches.push({ path, score: 200 + (exact >= leaf ? 60 : 0) + (exact === leaf ? 25 : 0) - value.length * .1 }); continue; }
      let index = 0;
      let first = -1;
      let last = -1;
      let score = 0;
      for (let cursor = 0; cursor < value.length; cursor++) {
        if (value[cursor] !== needle[index]) continue;
        if (first < 0) first = cursor;
        if (cursor === last + 1) score += 5;
        if (cursor >= leaf) score += 2;
        last = cursor;
        if (++index === needle.length) break;
      }
      if (index === needle.length) matches.push({ path, score: score - (last - first) * .4 - value.length * .13 });
    }
    return matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
  }

  function find(source: string[], query: string, side: ExplorerSide, limit = 10000): ExplorerMatch[] {
    if (!query) return [];
    const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    const result: ExplorerMatch[] = [];
    for (let row = 0; row < source.length; row++) {
      for (const match of source[row].matchAll(re)) {
        result.push({ side, line: row + 1, start: match.index, end: match.index + match[0].length });
        if (result.length >= limit) return result;
      }
    }
    return result;
  }

  function word(a: string, b: string): ReturnType<ExplorerModel['word']> {
    if (a === b || a.length + b.length > 1000) return undefined;
    const tokens = (text: string) => [...text.matchAll(/[\p{L}\p{N}_$]+|\s+|[^\s]/gu)];
    const left = tokens(a), right = tokens(b);
    let start = 0, end = 0;
    while (start < Math.min(left.length, right.length) && left[start][0] === right[start][0]) start++;
    while (end < Math.min(left.length, right.length) - start && left[left.length - end - 1][0] === right[right.length - end - 1][0]) end++;
    return { base: [left[start]?.index ?? a.length, left[left.length - end]?.index ?? a.length], head: [right[start]?.index ?? b.length, right[right.length - end]?.index ?? b.length] };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep source coordinates and their matching or projection rules in one pass.
  function project(base: string[], head: string[], hunks: ExplorerHunk[], split: boolean): ExplorerCodeRow[] {
    const rows: ExplorerCodeRow[] = [];
    let b = 1, h = 1;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep source coordinates and their matching or projection rules in one pass.
    const context = (count: number, nearStart: boolean, nearEnd: boolean) => {
      const add = () => rows.push({ type: 'line', kind: 'context', base: b++, head: h++ });
      const leading = nearStart ? 3 : 0;
      const trailing = nearEnd ? 3 : 0;
      if (count > leading + trailing + 3) {
        for (let index = 0; index < leading; index++) add();
        const folded = count - leading - trailing;
        rows.push({ type: 'fold', key: `${b}:${h}`, base: b, head: h, count: folded });
        b += folded;
        h += folded;
        for (let index = 0; index < trailing; index++) add();
      } else for (let index = 0; index < count; index++) add();
    };
    for (const [index, hunk] of hunks.entries()) {
      const bs = hunk.baseStart + (hunk.baseCount === 0 ? 1 : 0);
      const hs = hunk.headStart + (hunk.headCount === 0 ? 1 : 0);
      context(Math.max(0, Math.min(bs - b, hs - h, base.length - b + 1, head.length - h + 1)), index > 0, true);
      rows.push({ type: 'hunk', label: `@@ −${hunk.baseStart},${hunk.baseCount} +${hunk.headStart},${hunk.headCount} @@` });
      b = bs;
      h = hs;
      const bn = Math.max(0, Math.min(hunk.baseCount, base.length - b + 1));
      const hn = Math.max(0, Math.min(hunk.headCount, head.length - h + 1));
      const words: ReturnType<ExplorerModel['word']>[] = [];
      if (bn + hn <= 360) for (let offset = 0; offset < Math.min(bn, hn); offset++) words.push(word(base[b + offset - 1], head[h + offset - 1]));
      if (split) {
        for (let offset = 0; offset < Math.max(bn, hn); offset++) rows.push({ type: 'line', kind: offset < bn ? (offset < hn ? 'pair' : 'del') : 'add', base: offset < bn ? b + offset : undefined, head: offset < hn ? h + offset : undefined, word: words[offset] });
      } else {
        for (let offset = 0; offset < bn; offset++) rows.push({ type: 'line', kind: 'del', base: b + offset, word: words[offset] });
        for (let offset = 0; offset < hn; offset++) rows.push({ type: 'line', kind: 'add', head: h + offset, word: words[offset] });
      }
      b += bn;
      h += hn;
    }
    if (hunks.length) context(Math.max(0, Math.min(base.length - b + 1, head.length - h + 1)), true, false);
    return rows;
  }

  function source(item: ExplorerExcerpt): string {
    const span = item.start === undefined ? '' : item.end && item.end !== item.start ? `, lines ${item.start}–${item.end}` : `, line ${item.start}`;
    const reference = `${item.path}${span}, at ${item.commit ? item.commit.slice(0, 7) : 'working tree'}${item.id ? ` (note ${item.id})` : ''}`;
    if (item.quote === undefined) return reference;
    const fence = '`'.repeat(Math.max(3, ...[...item.quote.matchAll(/`+/g)].map(match => match[0].length + 1)));
    const id = language(item.path).id;
    return `${reference}\n${fence}${id === 'text' ? '' : id}\n${item.quote}\n${fence}`;
  }

  function excerpt(root: string, scope: string, items: ExplorerExcerpt[]): string {
    return `Review comments on ${root}, ${scope} (${items.length} comment${items.length === 1 ? '' : 's'})\n\n${items.map((item, index) => `${index + 1}. ${source(item)}\n${item.text}`).join('\n\n')}`;
  }

  function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    return bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  }

  const app = {
    request,
    receive(value: unknown) {
      if (!value || typeof value !== 'object') return;
      const event = value as Partial<ExplorerEvent>;
      if (event.v !== 1 || !event.type || !eventTypes.has(event.type)) return;
      for (const listener of listeners) listener(event as ExplorerEvent);
    },
    listen(cb: (event: ExplorerEvent) => void) { listeners.push(cb); },
    model: { lines, language, fuzzy, find, project, word, excerpt, source, size },
  };
  window.explorer = app as ExplorerApp;
})();
