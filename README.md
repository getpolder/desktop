# Polder for macOS

An Electron shell around Polder: one or more windows with tabs, and the whole suite (Backlog, chat, docs, flows)
inside it. The web app is untouched; this only adds the frame.

## Install

Download the latest `Polder-<version>-arm64.dmg` from [Releases](https://github.com/getpolder/desktop/releases)
(Apple Silicon), open it and drag Polder to Applications.

The build is not yet signed with an Apple Developer ID, so macOS blocks the first launch. Allow it in
System Settings → Privacy & Security → "Open Anyway", or run `xattr -cr /Applications/Polder.app` once.

## Build it yourself

This repository is a read-only copy of the `desktop/` directory in the Polder monorepo; changes are made there.

```
npm install
npm start          # run it
npm run dist       # build a .dmg (run on a Mac)
```

- **Start URL:** `https://backlog.polder.work`. Override with `POLDER_URL=...` or `{"url": "..."}` in
  `~/Library/Application Support/Polder/config.json`.
- **Domain:** every subdomain of the start URL's domain opens inside the app (`polder.work`: backlog, chat,
  docs, flows, id), so the shared login keeps working. Links to anything else open in the default browser.
  `POLDER_DOMAIN` overrides the derived domain.
- **Tabs:** `Cmd+N` new window (each has its own tabs, all restored on launch), `Cmd+T` new, `Cmd+W` close, `Ctrl+Tab` / `Ctrl+Shift+Tab` or `Cmd+Shift+[` / `]` switch,
  `Cmd+1…9` jump, middle click closes, drag to reorder, right click to pin (a pinned tab shrinks to its icon, stays in front, cannot be closed until unpinned and survives a restart). Hovering a tab shows a preview card with the last picture of the page. `Cmd+Alt+1…4` opens Backlog / Chat / Docs / Flows in a new tab.
  `Cmd+[` / `Cmd+]` back and forward. Open tabs and window size are restored on launch.
- **Shortcuts left to Polder:** `Cmd+K`, `Cmd+F`, `Cmd+A`, `Cmd+Enter` and all single-key shortcuts never
  touch the app menu. Right-click gives a native menu (copy/paste, spelling, open link in a new tab, inspect).

Not done: code signing and notarisation (needed to distribute outside your own Mac), auto-update,
dragging a tab to another window, Windows/Linux builds.
