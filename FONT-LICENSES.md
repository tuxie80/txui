# Font licenses and permitted use

TxUI distributes its application code under the **MIT License**. Fonts are separate works with their own licenses. They are **not** relicensed under MIT.

## TxUI Mono

**TxUI Mono is a derivative of Victor Mono.**

- Original work: **Victor Mono**, copyright 2023 The Victor Mono Project Authors
- Original source: <https://github.com/rubjo/victor-mono-font>
- Derivative modifications: copyright 2026 TxUI
- Font license: **SIL Open Font License 1.1 (OFL)**
- Full license and modification notice: `src/assets/fonts/OFL-TxUI-Mono.txt` and `site/fonts/OFL-TxUI-Mono.txt`
- Reproducible build: `dev/build_txui_mono.py`

The modifications correct the default metadata weight to 400 and strengthen punctuation used heavily in SQL and database interfaces. The font family name was changed to **TxUI Mono** to distinguish the derivative from the original.

## What you may do

Under OFL 1.1, you may:

- Use the font privately or commercially.
- Embed it in applications, documents and websites.
- Modify it and create derivatives.
- Redistribute the original or modified font, including bundling it with software, free or paid.
- Publish those bundles on GitHub or elsewhere.

Normal TxUI users do not need to do anything else to use the fonts.

## What you must do when redistributing the font

If you redistribute TxUI Mono or a derivative, you must:

1. Keep the font under **SIL OFL 1.1**. Do not relicense it under MIT or another license.
2. Include the original Victor Mono copyright notice and the OFL text in an easily viewable form, in metadata and/or accompanying files.
3. Distinguish modified versions from the original. Do not present TxUI Mono or another derivative as unmodified Victor Mono.
4. Do not imply that the Victor Mono authors endorse the derivative. Their names may be used for attribution only.
5. Do not sell the font by itself. Selling software that includes the font is permitted.

Documents produced **using** the font do not themselves have to be licensed under OFL.

## Other bundled fonts

The website also self-hosts these OFL 1.1 fonts:

- **Space Grotesk** — headings and display text
- **Inter** — body text
- **JetBrains Mono** — code and data

Their notices and license texts are collected in `site/fonts/OFL.txt`.

The desktop application may also reference SF Mono, Menlo, Fira Code, Consolas and system UI fonts. Those are **not distributed by TxUI**; they are used only if already installed on the user's operating system.
