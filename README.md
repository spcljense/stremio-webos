<img width="1920" height="1080" alt="capture" src="https://github.com/user-attachments/assets/b2a4967c-1b01-44e9-a3f3-6b766fc87658" />
<img width="1920" height="1080" alt="capture2" src="https://github.com/user-attachments/assets/5854e415-5ecf-4176-ad99-3664858bac32" />


# Stremio for webOS

Standalone and optimized Stremio build for LG webOS TVs.

This project is specifically maintained for webOS and focuses on improved performance, native LG media integration, correct audio track selection, multi-profile support for eligible accounts, and a streamlined TV experience.

Built on Stremio Theater and stripped of unnecessary non-webOS platform code for a cleaner and faster LG webOS experience.

## Features

- Multi-profile support for users with an active Stremio Supporter subscription
- Profile selection directly on the TV
- Support for PIN-protected profiles
- Faster startup and responsive TV navigation
- Native LG webOS media player integration
- Automatic preferred audio language selection
- Improved handling of multiple audio tracks
- Official Stremio streaming server integration
- Optimized specifically for LG webOS TVs
- Standalone application ID, allowing installation alongside the official Stremio app

### Preferred audio language

The official Stremio app may sometimes select the first available audio track instead of the user's configured preferred language.

This build reads the audio tracks exposed by the LG TV's native media pipeline and automatically selects the track matching the preferred audio language configured in Stremio.

### Multi-profile support

Starting with **stremio-webos 1.1.0**, this build supports Stremio multi-profile functionality.

Multi-profile access is available only to accounts with an active **Stremio Supporter subscription**.

Eligible users can select between their available profiles directly on the TV. PIN-protected profiles are also supported.

Free accounts do not have access to Stremio's multi-profile feature.

# Installation

## Homebrew Channel

For rooted LG webOS TVs with [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel):

1. Open **Homebrew Channel** on your TV.
2. Open **Settings**.
3. Add the following repository:

   `https://raw.githubusercontent.com/spcljense/stremio-webos/main/webosbrew/apps.json`

4. Return to the app list.
5. Find **Stremio**.
6. Install and launch the app.

Updates published through this repository can also be installed through Homebrew Channel.

## GitHub Release

Prebuilt IPK packages are available from the GitHub Releases page:

[Download the latest release](https://github.com/spcljense/stremio-webos/releases/latest)

Download the IPK matching the current release, for example:

```text
io.strem.webos_1.1.0_all.ipk
 
