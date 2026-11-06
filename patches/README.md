# Terminal rendering patches

- `string-width@7.2.0.patch` distinguishes text presentation (such as bare `ℹ`) from emoji presentation (`ℹ️`), while measuring partial flags and minimally qualified emoji used during streaming. It requires the project's Node.js 22 baseline.
- `ink@5.2.1.patch` groups styled code points into grapheme clusters before placing or clipping them in the output buffer. It uses `string-width` for cell spans instead of counting each code point independently, preserving combining marks, flags, skin tones, and ZWJ sequences.

Both patches are registered in `pnpm-workspace.yaml` and applied by pnpm. Keep Oran, Ink, and Ink's wrapping dependencies on the same width implementation. When upgrading either dependency, review whether the upstream implementation replaces these patches before removing them.

These patches align logical cell widths; they cannot constrain a terminal font's painted emoji bounds. Markdown tables therefore convert emoji to ASCII display text before measuring, wrapping, or padding cells. Common prose symbols use labels such as `[info]`; inline code uses Unicode escapes to preserve exact code points. Other emoji use `U+...` labels. Both grid and compact tables use this policy. Stored Markdown and emoji outside tables retain their original content.
