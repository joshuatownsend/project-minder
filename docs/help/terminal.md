# Terminal Launch

The **Resume** button on a session detail page launches your terminal application and starts `claude --resume <sessionId>` in the project's working directory.

## Auto-detection

Project Minder detects your platform's default terminal:

| Platform | Default |
|----------|---------|
| Windows | Windows Terminal (`wt.exe`) if installed, otherwise `cmd.exe` |
| macOS | `Terminal.app` via AppleScript (`osascript`) |
| Linux | `gnome-terminal`, then `konsole`, then `xterm` |

## Override

Go to **Settings → Terminal** and enter a binary name (e.g. `alacritty`) to use a specific emulator. Leave blank to restore auto-detection.

Only the binary name is accepted — no flags or paths. The binary must be on your `PATH`.

## Fallback

If the terminal launch fails (binary not found, permission denied, etc.), a toast appears with the full command to copy and paste manually:

```
claude --resume <sessionId>
```

You can also access "Copy command" from the dropdown arrow next to the Resume button.

## Test launch

Use **Test launch** in Settings → Terminal to open a terminal at the current working directory without running any command, confirming the binary is detected correctly.

## Windows limitation

On Windows, `fs.chmod(0o600)` is a no-op. The `secrets.json` file inherits the ACL of the `~/.minder/` directory. For tighter permissions, run manually:

```
icacls "%USERPROFILE%\.minder\secrets.json" /inheritance:r /grant:r "%USERNAME%":F
```
