interface Window {
  reportClientError?: (section: 'Client'|'Open tabs'|'Recent'|'Agents'|'Sessions'|'Threads'|'Files', error: unknown) => void;
}

// This parser-blocking asset stays a classic script: no imports, exports or module syntax.
(() => {
  try {
    const encoder = new TextEncoder(), recent = new Map<string, number>();
    const source: {release?: string; commit?: string; generation?: string} = {};
    let windowAt = Date.now(), count = 0, sending = false;
    const pending:string[]=[];let retry:number|undefined,retries=0;
    const asset = (value: string): string => {
      try {
        const position = /(?::\d{1,8}){1,2}$/.exec(value)?.[0] ?? '';
        const url = new URL(position ? value.slice(0, -position.length) : value, location.origin);
        return url.origin === location.origin && /^\/(?:_ui\/[a-f0-9]{64}\/)?(?:web|shared)\/[\w-]+\.js$/.test(url.pathname) ? url.pathname + position : '';
      } catch {return '';}
    };
    const bounded = (value: string, limit: number): string => {
      let result = '', bytes = 0;
      for (const char of value.slice(0, limit)) {const size = encoder.encode(char).length; if (bytes + size > limit) break; result += char; bytes += size;}
      return result;
    };
    const cleanText = (value: string): string => value
      .replace(/\bdata:[^,\s"')]*,[^\s"')]*/gi, '[url omitted]')
      .replace(/\b(?:https?:\/\/|file:\/\/|blob:(?:https?:\/\/|null\/))[^\s"'<>)]*/gi, value => asset(value) || '[url omitted]')
      .replace(/(\/[^\s"'<>?#)]*)[?#]([^\s"'<>)]*)/g, (_all, path: string, tail: string) => path + (/(?::\d{1,8}){1,2}$/.exec(tail)?.[0] ?? ''))
      .replace(/\bBearer[ \t]+[A-Za-z0-9._~+/-]{12,}={0,2}/gi, '[credential omitted]')
      .replace(/(\b(?:authorization|cookie|password|secret|token|api[ _-]?key)\b["']?[ \t]*[:=][ \t]*)(?!(?:undefined|null|missing|invalid|unavailable|none|false|true)\b)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}"'[\]]+)/gi, '$1[credential omitted]')
      .replace(/\bsk[-_][\w-]{16,}/g, '[credential omitted]')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    const message = (value: string): string => bounded(cleanText(value.slice(0, 4096)).replace(/[\n\t]/g, ' '), 1024);
    try {
      const encoded = document.querySelector('meta[name="ui-identity"]')?.getAttribute('content');
      const identity = encoded && encoded.length <= 16 * 1024 ? JSON.parse(decodeURIComponent(encoded)) : undefined;
      if (typeof identity?.release === 'string' && /^[a-f0-9]{64}$/.test(identity.release)) source.release = identity.release;
      if (typeof identity?.git?.commit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(identity.git.commit)) source.commit = identity.git.commit;
      const generation = document.querySelector('meta[name="ui-generation"]')?.getAttribute('content');
      if (generation && /^[a-f0-9]{64}$/.test(generation)) source.generation = generation;
    } catch {}
    const stackText = (error: Error|DOMException|undefined, hint: string): string => {
      const raw = error && 'stack' in error && typeof error.stack === 'string' ? error.stack : '';
      const fallback = error ? `${error.name}: ${error.message}` : '';
      const text = raw || [fallback, asset(hint)].filter(Boolean).join('\n');
      return bounded(cleanText(text.slice(0, 8192).split('\n').slice(0, 32).join('\n')), 4096);
    };
    const admit = (key: string, now: number): boolean => {
      for (const [key, at] of recent) if (now - at >= 60_000) recent.delete(key);
      if (recent.has(key)) return false;
      if (recent.size >= 32) recent.delete(recent.keys().next().value as string);
      recent.set(key, now); count++; return true;
    };
    const diagnostic = (error: unknown, fallback: string, hint: string): {message: string; stack: string} => {
      const nativeError = error instanceof Error || error instanceof DOMException ? error : undefined;
      const reason = typeof error === 'string' ? error : fallback;
      return {message: message(nativeError && typeof nativeError.message === 'string' ? nativeError.message : reason), stack: stackText(nativeError, hint)};
    };
    const failed = ():void => {
      sending=false;if(retries>=3)return;
      retry=window.setTimeout(()=>{retry=undefined;flush();},1000*2**retries++);
    };
    const flush = ():void => {
      if(sending||retry!==undefined||!pending.length)return;sending=true;
      try{
        void fetch('/api/client-errors', {method:'POST',headers:{'Content-Type':'application/json'},body:pending[0],credentials:'same-origin',signal:AbortSignal.timeout(3000)})
          .then(response=>{if(!response.ok){failed();return;}sending=false;retries=0;pending.shift();flush();},failed);
      }catch{failed();}
    };
    const report = (section: Parameters<NonNullable<Window['reportClientError']>>[0], error: unknown, fallback = 'Client error without an Error object.', locationHint = ''): void => {
      try {
        flush();const now = Date.now(); if (now - windowAt >= 60_000) {windowAt = now; count = 0;}
        if (count >= 8 || pending.length >= 8) return;
        const details = diagnostic(error, fallback, locationHint);
        if (!admit(`${details.message}\n${details.stack}`, now)) return;
        const body = JSON.stringify({...details, section, source});
        if (encoder.encode(body).length > 8192) return;
        pending.push(body);flush();
      } catch {}
    };
    window.reportClientError = (section, error) => report(section, error);
    window.addEventListener('error', (event: Event) => {
      try {
        if (event instanceof ErrorEvent) report('Client', event.error, event.message, `${event.filename}:${event.lineno}:${event.colno}`);
        else if (event.target instanceof HTMLScriptElement) report('Client', undefined, 'Client script resource failed.', event.target.src);
      } catch {}
    }, true);
    window.addEventListener('unhandledrejection', event => {try {report('Client', event.reason, 'Unhandled promise rejection without an Error object.');} catch {}});
  } catch {}
})();
