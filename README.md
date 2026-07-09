# Critterfall

Critterfall is an original browser-playable local multiplayer card game for 2 to 6 players. Each player evolves a strange species across a string of Ages, plays Traits with immediate and endgame effects, survives global events, and scores at the end of the final round.

## Install

```bash
npm install
```

## Run Locally

```bash
npm run dev
```

This starts:

- The Socket.IO + Express server on `0.0.0.0:3001`
- The Vite React client on `0.0.0.0:5173`

Open the game locally at:

```text
http://localhost:5173
```

## Run The Single-Port Production App

For online play or tunnels, build the React client and run the Node server:

```bash
npm run build
npm run start
```

Open:

```text
http://localhost:3001
```

In this mode, Express serves the built React app and Socket.IO from the same port.

## Play With A Friend On The Same Wi-Fi

1. Run `npm run dev`.
2. Find your local IPv4 address with:

```bash
ipconfig
```

3. Look for your active network adapter's `IPv4 Address`.
4. Have your friend open:

```text
http://YOUR_IPV4_ADDRESS:5173
```

The server also prints local network client URLs in the terminal when it starts.

## Play Online

Vercel alone is not a good fit for this whole app because the game uses a long-running Socket.IO server. Use one of these instead.

### Option A: Cloudflare Tunnel To Your Laptop

This is the fastest way to use your domain while the game runs on your Mac.

1. Build and start the single-port app:

```bash
npm run build
npm run start
```

2. In another terminal, create a Cloudflare tunnel to port `3001`.

For a quick temporary tunnel:

```bash
npx --yes localtunnel --port 3001
```

For your own Cloudflare domain, install `cloudflared`, authenticate, then create a tunnel route such as `game.jamshiman.com -> http://localhost:3001`.

Both players should open the same public URL. Room codes are stored in server memory, so restarting the server clears rooms.

### Option B: Hosted Node Server

Deploy this whole app as one Node web service on a host that supports WebSockets, such as Render, Railway, Fly.io, or a VPS.

Use these settings:

- Build command: `npm install && npm run build`
- Start command: `npm run start`
- Health check path: `/health`
- Port: use the host-provided `PORT` environment variable
- Optional environment variable: `PUBLIC_ORIGIN=https://game.jamshiman.com`

Then in Cloudflare DNS, point `game.jamshiman.com` to the host-provided domain with a `CNAME`. Keep Cloudflare proxy enabled unless your host asks otherwise. Cloudflare supports WebSockets on the free plan.

For Render, this repo includes `render.yaml`.

## Firewall Note

If another device on your network cannot connect:

1. Make sure both devices are on the same Wi-Fi or LAN.
2. Allow Node.js through Windows Defender Firewall when prompted.
3. Confirm ports `5173` and `3001` are not blocked by local firewall rules.

## Rules Summary

- 2 to 6 players join a room with a room code.
- The host starts the game from the lobby.
- Everyone begins with 5 Trait cards.
- There are 8 normal Ages plus a Final Age.
- At the start of each Age, a global Age card is revealed and resolved.
- Each player gets one turn per Age.
- At the start of your turn, you draw 1 card.
- Then choose one action:
  - Play 1 Trait card.
  - Skip your play and draw 2 cards.
- Some Traits resolve immediate effects right away.
- Played Traits stay on your species board unless destroyed.
- Shields automatically block destructive or discard effects when possible.
- After the Final Age round, final scoring is calculated and the highest total wins.

## Known MVP Limitations

- Game state is stored in server memory only, so restarting the server clears rooms.
- Targeted effects use automatic targeting rather than a manual target picker.
- If a player disconnects mid-game, the room stays alive, but there is no reconnect flow.
- Discard-to-hand-limit uses automatic random discards.
- The UI focuses on clarity and playability over deep polish or animations.

## Scripts

- `npm run dev` - run server and client together
- `npm run build` - build the Vite client
- `npm run check` - syntax-check the server and build the client
- `npm run start` - run the Node server only
