/// The reader's bundled stylesheet, served at `reader-asset://app/reader.css`.
public enum Stylesheet {
    public static let css: String = {
        var rules = ""
        for (index, size) in PageSettings.textSizes.enumerated() {
            rules += "html[data-ts=\"\(index)\"] { font-size: \(size)px; }\n"
        }
        return rules + base
    }()

    static let base = #"""
    :root {
      color-scheme: light dark;
      --text: #1d1d1f;
      --muted: #5f6368;
      --faint: #8a8f98;
      --background: #ffffff;
      --surface: #f6f7f9;
      --surface-strong: #eceef2;
      --border: #dfe2e7;
      --link: #0a5cc2;
      --accent: #c8ccd4;
      --mark: rgba(255, 213, 79, 0.55);
      --check: #1f7a3d;
      --mono: ui-monospace, "SF Mono", Menlo, monospace;
      --sans: -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --text: #e6e6e8;
        --muted: #a1a5ad;
        --faint: #7d828b;
        --background: #1c1d20;
        --surface: #25272b;
        --surface-strong: #2e3035;
        --border: #3a3d43;
        --link: #6cb0ff;
        --accent: #50545c;
        --mark: rgba(255, 196, 0, 0.35);
        --check: #3fae62;
      }
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; background: var(--background); }
    body {
      margin: 0;
      color: var(--text);
      background: var(--background);
      font-family: var(--sans);
      line-height: 1.62;
      font-kerning: normal;
      text-rendering: optimizeLegibility;
      overflow-wrap: break-word;
    }
    main.doc {
      max-width: 44rem;
      margin: 0 auto;
      padding: 2.4rem 2.2rem 6rem;
    }
    @media (max-width: 620px) {
      main.doc { padding: 1.2rem 1rem 4rem; }
    }
    ::selection { background: rgba(10, 92, 194, 0.22); }
    @media (prefers-color-scheme: dark) { ::selection { background: rgba(108, 176, 255, 0.32); } }

    h1, h2, h3, h4, h5, h6 {
      line-height: 1.25;
      font-weight: 650;
      margin: 1.9em 0 0.6em;
      scroll-margin-top: 1rem;
      letter-spacing: -0.005em;
    }
    .blk:first-child > h1, .blk:first-child > h2, .blk:first-child > h3 { margin-top: 0; }
    h1 { font-size: 1.95em; font-weight: 700; letter-spacing: -0.015em; }
    h2 { font-size: 1.45em; padding-bottom: 0.25em; border-bottom: 1px solid var(--border); }
    h3 { font-size: 1.2em; }
    h4 { font-size: 1.05em; }
    h5 { font-size: 0.95em; }
    h6 { font-size: 0.9em; color: var(--muted); }

    p, ul, ol, blockquote, figure, table, pre, .raw-html, dl { margin: 0 0 1em; }
    ul, ol { padding-left: 1.6em; }
    li { margin: 0.22em 0; }
    li > ul, li > ol { margin: 0.22em 0 0.3em; }
    li > p { margin: 0 0 0.5em; }
    li::marker { color: var(--muted); }
    li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.5em; }
    li > input[type="checkbox"] {
      -webkit-appearance: none;
      appearance: none;
      width: 1.05em;
      height: 1.05em;
      margin: 0 0.5em 0 0;
      vertical-align: -0.16em;
      border: 1.5px solid var(--muted);
      border-radius: 0.25em;
      background: var(--background);
    }
    li > input[type="checkbox"]:checked {
      border-color: var(--check);
      background: var(--check) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.5l3 3 6-7' fill='none' stroke='white' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 88% no-repeat;
    }

    a { color: var(--link); text-decoration: none; }
    a:hover { text-decoration: underline; }
    a.ext { text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--link) 40%, transparent); text-underline-offset: 0.15em; }
    .inert-link { text-decoration: underline dotted var(--faint); text-underline-offset: 0.15em; cursor: help; }

    strong { font-weight: 650; }
    del { color: var(--muted); }
    hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }

    blockquote {
      padding: 0.1em 1em;
      border-left: 3px solid var(--accent);
      color: var(--muted);
    }
    blockquote > :last-child { margin-bottom: 0.3em; }

    code, pre, kbd { font-family: var(--mono); }
    :not(pre) > code {
      font-size: 0.87em;
      padding: 0.1em 0.35em;
      border-radius: 4px;
      background: var(--surface-strong);
      overflow-wrap: anywhere;
    }
    figure.code {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      overflow: hidden;
    }
    figure.code figcaption {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1em;
      padding: 0.25em 0.6em 0.25em 0.9em;
      font-size: 0.76em;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      font-family: var(--sans);
    }
    figure.code .lang { font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    figure.code .copy {
      color: var(--muted);
      padding: 0.1em 0.6em;
      border-radius: 5px;
      border: 1px solid var(--border);
      background: var(--background);
      text-decoration: none;
      flex: none;
    }
    figure.code .copy:hover { color: var(--text); }
    figure.code pre { margin: 0; }
    pre {
      padding: 0.75em 0.95em;
      overflow-x: auto;
      font-size: 0.84em;
      line-height: 1.5;
      white-space: pre;
      tab-size: 4;
    }
    html[data-wrap="1"] pre { white-space: pre-wrap; overflow-wrap: anywhere; }

    table {
      display: block;
      width: fit-content;
      max-width: 100%;
      overflow-x: auto;
      border-collapse: collapse;
      font-size: 0.93em;
      line-height: 1.45;
    }
    th, td { border: 1px solid var(--border); padding: 0.4em 0.7em; vertical-align: top; min-width: 3em; }
    th { background: var(--surface-strong); font-weight: 600; text-align: left; }
    tr:nth-child(even) td { background: var(--surface); }
    th[align="center"], td[align="center"] { text-align: center; }
    th[align="right"], td[align="right"] { text-align: right; }

    img { max-width: 100%; height: auto; }
    .img-ph {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0.5em;
      padding: 0.3em 0.6em;
      border: 1px dashed var(--accent);
      border-radius: 6px;
      color: var(--muted);
      font-size: 0.88em;
      max-width: 100%;
    }
    .img-ph .ph-kind { font-weight: 600; }
    .img-ph code { font-size: 0.9em; }

    .raw-html { border: 1px dashed var(--accent); border-radius: 8px; }
    .raw-html .raw-label { font-size: 0.74em; color: var(--muted); padding: 0.25em 0.9em; border-bottom: 1px dashed var(--accent); }
    .raw-html pre { margin: 0; color: var(--muted); }
    code.raw-inline { color: var(--muted); }

    .footnotes { font-size: 0.9em; color: var(--muted); border-top: 1px solid var(--border); margin-top: 2.5em; padding-top: 1em; }
    .footnote-ref a, .footnotes a { text-decoration: none; }
    sup { line-height: 0; }

    pre.source { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.86em; padding: 0; }

    @media print {
      main.doc { max-width: none; padding: 0; }
      figure.code .copy { display: none; }
    }
    """#
}
