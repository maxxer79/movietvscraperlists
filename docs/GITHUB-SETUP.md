# GitHub setup — step by step

This gets your code onto GitHub and turns on the automatic build. Every push to
`main` will: bump the build number, compile the app (your confirmation that it
built), and publish a ready-to-run Docker image to **GitHub Container Registry
(GHCR)** that Portainer can pull.

You only do steps 1–5 once. After that, every change is just `git push`.

---

## 0. One-time: install Git & sign in (if you haven't)

- Install Git: https://git-scm.com/download/win
- Tell Git who you are (use your GitHub email):

```powershell
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

---

## 1. Create the repository on GitHub

1. Go to https://github.com/new
2. **Repository name:** `movietvscraperlists`
3. Choose **Private** (recommended — this app touches your accounts).
4. **Do NOT** check "Add a README / .gitignore / license" (the project already has them).
5. Click **Create repository**. Leave that page open — you'll need the URL.

---

## 2. Initialize Git locally and make the first commit

Run these from the project folder (`c:\dev\movietvscraperlists`):

```powershell
git init
git branch -M main
git add .
git commit -m "Initial commit: MovieTVScraperLists foundation + Fandango scraper"
```

> `.gitignore` already excludes `node_modules/`, `.env`, and the `data/` folder
> (your saved logins never get committed).

---

## 3. Connect your local repo to GitHub and push

Copy the HTTPS URL GitHub showed you (looks like
`https://github.com/YOURNAME/movietvscraperlists.git`), then:

```powershell
git remote add origin https://github.com/YOURNAME/movietvscraperlists.git
git push -u origin main
```

If prompted to log in, a browser window opens — sign in and authorize. Done.

---

## 4. Watch the build run (your confirmation)

1. On GitHub, open your repo → **Actions** tab.
2. You'll see the **Build & Publish** workflow running from your push.
3. Green check ✅ = it compiled and published the image. Red ✗ = open it to read the log.

The workflow also commits a small `chore: build ...` version bump back to the repo —
that's expected, and it's tagged `[skip ci]` so it doesn't loop.

---

## 5. Make the published image available to Portainer

The image is published to `ghcr.io/YOURNAME/movietvscraperlists`. Two quick settings:

1. **Make the package pullable by Portainer.** On GitHub go to your profile →
   **Packages** → `movietvscraperlists` → **Package settings**.
   - Easiest: set **Visibility → Public** (the image contains no secrets; your
     data lives only in the container's volume, never in the image).
   - Or keep it Private and create a **Personal Access Token** (classic) with the
     `read:packages` scope to log Portainer's host into GHCR:
     ```bash
     docker login ghcr.io -u YOURNAME   # paste the token as the password
     ```

2. Note your image name — you'll paste it into the Portainer stack next:
   ```
   ghcr.io/YOURNAME/movietvscraperlists:latest
   ```

---

## Everyday workflow after setup

```powershell
git add .
git commit -m "Describe your change"
git push
```

Each push → Actions builds & publishes a new image + bumps the version number.
In Portainer, **Recreate/Pull** the stack to run the new build (see PORTAINER-SETUP.md).

---

## Troubleshooting

- **Actions failed at "Build and push image" with a permissions error:** go to
  repo → **Settings → Actions → General → Workflow permissions** and select
  **Read and write permissions**, then re-run the workflow.
- **`git push` rejected:** run `git pull --rebase origin main` then push again
  (usually the Action's version-bump commit is ahead of your local copy).
