# ChartKit desktop shell

One process: the window is a webview pointed at the axum server this same binary
starts on `127.0.0.1` with an OS-chosen free port. The web client keeps using
relative `/api` and `/api/live` URLs, so nothing about it changes between the CLI
server, a browser, and the installed app.

## Run it

| What | Command |
| --- | --- |
| Window, development | `npm run build --prefix ui` then `cargo run -p chartkit-desktop` |
| Window, release + NSIS installer (Windows) | `cargo tauri build` in this folder |
| Server only, no window | `cargo run -p chartkit-desktop -- --serve-only`, then open the printed URL |

`cargo tauri build` needs [tauri-cli](https://v2.tauri.app/start/prerequisites/)
(`cargo install tauri-cli --version "^2" --locked`) and, on Windows, the MSVC
build tools. It writes `ChartKit_0.1.0_x64-setup.exe` under
`target/release/bundle/nsis/` — the workspace target dir, not `desktop/target`.
`.github/workflows/windows-installer.yml` runs the same build on `windows-latest`.

## Where things live

- Database: `app.path().app_local_data_dir()`, i.e. `%LOCALAPPDATA%\app.chartkit\chartkit.db`
  on Windows and `~/.local/share/app.chartkit/chartkit.db` on Linux. Local rather than
  roaming because the file grows with history.
- First run copies an existing `~/.chartkit/chartkit.db` (the command line server's
  directory) into that folder. The copy is left in place, so both entry points work.
- Web client: `ui/dist` is embedded in the executable and installed as the `ui`
  resource folder. The lookup order is `CHARTKIT_UI_DIR`, `<resources>/ui`,
  `<resources>/dist`, `<exe dir>/ui`, then `../ui/dist`. `desktop/gen/` is written
  by the build.
