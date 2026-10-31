# ADR 0002: Browser-first now, a thin Electron shell later

Status: Accepted for the browser-first phases; the Electron choice for Phase 4 is provisional until the Windows spikes confirm it. Date: 2026-10-31.

## Context

The product is a local daemon (Node, hosting the Claude Agent SDK) plus a React UI that needs WebGL, `getUserMedia`, AudioWorklet and `onnxruntime-web`. A native shell adds a tray, autostart, single-instance behaviour and a window that does not look like a browser tab. Research proposed three paths (see [research/shell-architecture.md](../research/shell-architecture.md), [research/critic.md](../research/critic.md)):

- The shell researcher recommended browser-first, then Tauri 2 with a Node sidecar in Phase 3, with Electron as a drop-in fallback.
- The avatar researcher assumed one Chromium renderer. The companions researcher cited Project AIRI's move from Tauri to Electron after about three months fighting WebKit, Web Audio and DevTools (from a search excerpt, and mostly a macOS and Linux WebKit issue, since Tauri uses WebView2 on Windows).
- The critic resolved the contradiction in favour of Electron. The dev sandbox is Linux, where Tauri uses WebKitGTK, so it cannot validate the Windows WebView2 target. Tauri adds a Rust toolchain, Job Object supervision of the sidecar, target-triple binary naming, and shipping `node.exe` plus `node_modules` because Node SEA cannot load native addons. The shell researcher's argument that Electron's Node is redundant misses its real benefit, which is renderer parity between the Linux dev box and Windows.
- Tauri sidecar lifecycle on Windows is a known pain: issues reported sidecars surviving app exit (tauri-apps/tauri #1896, #2464, #3605).

## Decision

1. Phases 0 to 3 are browser-first: the daemon serves the API on `127.0.0.1`, the UI is a normal Vite SPA, launched in a chrome-less Edge or Chrome window (`--app=http://127.0.0.1:PORT`; this flag detail is unverified) with a Startup-folder shortcut or `pnpm start`. No installer, signing or Rust.
2. The UI is a pure client of the daemon through `ApiClient`. Closing or throttling the tab never stops background work, and no time-critical logic lives in the UI.
3. Phase 4 adds a thin Electron shell (pin the current 45.x line as of this date). The shell only spawns and supervises the daemon, provides tray, autostart and single-instance, and injects the auth token through a preload script. No business logic in the shell.
4. The daemon stays a separate process on a bundled plain `node.exe`, not Electron's embedded Node, so native addons (better-sqlite3, keyring) use the plain Node ABI and need no `electron-rebuild`.
5. The Electron security checklist is ours to own: `contextIsolation`, `sandbox`, a CSP, permission-request handlers, navigation and window-open limits, and IPC sender validation.
6. Phase 0b spike (c) and a Phase 4 go or no-go confirm or reverse this. Tauri stays an optional later spike if Electron's footprint proves a problem.

## Consequences

- Playwright with the same Chromium can test the avatar and voice UI on the Linux dev box.
- A larger install and RAM footprint than Tauri, and a fast major-release cadence to track (45.x is the npm latest; the Electron main-branch docs already describe 46, where the synchronous `safeStorage` API was removed). Exact bundled Chromium and Node versions were not verified.
- Updating on Windows needs a Squirrel.Windows `RELEASES` feed or `electron-updater`, and signing; `update.electronjs.org` needs a public GitHub repo. This matters only if the installer is ever shared (SmartScreen and signing do not matter for a personal install).
- The browser-first launcher has no tray or single-instance guard; a small launcher script covers that until Phase 4. A localhost server is attackable by any website unless Host and Origin checks, a token and loopback binding are enforced (see ARCHITECTURE section 10).
- The research estimate that a later shell swap is roughly a one-week task comes from the shell researcher and is not measured.

## Alternatives considered

| Option | Pros | Cons |
|---|---|---|
| Tauri 2 shell around a Node sidecar | Small footprint; WebView2 is Chromium-based on Windows and preinstalled; NSIS installer without admin; signed updater | Rust toolchain and MSVC build tools; sidecar orphans on Windows; Linux dev sandbox runs WebKitGTK; camera and WebGL behaviour untestable in the sandbox; mandatory updater signing key (loss strands installs); `externalBin` naming friction |
| Electron first | Chromium parity everywhere; pure TypeScript toolchain; mature packaging | Larger footprint; security checklist; premature before the daemon exists |
| Browser only, permanently | Zero shell work | No tray, autostart or native window; permission prompts per origin |
| Daemon inside Electron's main process | One process | Couples daemon lifetime to the UI; native addons need ABI rebuilds |
| Embedding or forking AIRI's Electron app | Working avatar shell | Owns the agent loop, persona and memory; a large fast-moving Vue monorepo |

## Sources

- https://registry.npmjs.org/electron/latest
- https://raw.githubusercontent.com/electron/electron/main/docs/tutorial/security.md
- https://raw.githubusercontent.com/electron/electron/main/docs/api/safe-storage.md
- https://raw.githubusercontent.com/electron/electron/main/docs/tutorial/updates.md
- https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/develop/sidecar.mdx
- https://github.com/tauri-apps/tauri/issues/1896
- https://nodejs.org/api/single-executable-applications.html
- https://github.com/moeru-ai/airi (shell migration; DevLog excerpt only: https://deploy-preview-636--airi-docs.netlify.app/en/blog/devlog-2025.10.20)
