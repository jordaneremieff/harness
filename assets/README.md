# Assets

General harness resources that several apps use: data such as colour palettes, never code. An
asset knows no app. Each app that uses one copies the files it needs into its own bundle at build
time, counts them among its build inputs, and maps its own names onto the asset's names. An app
never reads another app's files or bundle through an asset.

## themes

`themes/` holds the [Catppuccin](https://github.com/catppuccin/palette) palette (MIT licence) for
pages that follow it:

- `catppuccin.css` sets custom properties on the root element. `--ctp-latte-<role>` holds Latte,
  the light flavour. `--ctp-dark-<role>` holds the dark flavour that `data-dark` on the root names:
  `frappe` (the default), `macchiato` or `mocha`. `--ctp-<role>` is `light-dark()` of the two, so
  the page's colour scheme picks the side. An element with `data-ctp-dark="<flavour>"` carries that
  flavour's dark set for its own subtree, for example a swatch that previews a flavour.
- `catppuccin.json` holds the base colour of each flavour, for native code that paints behind a
  page.

The roles are the palette's colour names (`rosewater` to `crust`) and adjusted colours that read
at 4.5:1 or better on every surface of a page: darker than the palette value in Latte and lighter
in the dark flavours, as the Catppuccin style guide puts legibility first. Text roles: `ink`,
`heading`, `ink-2`, `link`, `link-hover`, `code-ink`, `mauve-text`, `teal-text`, `red-text`,
`green-text` and `peach-text`. Surface roles: `pressed`, `chip`, `mark`, `comment-mark`,
`selection`, `diff-add` and `diff-del`. Code-surface syntax roles: `code-comment`, `code-punct`,
`code-type`, `code-param`, `code-escape`, `code-operator`, `code-member`, `code-variant`,
`code-macro` and `code-meta`.

Which flavour a machine shows is not an asset; [the pane appearance
convention](../docs/conventions/pane-appearance.md) keeps that choice.
