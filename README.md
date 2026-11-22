# R Commander Studio

A lightweight, standalone Electron + Monaco R and R Markdown IDE designed in the visual language of **NoteComplete** — combining offline Monaco syntax highlighting, real-time R diagnostics, all **371 R Commander dialogs**, an interactive R runtime with automatic SVG plot capture, and a secure local **NoteComplete Bridge** server.

## Features

- **Monaco Editor (offline bundled)** with multi-tab support for `.R`, `.Rmd`, `.qmd`, `.md`, `.csv`, `.txt`.
- **Custom R Markdown (`rmd`) Monarch Tokenizer** highlighting YAML frontmatter, Markdown prose, and fenced ```` ```{r ...} ```` blocks with full R syntax highlighting.
- **NoteComplete Light & Dark Themes** matching NoteComplete's exact surface, accent, hairline, and typography tokens — plus matching `notecomplete-light` / `notecomplete-dark` Monaco themes.
- **Real-Time R Diagnostics, Hover & Completions (`main/r-lsp.js`)**:
  - Primary: R `languageserver::run()` over stdio JSON-RPC (`Content-Length` framing).
  - Instant fallback: fast `Rscript` `parse(text=...)` syntax checker so red squiggles always appear immediately.
  - `.Rmd` chunk extraction preserving exact 1-based `.Rmd` line offsets.
  - Clickable **Problems** panel synced with Monaco markers.
- **All 371 R Commander Dialogs (`vendor/rcmdr/`)**:
  - Searchable R Commander Menu Tree with **English / Español** toggle.
  - Dynamic modal dialog driven directly by `formmodel.js` supporting every field type (`var`, `dataset`, `model`, `models`, `choice`, `text`, `name`, `num`, `numlist`, `flags`, `formula`, `table`, `matrix`, `levelorder`, `renames`, `rlist`, `installed`, `file`, `dir`, `note`, `when` conditions, live validation) with **Run**, **Insert in Script**, and **Run & Insert**.
- **Direct R Execution + Plot Viewer + Workspace Inspector (`main/r-runtime.js`)**:
  - Persistent R session powered by `runner.R` (`run_code`, `session_info`, `attach_rcmdr_if_used`), plus automatic `arf` detection.
  - Automatic SVG plot capture (`svglite` if installed, else `grDevices::svg`) with plot history, zoom, and Save SVG.
  - Live Workspace Inspector showing datasets (with columns, kinds, levels), models, clusters, and objects.
  - Live Markdown / R Markdown split preview + `rmarkdown::render` Knit support.
- **NoteComplete Bridge Server (`main/bridge.js`)**:
  - Binds strictly to `127.0.0.1:0` with a random 32-byte hex Bearer token (`401` on missing/invalid auth, no wildcard CORS).
  - Writes a `0600` discovery file (`~/.config/notecomplete/r-bridge.json` on Linux, `~/Library/Application Support/notecomplete/r-bridge.json` on macOS, `%APPDATA%/notecomplete/r-bridge.json` on Windows) and removes it cleanly on shutdown.
  - Exposes `GET /health`, `GET /catalog`, `POST /eval-figure`, `POST /eval-code`, and `POST /open-script`.

## Quick Start

```bash
npm install
npm run sync-rcmdr   # optional: refreshes vendor/rcmdr/ from r-commander-play
npm start
```

## Testing

```bash
npm test
```

## Packaging

```bash
npm run dist         # current platform
npm run dist:linux   # Linux AppImage
npm run dist:mac     # macOS DMG / ZIP
npm run dist:win     # Windows NSIS installer
```

## NoteComplete Bridge Protocol (v1)

Discovery file JSON (`0600`):
```json
{
  "protocolVersion": 1,
  "app": "r-commander-studio",
  "version": "0.1.0",
  "port": 49152,
  "token": "<64-hex-chars>",
  "pid": 12345,
  "startedAt": "2026-11-22T00:00:00.000Z"
}
```

All HTTP endpoints require `Authorization: Bearer <token>`:
- `GET /health`
- `GET /catalog`
- `POST /eval-figure` `{ rCode, width?, height?, bg?, timeoutMs?, require? }`
- `POST /eval-code` `{ rCode, timeoutMs?, require? }`
- `POST /open-script` `{ title, code, kind?: "r"|"rmd" }`
