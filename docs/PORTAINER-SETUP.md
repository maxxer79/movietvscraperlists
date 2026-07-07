# Portainer setup — step by step

This deploys the app as a **Stack** in Portainer using the Docker image that
GitHub Actions published. Do the [GitHub setup](GITHUB-SETUP.md) first so the
image `ghcr.io/YOURNAME/movietvscraperlists:latest` exists.

---

## 1. Generate a session secret

You'll need a long random string to encrypt saved logins. Generate one:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Copy the output — you'll paste it in step 3.

---

## 2. (Only if your GHCR package is Private) add a registry in Portainer

Skip this if you set the package to **Public** in GitHub.

1. Portainer → **Registries** → **Add registry** → **Custom registry**.
2. **Name:** `GHCR` · **URL:** `ghcr.io`
3. **Username:** your GitHub username · **Password:** a GitHub Personal Access
   Token with `read:packages`.
4. **Add registry.**

---

## 3. Create the stack

1. Portainer → **Stacks** → **Add stack**.
2. **Name:** `movietvscraperlists`
3. **Build method:** **Web editor**, and paste this (replace `YOURNAME` and the secret):

```yaml
services:
  movietv:
    container_name: movietvscraperlists
    image: ghcr.io/YOURNAME/movietvscraperlists:latest
    restart: unless-stopped
    environment:
      PORT: "8088"
      DATA_DIR: "/data"
      HEADLESS: "true"
      SESSION_SECRET: "PASTE-YOUR-RANDOM-SECRET-HERE"
      APP_PASSWORD: ""          # optional: set to password-protect the UI
      ENABLED_PROVIDERS: "fandango,sony,moviesanywhere,universal"
    volumes:
      - movietv_data:/data
    ports:
      - "8088:8088"

volumes:
  movietv_data:
```

4. Click **Deploy the stack**.

> The `movietv_data` volume holds your saved logins and scraped lists — it
> survives updates and restarts. Keep it; deleting it logs you out of everything.

---

## 4. Verify it's running

- Portainer → **Containers** → `movietvscraperlists` should be **running**.
- Open `http://<your-docker-host-ip>:8088` in a browser — you should see the app
  with the version badge in the top-right.
- Click **Logs** on the container if it isn't healthy.

---

## 5. Updating to a new build

Whenever you `git push` (GitHub builds a new image):

1. Portainer → **Stacks** → `movietvscraperlists`.
2. Toggle **Re-pull image** and click **Update the stack** (or **Pull and redeploy**).

The version badge on the page confirms the new build number is live.

---

## Notes on resources

Playwright/Chromium needs a bit of RAM during a sync. Give the host/container
at least **1 GB** available. If syncs crash, raise the memory limit on the
container (Portainer → container → **Duplicate/Edit** → Resources).

Next: expose it on your own domain with **[CADDY-SETUP.md](CADDY-SETUP.md)**.
