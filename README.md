# Crossroads

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/iniyan/Crossroads)

**Crossroads** is a high-fidelity, audiophile-grade music player designed specifically for FLAC enthusiasts. Inspired by the soulful roots of the Delta Blues and the technical precision of modern high-end audio, Crossroads offers an immersive, bit-perfect listening experience.

![Crossroads Hero](https://github.com/iniyan/Crossroads/raw/main/assets/hero.png)

## 🌟 Features

- **Bit-Perfect Playback**: Native support for high-resolution FLAC files with technical metadata (sample rate, bitrate, bit depth) always visible.
- **Immersive Lyrics**: Real-time, synchronized lyrics fetched via LRCLIB, featuring a deep-blurred album art background and smooth transitions.
- **Apple Music-Style Mini Player**: A compact, vertical window mode with dedicated tabs for 'Now Playing', 'Lyrics', and 'Current Queue'.
- **Smart Playlists**: Automatically generated collections for your Favorites, Recently Played, and Top Tracks.
- **Audiophile Statistics**: Track your listening habits with 'Stats for Nerds', including total playback time and high-res badges.
- **Premium Aesthetics**: A modern, glassmorphic UI with vibrant micro-animations, custom icons (Lucide), and macOS vibrancy effects.
- **Global Media Controls**: Support for hardware media keys and global keyboard shortcuts (Space, Arrow keys).

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher)
- [npm](https://www.npmjs.com/)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/iniyan/Crossroads.git
   cd Crossroads
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the development server:**
   ```bash
   npm run dev
   ```

### Building for Production

To create a distributable installer for your OS:

```bash
npm run dist
```
The installer will be generated in the `release/` directory.

## 🎹 Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Space` | Play / Pause |
| `→` (Right Arrow) | Next Track |
| `←` (Left Arrow) | Previous Track (or restart if >3s) |
| `Cmd/Ctrl + O` | Scan Music Folder |

## 🛠 Tech Stack

- **Core**: [React](https://reactjs.org/) & [Vite](https://vitejs.dev/)
- **Desktop Wrapper**: [Electron](https://www.electronjs.org/)
- **State Management**: React Hooks & [Electron Store](https://github.com/sindresorhus/electron-store)
- **Metadata Parsing**: [Music-Metadata](https://github.com/borewit/music-metadata)
- **Lyrics API**: [LRCLIB](https://lrclib.net/)
- **Icons**: [Lucide React](https://lucide.dev/)

---

*“I went to the crossroad, fell down on my knees...” — Robert Johnson*

Created with ❤️ by the Crossroads Team.
