# openfox-tailscale

Community plugin for OpenFox Plugin API v2 that automatically exposes a project's dev server to its **Tailscale tailnet**.

It is the plugin extraction of the original OpenFox PR #233 approach: Tailscale-specific process management stays outside OpenFox core, while OpenFox only exposes generic dev-server lifecycle hooks.

## What it does

- opt-in **per OpenFox project**
- listens to `devserver.started` and `devserver.stopped`
- starts `tailscale serve` in foreground mode
- automatically chooses an unused HTTPS serve port
- reads both persistent and foreground entries from `tailscale serve status --json`
- never calls `tailscale serve reset`
- removes only the serve entry created by the plugin
- exposes the active Tailnet URL in an OpenFox plugin panel
- reports startup/daemon errors through OpenFox notifications
- never enables **Tailscale Funnel**

## Requirements

- OpenFox Plugin API v2
- OpenFox core support for `devserver.started` / `devserver.stopped`
- Tailscale CLI installed and authenticated on the OpenFox host
- permission to use `tailscale serve`

The lifecycle hooks are currently proposed in [co-l/openfox#233](https://github.com/co-l/openfox/pull/233).

## Installation

Once this repository is public, install it from:

**OpenFox → Settings → Plugins → GitHub URL**

and use:

```text
https://github.com/theshwal/openfox-tailscale
```

No plugin build step and no third-party npm dependencies are required.

## Enable for a project

Open the plugin settings for the project and enable:

> **Expose dev server via Tailscale**

The setting is project-scoped and defaults to `false`.

When that project's dev server starts, the plugin creates a Tailnet-only HTTPS preview. When the dev server stops or crashes, the plugin cleans its preview up.

## Safety / coexistence

The plugin deliberately avoids destructive Tailscale operations.

It:

1. reads `tailscale serve status --json`;
2. finds a free HTTPS port;
3. launches a foreground `tailscale serve`;
4. kills that foreground process on cleanup;
5. verifies that the entry disappeared;
6. if necessary, runs only the targeted inverse command:

```bash
tailscale serve --yes --https=<plugin-port> off
```

It **never** calls `tailscale serve reset`, so unrelated pre-existing Serve configuration is preserved.

## Vite note

Recent Vite versions can reject the Tailscale MagicDNS hostname with a `403 Blocked request` unless that hostname is allowed by the project.

When needed, add the Tailnet hostname to Vite's `server.allowedHosts`.

This is a backend-host validation issue, not a Tailscale transport failure.

## Development

The plugin is intentionally small and dependency-free.

```bash
npm test
npm run check
```

Tests use Node's built-in test runner.

## Compatibility

Initial target:

- OpenFox `>= 2.0.151 < 3`
- Plugin API v2
- Tailscale CLI with `serve` foreground support

The plugin API is versioned; OpenFox core changes should not be required for routine plugin updates once the lifecycle hooks are merged.

## Status

Initial community release. Linux is the primary validated host platform inherited from the original PR #233 verification. Additional macOS/Windows validation is welcome.

## License

MIT
