# Orca Mobile

React Native companion app for Orca. Monitor worktrees, view terminal output, and send commands from your phone.

## Prerequisites

- Node.js 24+
- pnpm
- Expo Go app on your phone (from App Store / Google Play), **or** a dev client build

## Quick Start

```bash
cd mobile
pnpm install
pnpm start                 # starts Expo dev server
```

Scan the QR code shown in the terminal with your phone's camera (iOS) or the Expo Go app (Android).

## Development Paths

### I have an Android phone

1. Install Expo Go from Google Play
2. Run `pnpm start`, scan QR with Expo Go
3. For native modules (camera): `npx expo prebuild --platform android && cd android && ./gradlew assembleDebug`
4. Install APK: `adb install android/app/build/outputs/apk/debug/app-debug.apk`
5. Run with `pnpm start --dev-client`

### I only have a Mac (iOS Simulator)

1. Install Xcode from the App Store
2. Run `pnpm start --ios` to open in iOS Simulator

## Mock Server

Develop the mobile app without a running Orca desktop instance:

```bash
pnpm mock-server           # starts mock WebSocket server on port 6768
```

Connect from the app using endpoint `ws://localhost:6768` and token `mock-device-token`.

## Connecting to Real Orca

1. Start Orca desktop with WebSocket transport enabled
2. In Orca, go to Settings > Mobile and scan the QR code with this app
3. The QR encodes the connection endpoint, device token, and TLS fingerprint

## Project Structure

```
mobile/
├── app/                   # Expo Router screens (file-based routing)
│   ├── _layout.tsx        # Root layout with navigation stack
│   ├── index.tsx          # Home screen — paired hosts list
│   └── pair-scan.tsx      # QR code scanning screen
├── src/
│   └── transport/         # WebSocket RPC client (TBD)
├── scripts/
│   └── mock-server.ts     # Standalone mock WebSocket server
└── assets/                # App icons and splash screen
```
