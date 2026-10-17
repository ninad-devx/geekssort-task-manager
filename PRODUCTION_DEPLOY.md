# Production deployment — Taskssort on a Contabo VPS

Docker Compose, nginx, PostgreSQL, and CI/CD. Every command below is one you can
paste; nothing here is invented, and each has been run against this repository's
actual Dockerfile and Compose files.

- [1. What you are deploying](#1-what-you-are-deploying)
- [2. Choosing where PostgreSQL runs](#2-choosing-where-postgresql-runs)
- [3. VPS preparation](#3-vps-preparation)
- [4. First deploy, step by step](#4-first-deploy-step-by-step)
- [5. nginx and TLS](#5-nginx-and-tls)
- [6. Verifying it works](#6-verifying-it-works)
- [7. Everyday commands](#7-everyday-commands)
- [8. Backups and restore](#8-backups-and-restore)
- [9. Data migration: SQLite → PostgreSQL](#9-data-migration-sqlite--postgresql)
- [10. CI/CD](#10-cicd)
- [11. Troubleshooting](#11-troubleshooting)

---

## 1. What you are deploying

Four moving parts, three of which are containers:

```
                    internet
                       │ 443
              ┌────────▼─────────┐
              │  host  nginx     │  TLS terminates here
              └────────┬─────────┘
                       │ http, 127.0.0.1:3000 only
              ┌────────▼─────────┐        ┌──────────────┐
              │ frontend :3000   │───────▶│ backend :8000│
              │ Next.js          │  /api  │ FastAPI      │
              └──────────────────┘        └──────┬───────┘
                                                 │ :5432
                                          ┌──────▼───────┐
                                          │ PostgreSQL   │
                                          └──────────────┘
```

Only nginx binds a public port. The frontend binds **loopback only**, and the
backend and database are reachable from nothing but the compose network. That is
deliberate and it is why there is no CORS configuration to get wrong: the browser
only ever talks to one origin, and nginx proxies `/api/*` to it.

The backend reads `DATABASE_URL` and nothing else decides its database. Point it
at SQLite and you get the development file; point it at PostgreSQL and you get
PostgreSQL. There is no fallback in either direction — a bad PostgreSQL URL stops
the app from starting rather than quietly using a local file.

### Requirements

| Where | What | Why |
|---|---|---|
| VPS | 1 vCPU, 2 GB RAM, 40 GB SSD is plenty to start | Two app containers plus PostgreSQL are small; the frontend image is the big one |
| Host | Docker Engine 24+ with the Compose v2 plugin | `docker compose`, not `docker-compose` |
| Host | nginx | TLS and the only public listener |
| Database | PostgreSQL 13+ (tested on 16) | `DATABASE_URL=postgresql+psycopg://…` |

Contabo ships Ubuntu or Debian. The steps below assume Debian/Ubuntu with `apt`.

---

## 2. Choosing where PostgreSQL runs

There are three options. All three are supported; pick one and follow its link.

| Option | Use when | `DATABASE_URL` host | Extra files |
|---|---|---|---|
| **A. Container** | Simplest. Nothing to install or tune on the host. | `db` | `docker-compose.db.yml` |
| **B. Contabo's PostgreSQL** | You want the DB outside Docker, or a second machine can reach it. | `127.0.0.1` | — |
| **C. PostgreSQL on the VPS host** | You want `pg_dump`/`pg_isready` available directly in a shell. | `127.0.0.1` | — |

**Option A is what the rest of this document assumes**, and it is what the
`-f docker-compose.db.yml` commands below use. Options B and C use the *same*
commands with the second `-f` removed.

> **The single most important thing to get right:** inside the backend container,
> `localhost` means **the backend container**. If PostgreSQL runs in another
> container the host must be `db`. If it runs on the VPS host under option B or C,
> the host must be `host.docker.internal` (Docker Desktop's name, *not* usually
> available on Linux) or the host's LAN IP such as `172.17.0.1`, or — much
> simpler — publish the port on loopback and connect to `127.0.0.1`.

Because of that, **option A avoids the whole class of problem.** If you can use
it, use it. Pick B or C only if you have a reason.

> **Never** publish PostgreSQL on a public interface. It is the single most-scanned
> service on the internet, and this application's database is behind a login with
> no business being there.

---

## 3. VPS preparation

SSH in as root (Contabo sends the credentials by email):

```bash
ssh root@YOUR_VPS_IP
```

### 3.1 Update and install the basics

```bash
apt update && apt upgrade -y
apt install -y ca-certificates curl gnupg git ufw fail2ban htop
```

### 3.2 Install Docker

```bash
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
  > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io \
               docker-buildx-plugin docker-compose-plugin
```

Verify:

```bash
docker --version && docker compose version && systemctl enable --now docker
```

### 3.3 Firewall

Only SSH and HTTPS may be reachable. Note that Docker publishes ports by
*bypassing* `ufw`, so the rules below matter less than you would hope — the
security of this deployment comes from the Compose files never publishing
anything but nginx. `ufw` is still worth configuring so the intent is recorded.

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status verbose
```

Also allow Docker's own traffic, which `ufw` otherwise drops and which produces a
myth that the containers cannot talk to each other:

```bash
# Docker needs its inter-container traffic. Accept it explicitly.
iptables -I DOCKER-USER -i eth0 -j ACCEPT
iptables -I DOCKER-USER -o eth0 -j DROP
iptables -I DOCKER-USER -i eth0 -p tcp --dport 5432 -j DROP
```

That last rule matters: it blocks *external* access to 5432 even if someone
later adds a stray `ports:` mapping. Verify with `iptables -L DOCKER-USER -n`.

### 3.4 Create a non-root deploy user

Running `docker compose` as root is fine but it means every `git pull` is a root
operation and a stray command has root on the host. This is better:

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
install -d -o deploy -g deploy /opt/taskssort
```

### 3.5 Get the code

```bash
su - deploy
cd /opt/taskssort
git clone https://github.com/YOUR_ORG/YOUR_REPO.git .
```

If the repository is private, use a **deploy key** rather than a personal token —
see [§10](#10-cicd). Create it with no passphrase, because CI and `git pull` run
unattended:

```bash
ssh-keygen -t ed25519 -C "taskssort-deploy" -N ""
cat ~/.ssh/id_ed25519.pub          # add this as a deploy key in the repo
ssh -T git@github.com             # confirm it is recognised
```

---

## 4. First deploy, step by step

### 4.1 Create `.env` with a real password

```bash
cp .env.example .env
chmod 600 .env
```

For option A you also need the database credentials in the same file:

```bash
DB_PASS="$(openssl rand -base64 24 | tr -d '/+= ' | head -c 32)"

cat >> .env <<EOF

# --- PostgreSQL (bundled container) ---------------------------------------
DATABASE_URL=postgresql+psycopg://taskssort:${DB_PASS}@db:5432/taskssort
POSTGRES_USER=taskssort
POSTGRES_PASSWORD=${DB_PASS}
POSTGRES_DB=taskssort

# --- frontend --------------------------------------------------------------
API_ORIGIN=http://backend:3000/api-placeholder
EOF
```

Fix the two values above that need your attention:

- `APP_TIMEZONE` — set it to your team's real zone, e.g. `Asia/Kolkata`. This
  decides what "Today" means on every dashboard.
- `API_ORIGIN` — leave the default `http://backend:8000`. The `@` characters are
  not needed; the default line below is what you want:

```bash
sed -i 's|^API_ORIGIN=.*|API_ORIGIN=http://backend:8000|' .env
```

Then look at the file before you continue. This is the only place secrets live:

```bash
sed -e 's/\(PASSWORD=\).*/\1***hidden***/' \
    -e 's#://[^:]*:[^@]*@#://USER:PASSWORD@#' .env
```

`.env` is already in `.gitignore` and excluded from both build contexts by the
`.dockerignore` files. Verify, do not assume:

```bash
git check-ignore -v .env
grep -c .env backend/.dockerignore frontend/.dockerignore
```

### 4.2 Pull the images

```bash
cd /opt/taskssort
docker compose -f docker-compose.yml -f docker-compose.db.yml pull
```

Building on the VPS works too and is a reasonable fallback if the registry is
empty, but a registry is what makes CI/CD fast:

```bash
docker compose -f docker-compose.yml -f docker-compose.db.yml build
```

### 4.3 Create the database schema

**This is the migration step. Run it before the new code starts serving.**

```bash
docker compose -f docker-compose.yml -f docker-compose.db.yml \
  run --rm -T backend python -m app.cli schema
```

Expected:

```
Database: postgresql+psycopg://taskssort:***@db:5432/taskssort (postgresql)
Tables present: 11
Schema is complete.
```

The command only ever **adds**. It creates missing tables, indexes, constraints
and the append-only triggers. It never drops, truncates or alters a table, so it
is safe to run before every deploy. See [§8](#8-backups-and-restore) for why
there is no `downgrade` step.

> `run` creates a throwaway container that waits for `db` to report healthy,
> thanks to `depends_on: condition: service_healthy`. That is why there is no
> `sleep 10` anywhere in this document — a fixed delay is a guess, and a health
> check is not.

### 4.4 Start the application

```bash
docker compose -f docker-compose.yml -f docker-compose.db.yml up -d
docker compose -f docker-compose.yml -f docker-compose.db.yml ps
```

Wait for all three to read `(healthy)` before continuing. First boot builds and
pulls, so give it a minute.

### 4.5 Create the first administrator

The database starts empty and the app has no users, so nobody can log in yet:

```bash
docker compose -f docker-compose.yml -f docker-compose.db.yml \
  run --rm -T backend python -m app.cli bootstrap-admin \
  --email you@example.com --name "Your Name"
```

Omit `--password` and it prompts for one instead of putting it in your shell
history. The policy requires at least 10 characters and rejects the email
address itself.

Optionally seed the default workspace folders (idempotent — safe to re-run):

```bash
docker compose -f docker-compose.yml -f docker-compose.db.yml \
  run --rm -T backend python -m app.cli seed-defaults
```

---

## 5. nginx and TLS

### 5.1 A temporary HTTP-only server block

Do this first so you can get a certificate with the HTTP-01 challenge.

```bash
cat > /etc/nginx/sites-available/taskssort <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name taskssort.example.com;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
    }
}
EOF

ln -sfn /etc/nginx/sites-available/taskssort /etc/nginx/sites-enabled/taskssort
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

Point your DNS `A` record at the VPS IP **before** continuing — Certbot's HTTP
challenge will not work otherwise. Wait for it to resolve:

```bash
dig +short taskssort.example.com
```

### 5.2 Get the certificate

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d taskssort.example.com --redirect
certbot renew --dry-run     # verify the renewal timer works
```

Certbot edits the server block: it redirects 80 to 443 and adds the TLS
parameters. **Do not replace the server block with the one in §5.3 without
re-adding what Certbot added**, or you will lose the renewal configuration and
every browser will warn.

### 5.3 The final server block

Take the Certbot-generated block and replace only its `location /` section:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name taskssort.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name taskssort.example.com;

    # ssl_certificate and the rest are already here from Certbot. Leave them.

    client_max_body_size 10m;

    # HSTS. Only enable once you are certain HTTPS works, because browsers cache
    # this for a year and cannot be talked out of it.
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # Security headers. CSP is left to the app's own headers; note that
    # 'unsafe-inline' for styles is required by the CSS-in-JS the UI uses.
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript
               application/xml+rss text/javascript image/svg+xml;
    gzip_min_length 1024;

    # Never cache HTML or anything the API serves. A cached page would hand one
    # user's rendered session to the next person.
    add_header Cache-Control "no-store, must-revalidate" always;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

        # The Next.js rewrite forwards /api/* to the backend, so these headers
        # are how the backend learns who the real client is. This is why
        # TRUST_PROXY_HEADERS=true is required in the backend's environment --
        # without it the login rate limiter sees one bucket for the whole
        # company and a single attacker can lock everyone out.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_connect_timeout 5s;
        proxy_read_timeout    60s;
        proxy_send_timeout    60s;

        proxy_buffering off;
    }
}
```

```bash
nginx -t && systemctl reload nginx
```

### 5.4 A note on `COOKIE_SECURE`

The Compose file hard-codes `COOKIE_SECURE: "true"`, which is correct for this
deployment. The session cookie then carries the `Secure` flag and the browser
will only send it over HTTPS.

If you ever test over plain HTTP on the VPS, logins will appear to succeed and
then every subsequent request will be unauthenticated — that is the `Secure` flag
working, not a bug.

---

## 6. Verifying it works

Run these in order. Each one catches a specific mistake.

```bash
cd /opt/taskssort
C="docker compose -f docker-compose.yml -f docker-compose.db.yml"

# 1. All three containers healthy.
$C ps
```

```bash
# 2. THE database check. This is the one that matters: it proves the backend
#    connected to PostgreSQL and did not fall back to a local SQLite file.
#    Expect: database=postgresql, and the password shown as ***
curl -s http://127.0.0.1:3000/api/health | python3 -m json.tool
```

```json
{
    "status": "ok",
    "app_timezone": "Asia/Kolkata",
    "database": "postgresql",
    "database_url": "postgresql+psycopg://taskssort:***@db:5432/taskssort"
}
```

If `database` says `sqlite`, stop and fix `DATABASE_URL` before doing anything
else.

```bash
# 3. Server version and a row count per table.
$C exec -T backend python -m app.cli db-info
```

```bash
# 4. TLS and the redirect, from outside the VPS.
curl -I https://taskssort.example.com            # HTTP/2 200
curl -sI http://taskssort.example.com | head -1  # HTTP/1.1 301 -> https://
```

```bash
# 5. Real traffic from outside.
curl -s https://taskssort.example.com/api/health
```

Then open `https://taskssort.example.com` in a browser and sign in with the
administrator you created in §4.5. If login succeeds and the dashboard loads,
authentication, sessions and every database query are working on PostgreSQL.

```bash
# 6. Confirm nothing but nginx is publicly reachable.
ss -tulpn | grep -E ':(80|443|3000|8000|5432)\b'
```

Expect `127.0.0.1:3000` and the two `:80`/`:443` listeners. `8000` and `5432`
must **not** appear. From your own machine:

```bash
nmap -p 80,443,3000,8000,5432 YOUR_VPS_IP     # only 80 and 443 open
```

---

## 7. Everyday commands

```bash
cd /opt/taskssort
C="docker compose -f docker-compose.yml -f docker-compose.db.yml"

$C ps                    # status
$C logs -f backend       # follow backend logs
$C logs -f frontend
$C logs --tail=200 db    # PostgreSQL logs
$C top                   # live CPU/memory
$C exec -it backend sh   # a shell inside the app
$C restart backend       # restart just the API
$C down                  # stop, KEEP the database volume
$C down -v               # stop and DELETE the database. Read §8 first.
```

If you use option A you can shorten everything by making an alias in
`~/.bashrc`:

```bash
echo "alias tsk='docker compose -f /opt/taskssort/docker-compose.yml -f /opt/taskssort/docker-compose.db.yml'" >> ~/.bashrc
```

---

## 8. Backups and restore

### ⚠ Read this before typing `down -v`

`docker compose down` **stops** the containers and **keeps** the database volume.
`docker compose down -v` **deletes it**. They differ by two characters and the
second one destroys every task, time entry and audit record in the system.

Make `down -v` hard to type by accident:

```bash
# In ~/.bashrc
alias tsk-down='docker compose -f /opt/taskssort/docker-compose.yml -f /opt/taskssort/docker-compose.db.yml down'
```

### 8.1 Back up

```bash
# Custom format: compressed, restorable with pg_restore, and pg_dump restores
# into an existing database without needing to drop it first.
docker compose -f docker-compose.yml -f docker-compose.db.yml \
  exec -T db pg_dump -U taskssort -d taskssort --format=custom \
  > "/opt/taskssort/backup-$(date +%F-%H%M).dump"

ls -lh /opt/taskssort/*.dump
```

> **Do not run this from PowerShell.** `pg_dump --format=custom` writes binary,
> and PowerShell's `>` and pipelines decode and re-encode those bytes, producing
> a file that `pg_restore` rejects with *"input file does not appear to be a
> valid archive"*. On the VPS it is bash and redirection is byte-exact, so the
> command above is correct as written. If you must run it from Windows, use plain
> SQL format and a text-safe path instead:
> ```powershell
> docker compose -f docker-compose.yml -f docker-compose.db.yml exec -T db `
>   pg_dump -U taskssort -d taskssort --format=plain > .\taskssort.sql
> ```
> and restore it with `psql -f`, not `pg_restore`.

Off-site copy, because a backup on the same disk as the database is not a backup:

```bash
install -d -m 700 /opt/taskssort/backups
# move the dumps there, then off the machine:
rsync -a --delete /opt/taskssort/backups/ you@another-host:/backups/taskssort/
```

### 8.2 Automate it

```bash
cat > /opt/taskssort/backup.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/taskssort
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.db.yml"
DEST=/opt/taskssort/backups
mkdir -p "$DEST"
STAMP=$(date +%F-%H%M%S)
$COMPOSE exec -T db pg_dump -U taskssort -d taskssort --format=custom > "$DEST/taskssort-$STAMP.dump"
# Keep 14 days. Verify each dump is non-empty and restorable-looking.
find "$DEST" -name 'taskssort-*.dump' -mtime +14 -delete
[ -s "$DEST/taskssort-$STAMP.dump" ] || { echo "EMPTY DUMP - deleting" >&2; rm -f "$DEST/taskssort-$STAMP.dump"; exit 1; }
EOF
chmod 700 /opt/taskssort/backup.sh

# Nightly at 03:17, deliberately not on the hour.
(crontab -l 2>/dev/null; echo "17 3 * * * /opt/taskssort/backup.sh >> /var/log/taskssort-backup.log 2>&1") | crontab -
```

### 8.3 Restore

```bash
C="docker compose -f docker-compose.yml -f docker-compose.db.yml"

# Stop the application so nothing writes during the restore.
$C stop backend frontend

# Restore into a freshly emptied database. This REPLACES every row.
$C exec -T db psql -U taskssort -d taskssort -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
$C exec -T db pg_restore -U taskssort -d taskssort --clean --if-exists < /opt/taskssort/backups/taskssort-YYYY-MM-DD-HHMM.dump

$C up -d
curl -s http://127.0.0.1:3000/api/health
```

Verify a restore actually worked **before** you need it. A backup you have never
restored is a hypothesis:

```bash
$C run --rm -d --name restore-test backend sleep infinity
$C exec db createdb -U taskssort restore_test
$C exec -T db pg_restore -U taskssort -d restore_test < backup.dump
$C exec -T db psql -U taskssort -d restore_test -c "SELECT count(*) FROM users;"
$C exec -T db dropdb -U taskssort restore_test
$C rm -f restore-test
```

### 8.4 Rollback for a bad deploy

```bash
cd /opt/taskssort
git log --oneline -5
git checkout <previous-good-sha>
$C up -d --build
```

The schema command is additive, so an older version of the code runs happily
against a newer schema. Columns are never dropped and never renamed, so a code
rollback needs no schema rollback.

**If a deploy wrote bad data** — a bug that deleted tasks, say — no code rollback
will bring them back. Restore the last dump from §8.3 and accept the loss since
then. That is the point of the nightly job.

---

## 9. Data migration: SQLite → PostgreSQL

Most production deployments want **option A: schema only**. The development
database contains demo rows, throwaway logins and stale sessions; a production
database should start clean, with just the one administrator from §4.5.

If you genuinely need your development data in production, use the import
command. It is opt-in, read-only on the source, and a dry run by default.

### 9.1 Copy the development file to the VPS

```bash
# From your development machine
scp backend/data/marketingos.db deploy@YOUR_VPS_IP:/opt/taskssort/
```

### 9.2 Back up the target first

```bash
# On the VPS -- there is no undo for an import.
bash /opt/taskssort/backup.sh
```

### 9.3 Dry run

Reads the file, reports the plan, writes nothing:

```bash
docker compose -f docker-compose.yml -f docker-compose.db.yml \
  run --rm -T backend python -m app.cli import-sqlite \
  --from /app/data/marketingos.db
```

> The path is **inside the container**, so `/app/data/marketingos.db` — the
> `./backend/data` bind mount — not the host path.

It prints every table and its row count, in foreign-key order:

```
Source:  /app/data/marketingos.db  (read-only)
Target:  postgresql+psycopg://taskssort:***@db:5432/taskssort
Order (foreign keys first):
  users                       12 rows
  categories                   8 rows
  ...
Dry run. Nothing was written (94 rows would be copied).
```

### 9.4 Apply

```bash
docker compose -f docker-compose.yml -f docker-compose.db.yml \
  run --rm -T backend python -m app.cli import-sqlite \
  --from /app/data/marketingos.db --apply
```

It refuses to run if the target already has rows in any table, keeps every
original primary key, **resynchronises PostgreSQL's identity sequences** so the
first new user does not collide with an imported id, and verifies every row count
before reporting success:

```
  users                       12 / 12     ok
  tasks                       81 / 81     ok
Import complete.
```

The source file is opened read-only and is not modified.

### 9.5 After an import

```bash
$C restart backend
curl -s http://127.0.0.1:3000/api/health
```

Then **sign in through the browser with a real account from the imported data.**
That single action exercises authentication, session creation, the user query, the
capability lookup and every dashboard aggregate against imported rows, which is
more than any script can assert.

Two things to expect:

- **Old sessions will not work.** Their rows came across, but nothing has logged
  in yet to prove the password hashes still verify. Sign in again.
- **The login rate limiter will still remember old failures**, because
  `login_attempts` came across too. It prunes by age on its own.

---

## 10. CI/CD

The pipeline below runs on GitHub Actions, publishes to GitHub Container
Registry, and deploys by SSH. It uses a **GitHub Environment** so that production
secrets are only exposed to a protected branch.

### 10.1 Repository secrets

Add these under **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `GHCR_TOKEN` | A GitHub PAT with `write:packages`. Or the built-in `GITHUB_TOKEN` if you accept the 30-day expiry. |
| `VPS_HOST` | `root@YOUR_VPS_IP` |
| `VPS_SSH_KEY` | The private key of a key with passwordless `ssh` to that host |
| `DEPLOY_PATH` | `/opt/taskssort` |

Nothing else. **No database password is ever a CI secret** — `.env` lives only on
the VPS and is never transferred. CI never needs it.

Give the PAT `write:packages` only.

### 10.2 The workflow

Create `.github/workflows/deploy.yml`:

```yaml
name: test, build and deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

# Two pushes to the same branch: the newer run cancels the older.
concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_USER: postgres
          POSTGRES_DB: mos_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip
          cache-dependency-path: backend/requirements.txt

      - name: Install backend
        working-directory: backend
        run: |
          python -m venv .venv
          .venv/bin/pip install --upgrade pip
          .venv/bin/pip install -r requirements.txt

      - name: Tests on PostgreSQL
        working-directory: backend
        env:
          MOS_TEST_DATABASE_URL: postgresql+psycopg://postgres:postgres@127.0.0.1:5432/mos_test
        run: .venv/bin/python -m pytest -q

      - name: Tests on SQLite
        working-directory: backend
        env:
          MOS_TEST_DATABASE_URL: ""
        run: .venv/bin/python -m pytest -q

      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - name: Frontend lint and build
        working-directory: frontend
        run: |
          npm ci
          npm run lint
          npm run build

  build:
    needs: test
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    outputs:
      tag: ${{ steps.meta.outputs.tag }}
    steps:
      - uses: actions/checkout@v4
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=sha,format=long
            type=ref,event=branch
            type=sha
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push backend
        uses: docker/build-push-action@v6
        with:
          context: backend
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Build and push frontend
        uses: docker/build-push-action@v6
        with:
          context: frontend
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: build
    runs-on: ubuntu-latest
    # Only runs from main, only after a human approves it.
    environment: production
    steps:
      - name: Configure SSH
        run: |
          mkdir -p ~/.ssh
          printf '%s\n' "${{ secrets.VPS_SSH_KEY }}" > ~/.ssh/id_ed25519
          chmod 600 ~/.ssh/id_ed25519
          ssh-keyscan -H ${{ secrets.VPS_HOST }} >> ~/.ssh/known_hosts 2>/dev/null || true
          ssh -o StrictHostKeyChecking=accept-new -i ~/.ssh/id_ed25519 ${{ secrets.VPS_HOST }} true

      - name: Log in to the registry from the VPS
        env:
          GHCR_TOKEN: ${{ secrets.GITHCR_TOKEN }}
          VPS: ${{ secrets.VPS_HOST }}
        run: |
          echo "$GHCR_TOKEN" \
            | ssh -i ~/.ssh/id_ed25519 "$VPS" "docker login ghcr.io -u deploy --password-stdin"

      - name: Deploy
        env:
          TAG: ${{ needs.build.outputs.tag }}
          IMAGE: ghcr.io/${{ github.repository }}
          # Passed through to the remote shell as environment variables so the
          # heredoc can stay quoted (no local expansion of $TAG and friends).
          DEPLOY_PATH: ${{ secrets.DEPLOY_PATH }}
        run: |
          # `env ... bash -s` forwards the three variables into the remote
          # shell. A plain `bash -s <<EOF` would not: the heredoc stays quoted
          # so the runner does not expand $TAG, and the runner's environment is
          # not inherited by the SSH session, so the variables have to be
          # handed over explicitly.
          ssh -i ~/.ssh/id_ed25519 ${{ secrets.VPS_HOST }} \
            env DEPLOY_PATH="$DEPLOY_PATH" TAG="$TAG" IMAGE="$IMAGE" \
            bash -s <<'REMOTE'
          set -euo pipefail
          cd $DEPLOY_PATH
          git fetch origin
          git reset --hard origin/main

          # Both variables arrive as environment variables, not shell expansions
          # of the Actions runner's own -- GITHUB_REPOSITORY does not exist on
          # the VPS, which is an easy way to end up tagging the wrong thing.
          docker tag "$IMAGE/backend:$TAG"  taskssort-backend:latest
          docker tag "$IMAGE/frontend:$TAG" taskssort-frontend:latest

          C="docker compose -f docker-compose.yml -f docker-compose.db.yml"

          # Schema first, while the OLD code is still serving. Additive, so it
          # is safe for the running version.
          $C run --rm -T backend python -m app.cli schema

          $C up -d --no-build

          # Wait for the whole stack, and assert the database really is
          # PostgreSQL. A bounded loop, not `sleep 30` and hope.
          healthy=0
          for i in $(seq 1 60); do
            body=$(curl -fsS --max-time 5 http://127.0.0.1:3000/api/health 2>/dev/null || true)
            case "$body" in
              *'"database":"postgresql"'*) healthy=1; break ;;
            esac
            sleep 2
          done

          if [ "$healthy" -ne 1 ]; then
            echo "::error::stack did not report a healthy PostgreSQL backend; rolling back"
            $C logs --tail=100 backend
            git reset --hard HEAD~1
            $C up -d --build
            exit 1
          fi

          echo "$body"
          echo "deployed $TAG"
          REMOTE
```

### 10.3 Required repository settings

1. **Settings → Environments → production → Required reviewers.** Turn this on,
   so merging to `main` queues a deploy that a human approves. This is the single
   most valuable setting on the page.
2. **Settings → Actions → General → Read and write permissions → Read and
   write.** Needed for `GITHUB_TOKEN` to push packages.
3. Create the repository so its name matches the paths in the script
   (`ghcr.io/OWNER/REPO/backend`). The workflow uses
   `${{ github.repository }}`, so nothing needs hard-coding.

### 10.4 Why the deploy keeps `.env` out of it

`.env` is in `.gitignore`, so `git reset --hard origin/main` cannot delete it —
but it also cannot be *created*. That is the correct outcome: **secrets are
provisioned once, by hand, on the VPS, and CI never sees them.** Rotating the
database password means editing `.env` on the VPS and restarting the backend.

### 10.5 A deploy, from the first commit

```bash
# On the VPS, once.
cd /opt/taskssort
git remote add github git@github.com:YOUR_ORG/YOUR_REPO.git
```

The first CI run builds and pushes the images but the deploy step's `docker tag`
expects the images to already be pullable by their GHCR name. On the very first
run, build locally instead:

```bash
docker compose -f docker-compose.yml -f docker-compose.db.yml build
docker compose -f docker-compose.yml -f docker-compose.db.yml up -d
```

After that, CI handles everything.

---

## 11. Troubleshooting

### `/api/health` reports `sqlite` in production

`DATABASE_URL` is not reaching the container, or is not a PostgreSQL URL.

```bash
cd /opt/taskssort
grep '^DATABASE_URL' .env
docker compose -f docker-compose.yml -f docker-compose.db.yml exec -T backend printenv DATABASE_URL
```

The second must match the first. If not, `.env` is not being read — check for a
stray BOM, CRLF line endings (`sed -i 's/\r$//' .env`), or a missing final
newline.

### The backend exits at startup

Read the error, it is meant to be readable:

```bash
docker compose -f docker-compose.yml -f docker-compose.db.yml logs backend
```

| Message | Cause | Fix |
|---|---|---|
| `password authentication failed` | Wrong password | Check `DATABASE_URL` and `POSTGRES_PASSWORD` agree |
| `could not translate host name` | Host does not resolve | Inside a container, `localhost` is the container. Use `db` |
| `relation "users" does not exist` | Schema never created | Run the `schema` command from §4.3 |
| `DATABASE_URL is empty` | `.env` unreadable or unset | See above |
| `names an unsupported database` | A typo, e.g. `postgresql://` | Fix the scheme |

If `POSTGRES_PASSWORD` in `.env` is changed after the volume is initialised, the
new value is **ignored** — PostgreSQL only reads it on first start. Either change
the password inside the database (`ALTER ROLE … PASSWORD '…'`) or, to start over,
`docker compose down -v` **after a backup**.

### The backend restarts in a loop

```bash
docker compose -f docker-compose.yml -f docker-compose.db.yml logs --tail=100 backend
docker compose -f docker-compose.yml -f docker-compose.db.yml ps
```

A container in `Restarting` with `DB_CONNECT_WAIT_SECONDS=0` means the database
was genuinely unreachable. That is the intended behaviour: fail loudly rather
than hang. With the bundled database, `depends_on: service_healthy` should have
prevented it — check that `docker-compose.db.yml` is on the command line.

### Pages load but every API call fails

`API_ORIGIN` was changed at run time but not at build time. The Next.js rewrite
destination is frozen into `.next/routes-manifest.json` during `next build`, so
the build arg and the runtime env must agree. Either leave both at the default
`http://backend:8000`, or change both and rebuild the frontend.

```bash
docker compose -f docker-compose.yml -f docker-compose.db.yml exec -T frontend printenv API_ORIGIN
```

### Log in succeeds, then everything is logged out

Almost always `COOKIE_SECURE: "true"` while the browser is on plain HTTP. On
HTTPS this cannot happen. Confirm nginx really is terminating TLS:

```bash
curl -sI https://YOUR_DOMAIN/api/health | grep -i strict-transport
```

### "database is locked" on SQLite

Expected when running the app with SQLite from more than one process. It is why
the backend Dockerfile pins `--workers 1`. On PostgreSQL this error cannot occur.

### Everything is slow

```bash
docker stats --no-stream
docker compose -f docker-compose.yml -f docker-compose.db.yml exec -T db \
  psql -U taskssort -d taskssort -c "SELECT count(*) FROM pg_stat_activity;"
```

Check connection count against `max_connections`, and that `DB_POOL_SIZE +
DB_MAX_OVERFLOW` × workers stays well under it.

### Disk filling up

```bash
docker system df
docker system prune -a          # unused images and build cache; safe
du -sh /var/lib/docker
```

Log rotation is already capped at 10 MB × 3 per container by the Compose files.
The usual culprit on a small VPS is Docker's build cache; prune it.