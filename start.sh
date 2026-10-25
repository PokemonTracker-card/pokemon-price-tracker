#!/usr/bin/env bash
# (Re)start the Pokémon price tracker server and a public cloudflared quick tunnel.
cd "$(dirname "$0")"
pkill -f "node server.js" 2>/dev/null; pkill -f "cloudflared tunnel" 2>/dev/null; sleep 1
nohup node server.js > server.log 2>&1 &
nohup cloudflared tunnel --no-autoupdate --protocol http2 --url http://localhost:8787 > tunnel.log 2>&1 &
for i in $(seq 1 30); do u=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' tunnel.log | head -1); [ -n "$u" ] && break; sleep 1; done
echo "Local:  http://localhost:8787"; echo "Public: ${u:-'(not ready yet - check tunnel.log)'}"
