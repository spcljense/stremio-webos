# Stremio for webOS

Standalone and optimized Stremio build for LG webOS TVs.

This project is specifically maintained for webOS and includes faster startup, native media integration, preferred audio language selection, and the official Stremio streaming server.

The Library is optimized for TV use with seven posters per row and reliable Up/Down remote navigation between rows.

The official Stremio app may ignore the user's preferred audio language and simply select the first available audio track. This build reads the tracks exposed by the TV's native media pipeline and automatically selects the track matching your configured language.

Built on Stremio Theater v1.9.2 and stripped of unnecessary non-webOS platform code for a cleaner and faster LG webOS experience.

# Installation

# Homebrew Channel

For rooted LG webOS TVs with [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel):

1. Open **Homebrew Channel** on your TV.
2. Open **Settings**.
3. Add the following repository: https://raw.githubusercontent.com/spcljense/stremio-webos/main/webosbrew/apps.json
4. Return to the app list.
5. Find Stremio and install it.

# Manual installation

You can also install the IPK manually using the webOS CLI.

# Requirements

Node.js
webOS ares CLI
LG TV configured with Developer Mode or SSH/root access

# Install the CLI

npm install -g @webosose/ares-cli

# Configure your TV

ares-setup-device

# Then clone and deploy

git clone https://github.com/spcljense/stremio-webos.git
cd stremio-webos
make deploy

# Or install a downloaded release directly
ares-install --device tv io.strem.webos_VERSION_all.ipk

# Application ID
io.strem.webos

The custom application ID allows this build to coexist with the official Stremio app without package conflicts.
