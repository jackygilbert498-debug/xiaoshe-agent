# DeepSeek Harness runtime

[中文](README.zh.md) | English

This directory contains the DSH runtime used by Xiaoshe. DSH provides the Cordis-based plugin host, agent loop, sessions, model routing, tools, skills, approvals, Web UI, and CLI.

The source is kept in this repository so Xiaoshe can be installed and built without relying on an opaque runtime binary.

## Build

From the Xiaoshe repository root:

```sh
pnpm --dir runtime/DSH install --frozen-lockfile
pnpm --dir runtime/DSH run build
```

Run the CLI or Web host after the build:

```sh
pnpm --dir runtime/DSH dsh --help
pnpm --dir runtime/DSH dsh web --no-open
```

Xiaoshe's setup scripts add the product plugins and Profile patch. For a complete installation, use `setup/install-windows.ps1` or `setup/install-macos.sh` from the repository root.

## License

DSH is distributed under the [MIT License](LICENSE). Third-party dependencies and notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
