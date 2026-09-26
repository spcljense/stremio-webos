<img width="1920" height="1080" alt="capture" src="https://github.com/user-attachments/assets/eb5f79c2-3f2c-4ddb-b8cc-061b02a56196" />
<img width="1920" height="1080" alt="capture2" src="https://github.com/user-attachments/assets/5c86999c-aed8-4fbb-9517-e809bf472c7a" />

Stremio for webOS

Standalone and optimized Stremio build for LG webOS TVs.

This project is maintained specifically for LG webOS and focuses on performance, native TV integration, improved media playback, multi-profile support, and additional TV-focused features.

Built on Stremio Theater and stripped of unnecessary non-webOS platform code for a cleaner, faster, and more streamlined LG webOS experience.

Features

* Multi-profile support for users with an active Stremio Supporter subscription
* Profile selection directly on the TV
* Support for PIN-protected profiles
* SkipDB integration for supported movies and episodes
    * Skip Intro
    * Skip Recap
    * Skip Outro
    * Visual segment markers in the playback timeline
* Faster startup and responsive TV navigation
* Native LG webOS media player integration
* Automatic preferred audio language selection
* Improved handling of multiple audio tracks
* Official Stremio streaming server integration
* Optimized specifically for LG webOS TVs
* Standalone application ID, allowing installation alongside the official Stremio app

SkipDB integration

This build integrates SkipDB to provide chapter-like skip segments for supported movies and episodes.

When segment information is available in the SkipDB database, the player can identify sections such as Intro, Recap, and Outro and expose them directly during playback.

Supported segments are also displayed as visual markers in the playback timeline, making their position and duration visible while seeking.

SkipDB availability depends on whether segment data exists for the currently playing title or episode.

Preferred audio language

The official Stremio app may sometimes select the first available audio track instead of the user’s configured preferred language.

This build reads the audio tracks exposed by the LG TV’s native media pipeline and automatically selects the track matching the preferred audio language configured in Stremio.

This provides more consistent language selection when streams contain multiple audio tracks.

Multi-profile support

Starting with stremio-webos 1.1.0, this build supports Stremio multi-profile functionality.

Multi-profile access is available only to accounts with an active Stremio Supporter subscription.

Eligible users can select between their available profiles directly on the TV. PIN-protected profiles are also supported.

Free accounts do not have access to Stremio’s multi-profile feature.

Installation alongside official Stremio

This build uses its own application ID and can therefore be installed alongside the official Stremio application on the same LG webOS TV.

This makes it possible to use or test this build without replacing the official Stremio installation.

# Installation

## Homebrew Channel

For [rooted (OPTIONAL NOT REQUIRED)] LG webOS TVs with [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel):

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
 
