# dsh-quick-menu

A caption dropdown for DeepSeek Harness on Windows. It adds one button — **快捷菜单 ▾** — to the
left of the built-in `应用` / `编辑` caption menus, and folds the three maintenance actions you
otherwise run by hand into it.

| Item | What it does |
| --- | --- |
| 修复 (Repair) | Clears the stale `run.json` / `pending-updates.json` / lock files that keep the plugin manager reporting `another plugin operation is running` (`OPERATION_BUSY`). |
| 打开网页GUI (Web GUI) | Asks the Host for the authenticated Web GUI URL and opens it in the default browser. |
| 重启 DeepSeek (Restart) | Spawns a detached helper, waits for the port to drain, relaunches the Host with its own command line, then terminates the current Host. |

The panel also prints a one-line status (`状态：无阻塞` or what is holding the lock) every time it opens.

## Why it exists

`dsh-plugin-manager` records its current package operation in `.plugin-manager/run.json` and decides
"busy" by probing that pid with `process.kill(pid, 0)`. When Windows recycles the pid, the record
never goes away and every update fails with `exit=127 another plugin operation is running`, while
`.dsh-market/pending-updates.json` keeps an interrupted operation that the market retries on each
start. Repair removes exactly those three things; it never touches installed packages, the lockfile,
or `node_modules`.

## Layout

```
package.json        # dsh.bundle.patch + dsh.client{platform:"web"}
cordis.patch.yml    # inserts the plugin into a profile's layer stack
lib/index.js        # Host half: four JSON routes under /dsh-quick-menu/*
client/client.js    # Browser half: the caption button + self-drawn panel
probe.mjs           # Tiny route tester: node probe.mjs <baseUrl> <path> [method] [token]
```

### Host routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/dsh-quick-menu/web-url` | `{ url }` — the authenticated Web GUI address. |
| `GET` | `/dsh-quick-menu/diagnose` | Profile dir, `run.json` state, pending updates, stray locks, `busy`, `staleInstall`, `installVersion`. |
| `POST` | `/dsh-quick-menu/repair` | `{ removed: [...] }` — clears the lock state. |
| `POST` | `/dsh-quick-menu/restart` | `{ restarting: true, port, launched }` — relaunches the Host. |
| `POST` | `/dsh-quick-menu/reload` | `{ reloaded, installVersion }` — re-publishes this plugin's client bundle through `clientModules.rebuilt()`, so a code change lands without restarting DSH. |

Every `POST` must carry `x-dsh-quick-menu: 1` **and** `content-type: application/json`; a cross-site
form cannot set either, so the mutating routes are not reachable from a foreign page. All routes sit
behind the Host's normal `connection.requestRejection()` check.

### Panel colours

The palette tokens (`--dsw-alias-*`) are injected at runtime and are only declared on the app's own
element tree. The caption lives in a shadow root and the panel hangs off `document.body`, so neither
inherits them — reading `var(--dsw-alias-…)` in either place silently falls back to `initial`
(a white panel with white text). `client/client.js` therefore resolves each token with
`getComputedStyle()` over the document, writes the resulting colour onto the panel directly, and
repaints when `data-ds-dark-theme` / `<head>` change. When nothing declares a token it uses a dark
fallback, never white.

## Install

```powershell
# from the profile directory, e.g. %USERPROFILE%\.dsh\profiles\desktop
pnpm add "file:C:/Users/<you>/.dsh/local-plugins/dsh-quick-menu"
```

Then add `dsh-quick-menu` to `dsh.profile.bundles` in the profile's `package.json` and restart DSH
once. After that, edits to the plugin can be picked up by pressing **修复** with a stale install
detected — it hot-reloads the bundle and refreshes the page.

## Requirements

- DeepSeek Harness desktop build on Windows (`win32`), where `preload-app.cjs` installs the
  `[data-windows-menu]` caption. On macOS / Linux the plugin mounts nothing and stays inert.
- Node 22.19+ or 24+ (the Host's own runtime is fine).

## License

MIT.
