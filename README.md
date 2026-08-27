# Stremio for LG webOS TVs

[![Latest release](https://img.shields.io/github/v/release/spcljense/stremio-webos?display_name=tag&sort=semver)](https://github.com/spcljense/stremio-webos/releases/latest)
[![Release build](https://github.com/spcljense/stremio-webos/actions/workflows/release.yml/badge.svg)](https://github.com/spcljense/stremio-webos/actions/workflows/release.yml)

An unofficial, standalone Stremio build optimized specifically for LG webOS TVs.

**Minimum requirement: an LG webOS TV from 2020 or newer.** This project was originally created for personal use on an LG CX. After the official Stremio app was removed from the LG Content Store, it was made public to help other LG TV owners continue using Stremio.

This build uses a locally maintained, webOS-only Stremio Theater v1.9.2 frontend together with the official Stremio streaming server.

> [!NOTE]
> This is an independent community project. It is not an official Stremio application and is not affiliated with or endorsed by Stremio.

## Highlights

### Faster and lighter on LG TVs

- The interface can begin loading before the streaming server has completely initialized.
- Static frontend files use proper browser caching and ETags.
- Posters are loaded lazily and remain cached while navigating.
- Catalog rows are rendered around the selected row instead of loading everything at once.
- Horizontal rows are limited to avoid rendering excessive numbers of posters.
- Unnecessary background and fanart loading has been reduced.
- Runtime code for Tizen, TitanOS, NetTV, VIDAA/Hisense and their unused video players has been removed.

On the maintainer's LG CX, startup is more than ten seconds faster than the standard build and navigation feels noticeably smoother.

### TV-optimized Library

- Seven posters per Library row.
- Reliable Up/Down remote navigation between poster rows.
- Preserved spacing between the filters and the first Library row.

### Preferred audio language

The official app can select the first available audio track instead of the language configured in the Stremio profile. This build reads the tracks exposed by the LG webOS native media pipeline and automatically selects the track matching the preferred audio language.

### Standalone application ID

The app uses the ID `io.strem.webos`, allowing it to coexist with the official Stremio app without replacing it or conflicting with its package.

## Installation

### Homebrew Channel

For rooted LG webOS TVs using [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel):

1. Open **Homebrew Channel** on the TV.
2. Open **Settings**.
3. Add this repository URL:

   ```text
   https://raw.githubusercontent.com/spcljense/stremio-webos/main/webosbrew/apps.json
   ```

4. Return to the app list.
5. Find **Stremio** and install it.

### Manual IPK installation

1. Download the latest `io.strem.webos_VERSION_all.ipk` from [GitHub Releases](https://github.com/spcljense/stremio-webos/releases/latest).
2. Install the [webOS CLI](https://github.com/webos-tools-sdk/cli):

   ```bash
   npm install -g @webosose/ares-cli
   ```

3. Configure the TV as a device:

   ```bash
   ares-setup-device
   ```

4. Install the downloaded package, replacing `VERSION` with the release version:

   ```bash
   ares-install --device tv io.strem.webos_VERSION_all.ipk
   ```

The TV must have Developer Mode enabled or provide SSH/root access.

## Building locally

Building requires Linux or WSL, Node.js, Python 3, `make`, `curl`, and the webOS CLI. A clean build downloads the pinned official Stremio streaming server and the ARM64 FFmpeg/FFprobe binaries configured in the `Makefile`.

```bash
git clone https://github.com/spcljense/stremio-webos.git
cd stremio-webos
make test
make package
```

The generated IPK is placed in the repository root.

To build, install and launch the app on a TV configured as `tv`:

```bash
make deploy
```

Useful development commands:

| Command | Purpose |
| --- | --- |
| `make build` | Create a fresh application build |
| `make test` | Build and run the subtitle regression suite |
| `make package` | Build and create an IPK package |
| `make deploy` | Package, install and launch on the TV |
| `make restart` | Close and relaunch the installed app |
| `make clean` | Remove downloaded and generated build artifacts |

## Acknowledgements

- [Stremio](https://www.stremio.com/) for Stremio Theater and the official streaming server.
- [JASSUB](https://github.com/ThaUnknown/jassub) for browser-based ASS/SSA rendering.
- [sickerine/stremio-webos](https://github.com/sickerine/stremio-webos) for the subtitle-pipeline work adapted for this webOS-only build.

## Support

Found a problem specific to this build? Open a [GitHub issue](https://github.com/spcljense/stremio-webos/issues) and include the TV model, webOS version, release version and steps needed to reproduce it.

Enjoying the project? [Support its development on Ko-fi](https://ko-fi.com/spcljense). Every contribution helps keep the project going. ✨
