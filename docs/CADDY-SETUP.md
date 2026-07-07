# Caddy setup — make it live at your own URL

Caddy will reverse-proxy your domain to the container and handle HTTPS
certificates automatically. Pick the section that matches your setup.

Assumes the container is running (see [PORTAINER-SETUP.md](PORTAINER-SETUP.md))
and listening on port **8088**.

---

## 1. Point your domain at the server

Create a DNS **A record** (or AAAA for IPv6) for the hostname you want, e.g.
`movies.example.com`, pointing at your server's public IP. Give DNS a few
minutes to propagate.

Make sure ports **80** and **443** on the server reach Caddy (open them on your
router/firewall).

---

## 2A. If Caddy runs directly on the host

Edit your `Caddyfile` (often `/etc/caddy/Caddyfile`) and add:

```caddy
movies.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8088
}
```

Reload Caddy:

```bash
sudo systemctl reload caddy      # or: caddy reload --config /etc/caddy/Caddyfile
```

---

## 2B. If Caddy runs as a Docker container

Put Caddy and the app on the **same Docker network** so Caddy can reach the app
by its container name (no published port needed).

```caddy
movies.example.com {
	encode zstd gzip
	reverse_proxy movietvscraperlists:8088
}
```

If they're on different networks, use the published host port instead:

```caddy
movies.example.com {
	reverse_proxy <docker-host-ip>:8088
}
```

Reload the Caddy container:

```bash
docker exec -w /etc/caddy <caddy-container-name> caddy reload
```

---

## 3. Test

Open `https://movies.example.com`. You should see the app over HTTPS with a
valid certificate (Caddy fetches it from Let's Encrypt automatically on first
request — the first load can take a few seconds).

A starter file is included at the repo root: **`Caddyfile.example`**.

---

## Troubleshooting

- **Cert not issued / "context deadline exceeded":** ports 80/443 must be open
  and DNS must resolve to this server. Caddy needs port 80 reachable for the
  ACME challenge.
- **502 Bad Gateway:** the app container isn't reachable at the address in
  `reverse_proxy`. Confirm the container is running and, if using the container
  name, that Caddy shares its Docker network.
- **Login pages behave oddly behind the proxy:** the app uses same-origin API
  calls, so no extra CORS/headers are required — but make sure you're visiting
  the HTTPS URL, not mixing http/https.
