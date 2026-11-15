extension Stylesheet {
    /// Rules of the revision comparison page: one column at every width.
    static let review = #"""

    :root {
      --removed: #c0392b;
      --removed-surface: rgba(214, 69, 65, 0.09);
      --removed-mark: rgba(214, 69, 65, 0.28);
      --added: #1f7a3d;
      --added-surface: rgba(46, 160, 67, 0.10);
      --added-mark: rgba(46, 160, 67, 0.30);
      --caution: #b26a00;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --removed: #ff7b72;
        --removed-surface: rgba(248, 81, 73, 0.13);
        --removed-mark: rgba(248, 81, 73, 0.36);
        --added: #56d364;
        --added-surface: rgba(63, 185, 80, 0.13);
        --added-mark: rgba(63, 185, 80, 0.36);
        --caution: #e3a008;
      }
    }
    .review .rv-kicker { margin: 0 0 0.2em; font-size: 0.78em; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
    .review .rv-head h1 { margin: 0 0 0.6em; font-size: 1.45em; }
    .rv-id { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0.3em 0.9em; margin: 0 0 0.9em; font-size: 0.9em; }
    .rv-id dt { color: var(--muted); }
    .rv-id dd { margin: 0; min-width: 0; }
    .review code.rv-digest { display: block; padding: 0; background: none; font-size: 0.8em; color: var(--muted); overflow-wrap: anywhere; }
    .rv-summary { margin: 0 0 0.5em; font-weight: 600; }
    .rv-note, .rv-partial { margin: 0 0 0.6em; padding: 0.1em 0 0.1em 0.8em; border-left: 3px solid var(--accent); font-size: 0.86em; color: var(--muted); }
    .rv-partial { border-left-color: var(--caution); color: var(--text); }
    .rv-region, .rv-assets { margin: 1.8em 0 0; padding-top: 1.1em; border-top: 1px solid var(--border); }
    .review h2.rv-path { margin: 0 0 0.15em; padding: 0; border: none; font-size: 1.08em; }
    .rv-where { margin: 0 0 0.8em; font-size: 0.8em; color: var(--muted); overflow-wrap: anywhere; }
    .rv-side { margin: 0 0 0.8em; padding: 0.35em 0 0.05em 0.85em; border-left: 3px solid var(--accent); }
    .rv-side.rv-before { border-left-color: var(--removed); }
    .rv-side.rv-after { border-left-color: var(--added); }
    .rv-side.rv-context { color: var(--muted); }
    .rv-side.rv-context img { opacity: 0.6; }
    .rv-tag { margin: 0 0 0.35em; font-size: 0.74em; font-weight: 600; color: var(--muted); }
    .rv-before > .rv-tag { color: var(--removed); }
    .rv-after > .rv-tag { color: var(--added); }
    .rv-side h1, .rv-side h2, .rv-side h3, .rv-side h4, .rv-side h5, .rv-side h6 { margin-top: 0.2em; }
    .rv-side .blk > :last-child { margin-bottom: 0.5em; }
    .review figure.code .copy { display: none; }
    /* Changed code wraps, so that no changed character sits outside the column. */
    .rv-before pre, .rv-after pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    .rv-ident { margin: 0 0 0.5em; font-size: 0.86em; }
    .rv-asset { margin: 0 0 1.4em; }
    .rv-asset-name { margin: 0 0 0.2em; font-weight: 600; overflow-wrap: anywhere; }
    .rv-asset img { display: block; max-height: 22rem; margin: 0 0 0.5em; border: 1px solid var(--border); border-radius: 4px; }
    details.rv-source { margin: 0 0 0.4em; }
    details.rv-source > summary { font-size: 0.84em; color: var(--muted); cursor: default; }
    .rv-diff { margin: 0.4em 0 0.6em; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; font-family: var(--mono); font-size: 0.8em; line-height: 1.5; }
    .rv-row { display: flex; align-items: flex-start; }
    .rv-no { flex: 0 0 3.4em; padding-right: 0.5em; text-align: right; color: var(--faint); -webkit-user-select: none; user-select: none; }
    .rv-sign { flex: 0 0 1.3em; color: var(--muted); -webkit-user-select: none; user-select: none; }
    .rv-text { flex: 1 1 0; min-width: 0; min-height: 1.5em; white-space: pre-wrap; overflow-wrap: anywhere; }
    .rv-row.rv-rem { background: var(--removed-surface); }
    .rv-row.rv-add { background: var(--added-surface); }
    .rv-rem .rv-sign { color: var(--removed); }
    .rv-add .rv-sign { color: var(--added); }
    .rv-row mark { color: inherit; border-radius: 2px; }
    .rv-rem mark { background: var(--removed-mark); }
    .rv-add mark { background: var(--added-mark); }
    .rv-eol { color: var(--faint); -webkit-user-select: none; user-select: none; }
    .rv-gap { padding: 0.1em 0.6em; border-block: 1px dashed var(--border); font-family: var(--sans); font-size: 0.92em; color: var(--faint); text-align: center; -webkit-user-select: none; user-select: none; }
    .rv-gap:first-child { border-top: none; }
    .rv-gap:last-child { border-bottom: none; }
    """#
}
