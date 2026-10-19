# dsh-remote-shell

A DSH (DeepSeek Harness) plugin that bundles the **remote-shell** skill: secure SSH / SFTP / Telnet / WinRM remote operations with an encrypted credential vault (Fernet + PBKDF2-HMAC-SHA256).

中文说明见 [README.zh.md](./README.zh.md)。

## Installation

From the npm registry (once published):

```bash
dsh plugin --profile web add dsh-remote-shell
```

From a local checkout (development / testing):

```bash
dsh plugin --profile web add /path/to/dsh-remote-shell
```

Then restart `dsh web` for the plugin to take effect. The skill appears in the skill catalog as `remote-shell` (provider `dsh-remote-shell`, source `bundled`).

## Features

The bundled skill provides:

- **Remote command execution** over SSH / WinRM / Telnet: single commands, batch execution, script execution, remote system information, and health checks.
- **SFTP file transfer**: upload, download, and directory listing.
- **Encrypted credential vault**: login/execution scripts never accept plaintext passwords (there is no `-p` flag); credentials are always fetched from the encrypted vault. Use `credctl` to add, list, update, and remove credentials.
- **Safety interception**: mutating commands are blocked by default and only run after explicit user confirmation (`--auto-confirm`).

## How it works

The plugin is a Cordis plugin that injects a single **skills provider**. On load it scans the bundled `skills/` directory for `SKILL.md` files, parses each file's YAML frontmatter, and registers the skill with the host's skill registry (rank 600, source `bundled`). The provider is immutable: it performs no file watching or polling, and a missing or malformed skill degrades gracefully (skipped, never thrown).

## Line-ending policy

The bundled skill files are copied verbatim from the source skill, which uses **mixed** line endings. `.gitattributes` pins each file to its source line ending so checkouts (under any `core.autocrlf` setting) reproduce the source bytes exactly. `SKILL.md` is pinned to LF because the provider's frontmatter detection requires exact `---` lines — a CRLF checkout would make the provider skip the skill entirely.

## Development

Run the unit tests (Node.js built-in test runner, no extra tooling):

```bash
node --test
```

## Dependencies

The skill's scripts are written in Python 3 and require third-party libraries such as `paramiko` (SSH/SFTP) and `pywinrm` (WinRM). Install them on first use following the instructions in the skill's `SKILL.md`.

## Security Notice

Installing this plugin runs third-party code on your machine. The credential vault master password is managed by you; the plugin does not store or transmit it.

## License

MIT — see [LICENSE](./LICENSE).
