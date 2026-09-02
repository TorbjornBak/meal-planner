# Deploying a public instance (Hetzner + Cloudflare)

The [README](./README.md) gives the short version of the production deployment.
This file is the full runbook: a Hetzner Debian server, a domain whose DNS lives
at Cloudflare, and the app reachable by anyone who has the address.

**No application code changes are needed.** The app already expects to sit
behind exactly one HTTPS terminator on loopback — `docker-compose.yml` publishes
`127.0.0.1:3000`, `src/lib/csrf.ts` takes the expected origin from `APP_URL`
rather than the request's `Host`, and `src/lib/securityHeaders.ts` sends HSTS as
soon as `APP_URL` is `https`. Everything below is host setup and configuration.

```
browser ──► Cloudflare edge ──► Caddy (host, :443) ──► app container (127.0.0.1:3000) ──► db container
             proxied, WAF,        Cloudflare Origin      next start                        postgres:17
             Always Use HTTPS     CA certificate
```

## Contents

1. [Before you start](#1-before-you-start)
2. [The server](#2-the-server)
3. [Docker](#3-docker)
4. [Checkout and `.env`](#4-checkout-and-env)
5. [Bring the stack up](#5-bring-the-stack-up)
6. [DNS and the origin certificate](#6-dns-and-the-origin-certificate)
7. [Caddy](#7-caddy)
8. [Firewall](#8-firewall)
9. [Cloudflare settings that matter](#9-cloudflare-settings-that-matter)
10. [First run](#10-first-run)
11. [Email](#11-email)
12. [Backups](#12-backups)
13. [Verify](#13-verify)
14. [Updating](#14-updating)

---

## 1. Before you start

- **Server size.** `next build` runs inside the Docker build. A **CX22**
  (2 vCPU / 4 GB) builds comfortably; on a 2 GB box the build OOMs — either add
  swap or build the image elsewhere and pull it. Anything from CX22 up is fine
  to *run*: the steady state is Node plus Postgres, well under 1 GB.
- **Debian 12 or 13**, the plain Hetzner image. No Docker pre-installed.
- **The server needs a public IPv4.** Hetzner now bills IPv4 separately and will
  happily give you an IPv6-only box, which cannot reach GitHub at all —
  `github.com` and `codeload.github.com` publish **no AAAA records**. Docker Hub,
  Debian and Cloudflare are all dual-stack, so an IPv6-only box gets through
  every other step and then fails only at [§4](#4-checkout-and-env)'s clone,
  with `Failed to connect … after 1 ms` and `ping: connect: Network is
  unreachable`. Attach an IPv4 Primary IP (Console → Server → Networking; ~€0.50
  a month, and the server usually has to be powered off to attach one). To stay
  IPv6-only you must get the source across some other way — clone from a mirror
  reachable over IPv6, or `rsync` the tree up from your workstation and accept
  manual updates.
- **Your domain's nameservers already point at Cloudflare.**
- **A relay for outgoing mail** (see [§11](#11-email)) — Hetzner blocks outbound
  SMTP by default, which is the single most likely thing to cost you an
  afternoon. Read that section before you get to it.

Throughout, replace `meals.example.com` with your hostname.

---

## 2. The server

Create the server, then get a **login root shell** — note the `-`:

```sh
sudo -i          # or `su -` if you logged in as a non-root user
```

The dash matters. `adduser`, `usermod` and `ufw` all live in `/usr/sbin`, which
on Debian 12 is only on the `PATH` of a login root shell. Without it the very
first command fails with `adduser: command not found`, which reads like a
missing package and isn't one. (Debian 13 merged `/usr/sbin` into `/usr/bin`,
so this only bites on 12 — but `sudo -i` is right on both.) If you'd rather not
hold a root shell, prefix each of those three with `sudo` instead; `sudo` resets
the `PATH` for you.

```sh
apt-get update && apt-get -y upgrade
apt-get install -y ca-certificates curl gnupg ufw

# A non-root user to run the stack.
adduser --disabled-password --gecos "" deploy

# Give it the same key you just logged in with. Do NOT assume that is root's:
# Hetzner installs your key for whichever account the image defines, which on
# many images is a named sudo user, leaving /root/.ssh empty. $SUDO_USER is
# whoever ran `sudo -i`; fall back to root only if there isn't one.
ADMIN_HOME=$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
cp "$ADMIN_HOME/.ssh/authorized_keys" /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

# Verify it landed — this must print the fingerprint of the key you use.
ssh-keygen -lf /home/deploy/.ssh/authorized_keys
```

An empty or missing `authorized_keys` here is the cause of the
`Too many authentication failures` in [§3](#3-docker): with no key to match,
every identity your client offers is rejected in turn until `MaxAuthTries`
runs out. The `-m 700` is not decoration either — sshd's `StrictModes` ignores
the file outright if `/home/deploy` or `.ssh` is group-writable, which fails
identically.

### You may not want a separate account at all

**Membership in the `docker` group is root-equivalent** — anyone in it can
`docker run -v /:/host` and take the box. So a separate unprivileged `deploy`
user in that group buys no isolation; on a public server it mostly adds a
second SSH-reachable account. Unless you have a reason to want one, skip
`adduser` entirely, add your existing sudo user to the `docker` group in
[§3](#3-docker), and read `deploy` as that username throughout (including
§4's `install -d -o deploy -g deploy /srv/mealplanner`).

### If you have hardened sshd with `AllowUsers`

A new account is not covered by an existing `AllowUsers`/`AllowGroups` list,
and sshd rejects it *before* looking at any key — so the client exhausts every
identity and reports `Too many authentication failures`, which looks like a key
problem and is not. The server's `/var/log/auth.log` names it plainly:
`User deploy … not allowed because not listed in AllowUsers`.

```sh
sudo grep -rniE '^\s*(AllowUsers|AllowGroups|DenyUsers)' \
  /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null
```

Append the new user to the line that finds — **edit it in place**, because sshd
honours the *first* occurrence of a keyword and silently ignores any later one,
so a second `AllowUsers` line does nothing. If the match was `AllowGroups`,
add the user to that group instead and skip the restart entirely; that is the
safer route where it is available.

Then, with your working session still open:

```sh
sudo sshd -t                  # silence means the config parses
sudo systemctl reload ssh     # reload, not restart — live sessions survive
```

Test from a *second* terminal before closing the first.

Lock SSH down to keys (Hetzner's image already does this if you supplied a key
at creation — confirm `PasswordAuthentication no` in `/etc/ssh/sshd_config`).

> **Never restart `sshd` on an unverified config.** Run `sshd -t` first — silence
> means valid — and keep your current session open while you test a new one from
> a second terminal. A syntax error makes the service exit on restart, and the
> symptom is `connection refused` on *every* account including root, with no way
> back in over the network.

Then set the baseline firewall. Ports 80 and 443 are opened narrowly in
[§8](#8-firewall), *after* Caddy exists.

```sh
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable
```

`ufw allow OpenSSH` is the port-22 profile. If you moved SSH to another port,
allow that one *before* `ufw enable` or you lock yourself out on the spot.

**If you ever can't get back in**, Hetzner's Cloud Console → your server → the
`>_` **Console** button is out-of-band VNC and works regardless of `sshd` or
`ufw`; Server → **Rescue** → *Reset root password* gives you credentials for it
if you only ever used keys. Two symptoms worth telling apart before you reach
for it:

| Symptom | Cause |
| --- | --- |
| **Timeout** / hang | Packets dropped — `ufw`, or a Hetzner Cloud Firewall. |
| **Connection refused** | Packets arrived, nothing listening — `sshd` is down, or you're connecting to the wrong host (see [§6](#6-dns-and-the-origin-certificate)). |

---

## 3. Docker

Docker's own Debian repository — the distro package is too old for the compose
plugin:

```sh
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

usermod -aG docker deploy
```

Group membership is read once, at login, so the running shell won't see
`docker` no matter what you do to it — you need a **new session**.

**Keep your current root session open** and start a second terminal on your own
machine:

```sh
ssh deploy@<server-ip>
```

That doubles as the first real test of the key you copied in
[§2](#2-the-server). `deploy` was created with `--disabled-password`, so if the
key didn't land there is no password to fall back on — finding that out while a
working root session is still open is the difference between a one-line fix and
a trip through Hetzner's rescue console.

If the login fails, in the *root* session:

```sh
ls -l /home/deploy/.ssh/authorized_keys      # 600, owned by deploy:deploy
chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

If instead you get **`Too many authentication failures`**, the server is fine —
your client is offering the wrong keys until `MaxAuthTries` (6) runs out. This
bites whenever the key Hetzner installed has a non-default filename: SSH only
auto-offers `id_rsa`, `id_ecdsa`, `id_ed25519` and friends, so an
`~/.ssh/id_hetzner` is never tried unless you name it. Check which key the
server actually wants, then offer only that one:

```sh
# on the server
ssh-keygen -lf /home/deploy/.ssh/authorized_keys

# from your machine
ssh -o IdentitiesOnly=yes -i ~/.ssh/<the-matching-key> deploy@<server-ip>
```

`IdentitiesOnly=yes` matters as much as `-i`: without it SSH still offers every
other identity first and can exhaust the limit before reaching yours. Make it
permanent in `~/.ssh/config`:

```
Host mealplanner
    HostName <server-ip>
    User deploy
    IdentityFile ~/.ssh/<the-matching-key>
    IdentitiesOnly yes
```

To become `deploy` without a second terminal, `su - deploy` from root also
starts a fresh login and picks up the new group — again, note the dash. It
proves the group works but tells you nothing about whether SSH does.

Either way, confirm before moving on:

```sh
id -nG          # must list: deploy ... docker
docker ps       # must succeed with no sudo
```

If `docker ps` still says *permission denied* on the socket, the session
predates the `usermod` — log out once more.

---

## 4. Checkout and `.env`

The README's CI/CD flow syncs only `docker-compose.yml` into `/srv/mealplanner`
and pulls a pre-built image from the Forgejo registry. For a standalone
instance that builds on the box, clone the repository there instead:

```sh
sudo install -d -o deploy -g deploy /srv/mealplanner
git clone <your-remote>/meal-planner.git /srv/mealplanner
cd /srv/mealplanner
```

**If the clone fails instantly** — `Failed to connect to github.com port 443
after 1 ms` — that is not a timeout but an immediate `ENETUNREACH`. Establish
*which* family is missing before doing anything, because the two cases have
opposite fixes:

```sh
ping -4 -c1 github.com
ping -6 -c1 github.com
ip -4 route show default
ip -6 route show default
```

`ping -4: Network is unreachable` with a populated `ip -6 route` means you are on
an **IPv6-only server**, and GitHub is simply unreachable — see
[§1](#1-before-you-start). Do *not* reach for `gai.conf` here: preferring IPv4 on
a box with no IPv4 makes every dual-stack connection try a dead address first.

The opposite case — v4 works, v6 has no default route — is the one `gai.conf`
fixes. Confirm which family works, then prefer IPv4:

```sh
curl -4 -sS -o /dev/null -w 'ipv4: %{http_code}\n' https://github.com
curl -6 -sS -o /dev/null -w 'ipv6: %{http_code}\n' https://github.com

# If only v4 answers — takes effect immediately, and does not disable IPv6:
echo 'precedence ::ffff:0:0/96  100' | sudo tee -a /etc/gai.conf
```

`ping github.com` reporting `connect: Network is unreachable` is the same
finding stated more plainly: the name resolved, but there is no route for the
family glibc chose. `ip -6 route show default` coming back empty confirms it.

If *both* fail it is egress filtering instead: check `ufw status verbose` says
`allow (outgoing)`, and look for a **Hetzner Cloud Firewall** attached to the
server — those are separate from `ufw`, and adding any outbound rule denies
everything else.

Fixing this before [§5](#5-bring-the-stack-up) matters for more than git:
`docker compose up --build` pulls `node:22-alpine` and `postgres:17-alpine` over
the same stack and fails the same way. And leave the optional `AAAA` record out
of [§6](#6-dns-and-the-origin-certificate) unless you actually repair IPv6
routing — Cloudflare will otherwise advertise an address your origin cannot
answer on.

**If you cloned as root**, hand the tree to whichever account runs the stack:

```sh
chown -R deploy:deploy /srv/mealplanner
```

This bites specifically on `.env`, which is `chmod 600` — left root-owned, a
`docker compose` run as `deploy` cannot read it, and the app starts with none of
its secrets and fails the startup checks.

**For a private repository**, authenticate with a read-only **deploy key**
rather than a personal access token: a token on a public-facing box carries your
whole account, a deploy key carries one repo and can be revoked alone.

```sh
ssh-keygen -t ed25519 -f ~/.ssh/id_github_deploy -N "" -C "mealplanner-hetzner"
cat ~/.ssh/id_github_deploy.pub    # add to repo → Settings → Deploy keys,
                                   # leaving "Allow write access" unchecked

cat >> ~/.ssh/config <<'SSHEOF'
Host github.com
    IdentityFile ~/.ssh/id_github_deploy
    IdentitiesOnly yes
SSHEOF
chmod 600 ~/.ssh/config

git clone git@github.com:<owner>/meal-planner.git /srv/mealplanner
```

A read-only key is also the right call because nothing on this box should ever
push; [§14](#14-updating) only ever pulls.

Now the `.env`. Four values are load-bearing, and production **refuses to
start** if any of them is missing, weak, or left at the example value — see
[Startup checks](./README.md#startup-checks-phase-6). Two things about it are
easy to get wrong:

- **`POSTGRES_USER` must change too, not just the password.** The check rejects
  `DATABASE_URL` if *either* credential is still `mealplanner`
  (`src/lib/startupConfig.ts`), so a strong password under the default username
  still won't boot.
- **Keep the Postgres password alphanumeric.** `docker-compose.yml` interpolates
  it straight into a `postgresql://` URL, so a `/`, `+`, `@` or `=` from
  `openssl rand -base64` silently produces a malformed connection string. Use
  `openssl rand -hex`.

```sh
cd /srv/mealplanner
cat > .env <<EOF
# --- Postgres (compose assembles the app's DATABASE_URL from these) ---
POSTGRES_USER=mp_app
POSTGRES_PASSWORD=$(openssl rand -hex 24)
POSTGRES_DB=mealplanner

# --- Required in production ---
AUTH_SECRET=$(openssl rand -base64 32)
CRON_SECRET=$(openssl rand -base64 32)
APP_URL=https://meals.example.com

# --- Email (see §11) ---
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
MAIL_FROM=MealPlanner <mealplanner@example.com>

# --- Schedules ---
TZ=Europe/Copenhagen
DIGEST_SCHEDULER=on
BACKUP_SCHEDULER=on
EOF
chmod 600 .env
```

Set `APP_URL` to the real hostname before the first boot — it is both the base
for every emailed token link *and* the origin the CSRF check compares against
(`src/lib/csrf.ts`). Getting it wrong doesn't degrade gracefully; every mutating
request is refused.

Backups are deliberately left out here and configured in [§12](#12-backups):
naming `BORG_REPO` makes `BORG_PASSPHRASE` mandatory, and an unset `BORG_REPO`
boots fine with backups simply off.

---

## 5. Bring the stack up

```sh
cd /srv/mealplanner
docker compose up -d --build
docker compose logs -f app
```

The first build takes a few minutes. What you want in the log:

```
[digest] weekly digest scheduled for Friday 17:00 Europe/Copenhagen
[backup] backups are not configured (BORG_REPO unset)
   ▲ Next.js 15.x  - Local: http://localhost:3000
```

If instead you get `[startup] refusing to start: N problem(s) above`, it names
every variable at fault in one pass — fix them all in `.env` and
`docker compose up -d` again. Migrations run automatically on container start.

The app is now on `127.0.0.1:3000` and reachable from nowhere else. Check:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login   # 200
```

---

## 6. DNS and the origin certificate

In the Cloudflare dashboard for your zone:

1. **DNS → Add record.** `A`, name `meals` (or `@`), content = the server's IPv4,
   **Proxy status: Proxied** (orange cloud). Add the `AAAA` too if you're using
   the server's IPv6.
2. **SSL/TLS → Overview → Full (strict).** Not Flexible: Flexible would make
   Cloudflare talk plain HTTP to your origin, and this app sends HSTS and
   `Secure` session cookies on the assumption the whole path is encrypted.
3. **SSL/TLS → Origin Server → Create Certificate.** Accept the defaults
   (RSA, 15 years, covering `meals.example.com`). Cloudflare shows the
   certificate and the private key **once** — copy both.

> **From here on, SSH to the raw server IP, never to `meals.example.com`.**
> A proxied record resolves to Cloudflare's edge, which serves HTTP/HTTPS and
> nothing else — port 22 there is answered with an immediate `connection
> refused` that looks exactly like a dead `sshd` on your own box. Cloudflare's
> IP is the only thing DNS will hand you now, so keep the real address noted
> somewhere.

An Origin CA certificate is only trusted by Cloudflare, which is exactly what
you want here: it can't be used to serve the site if someone finds the origin
IP, and it needs no ACME challenge, so the firewall in [§8](#8-firewall) can
stay shut to everyone but Cloudflare.

On the server:

```sh
sudo install -d -m 700 -o caddy -g caddy /etc/caddy/tls   # after installing Caddy in §7
sudo tee /etc/caddy/tls/origin.pem >/dev/null   # paste the certificate, then Ctrl-D
sudo tee /etc/caddy/tls/origin.key >/dev/null   # paste the private key, then Ctrl-D
sudo chown caddy:caddy /etc/caddy/tls/origin.*
sudo chmod 600 /etc/caddy/tls/origin.*
```

---

## 7. Caddy

```sh
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

### The Caddyfile, and the one line that matters

`/etc/caddy/Caddyfile`:

```caddyfile
mealplanner.torbjornregueira.com {
	tls /etc/caddy/tls/origin.pem /etc/caddy/tls/origin.key

	encode zstd gzip

	reverse_proxy 127.0.0.1:3000 {
		# Collapse the proxy chain to a single entry holding the real client.
		# See below — this is not cosmetic.
		header_up X-Forwarded-For {http.request.header.Cf-Connecting-Ip}
		header_up X-Real-IP {http.request.header.Cf-Connecting-Ip}
	}
}
```

**Why the `header_up X-Forwarded-For` line is required.**
`src/lib/rateLimitPolicy.ts` reads the **rightmost** `X-Forwarded-For` entry —
the one appended by the hop nearest the app — because that is the last value an
outsider cannot forge. That reasoning holds for exactly one trusted hop, and
its comment says so. Cloudflare in front of Caddy makes two: Cloudflare sets
`X-Forwarded-For: <client>`, Caddy appends its peer, and the app would read the
*Cloudflare edge IP* as the client. Every visitor in the world would then share
one rate-limit bucket, and `login:ip` (10 attempts per 15 minutes) would lock
the whole instance out on the eleventh failed login by anybody.

Overwriting the header with `CF-Connecting-IP` restores the invariant the code
documents: one entry, holding the real client. Cloudflare sets that header on
every proxied request and overwrites anything the client tried to put there, so
it cannot be spoofed from outside — and [§8](#8-firewall) closes the remaining
gap by making Cloudflare the only thing that can reach port 443 at all.

Header case does not matter; Caddy canonicalises it.

> Caddy's `{client_ip}` with a global `trusted_proxies static <cloudflare
> ranges>` block is the other way to do this, and is what you want if you
> deliberately leave the origin open to traffic other than Cloudflare's. It is
> not used here because the list needs backslash line-continuations that break
> on paste — a mangled one fails with `invalid IP address: '}'` — and because
> §8 already makes it redundant.

Then:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy
```

---

## 8. Firewall

Only Cloudflare should be able to reach 443, so nobody can find the origin IP
and bypass the edge entirely:

```sh
for ip in $(curl -s https://www.cloudflare.com/ips-v4); do
  sudo ufw allow proto tcp from "$ip" to any port 443 comment 'cloudflare'
done
for ip in $(curl -s https://www.cloudflare.com/ips-v6); do
  sudo ufw allow proto tcp from "$ip" to any port 443 comment 'cloudflare'
done
sudo ufw reload && sudo ufw status numbered
```

Port 80 stays closed: "Always Use HTTPS" ([§9](#9-cloudflare-settings-that-matter))
redirects at the edge, and the Origin CA certificate needs no ACME challenge.

Cloudflare's ranges change rarely but they do change — re-run the loop after a
`ufw --force reset`-style rebuild, or when traffic mysteriously stops.

Postgres is never exposed: compose binds it to `127.0.0.1:5432` for host-side
`psql` only, and the app container reaches it over the compose network.

---

## 9. Cloudflare settings that matter

The app sends a strict, **nonce-based** Content-Security-Policy
(`src/lib/securityHeaders.ts`): `script-src 'self' 'nonce-…' 'strict-dynamic'`.
Any Cloudflare feature that rewrites your HTML injects a script without that
nonce, and the browser blocks it — usually presenting as a page that renders but
does nothing.

Turn **off**, under Speed / Scrape Shield:

| Setting | Why |
| --- | --- |
| **Rocket Loader** | Rewrites every `<script>`; blocked by the CSP nonce. |
| **Email Obfuscation** | Injects an inline script into pages containing addresses. |
| **Mirage / Polish** | Rewrites `<img>`; `img-src 'self'` refuses the rewritten source. |

Turn **on**:

| Setting | Why |
| --- | --- |
| **SSL/TLS → Edge Certificates → Always Use HTTPS** | Edge-side redirect, so port 80 can stay shut. |
| **Minimum TLS Version 1.2** | Matches the posture the HSTS header asserts. |

Leave alone: don't add a "Cache Everything" page rule. Every route here is
authenticated and dynamic; caching HTML at the edge would serve one household's
plan to another. Cloudflare's default (static assets only) is correct — Next.js
already fingerprints everything under `/_next/static`.

Two limits worth knowing: a proxied request must produce headers within **100
seconds** (otherwise a 524), and free-plan uploads cap at **100 MB**. Receipt
photos are capped at 10 MB by the app (`src/lib/receiptPhoto.ts`), and OCR runs
well inside 100 s, so neither should bite — but a 524 on `/api/trips` means the
OCR did, and the answer is a larger server, not a Cloudflare setting.

---

## 10. First run

Visit `https://meals.example.com`. With no accounts yet, the app sends you to
`/setup` to create the first one, then closes that route permanently. Invite the
rest of the household from **Settings**.

If `/setup` refuses with a throttle message, that's `setup:ip` (5 per hour) —
and if it fires on your *first* attempt, the `X-Forwarded-For` override in
[§7](#7-caddy) isn't in place, so you're sharing a bucket with the whole
internet. Fix that first.

---

## 11. Email

Password resets, invitations and the weekly digest all need SMTP, and there's a
Hetzner-specific trap:

> **Hetzner Cloud blocks outbound ports 25, 465 and 587 by default** on new
> accounts. Connections don't fail fast — they hang and time out, which reads
> like a wrong hostname.

Two ways through:

1. **Ask Hetzner to unblock it.** A support request from the Cloud Console,
   explaining what the server does. Usually granted for an established account.
2. **Use a relay on port 2525**, which isn't blocked. Most transactional
   providers (Brevo, Mailgun, Postmark…) listen there as well as on 587. Set
   `SMTP_PORT=2525`, `SMTP_SECURE=false`.

Either way, `MAIL_FROM` must be an address the relay will actually send as, and
the domain wants SPF and DKIM records in Cloudflare DNS or the mail lands in
spam. Then:

```sh
cd /srv/mealplanner && docker compose up -d
```

and check it from **Settings → Weekly email**: *Test connection* authenticates
without sending (so a failure there is "can't reach the server", not "message
refused"), *Send me one now* does the full round trip. The README's
[When email won't send](./README.md#when-email-wont-send) table decodes the
usual errors.

---

## 12. Backups

Nothing about backups changes when the box is public — follow
[Backups](./README.md#backups-11) in the README. The short version, on a
Hetzner Storage Box:

1. Add to `/srv/mealplanner/.env` (note the port `23`, and the `/./`):

   ```sh
   BORG_REPO="ssh://u123456@u123456.your-storagebox.de:23/./mealplanner"
   BORG_PASSPHRASE="<generate one; 20+ chars>"
   ```

   Setting `BORG_REPO` makes `BORG_PASSPHRASE` mandatory at startup. Write the
   passphrase down **somewhere that is not this server** — it is the only thing
   that can decrypt the archives, and it is deliberately never stored in the
   database, that being what you'd need it to restore.

2. `docker compose up -d`, then **Settings → Backups**: generate a key, add the
   public half to the Storage Box, create the repository, and *Back up now*.

Nightly runs at 03:00 in `BACKUP_TIMEZONE` from then on, with no crontab.

---

## 13. Verify

```sh
# HTTPS end to end, and the app is asserting HSTS (i.e. APP_URL is https).
curl -sSI https://meals.example.com/login | grep -Ei 'HTTP/|strict-transport|content-security'

# The origin is not reachable except through Cloudflare.
curl -sS --max-time 5 https://<server-ip>/login ; echo "exit=$?"   # expect a timeout

# Schedulers started.
cd /srv/mealplanner && docker compose logs app | grep -E '\[digest\]|\[backup\]'

# Postgres is loopback-only.
sudo ss -lntp | grep -E '3000|5432'    # both bound to 127.0.0.1
```

The one check worth doing by hand: **client IP attribution.** From a phone on
mobile data, fail a login a dozen times until you're throttled — then confirm
you can still reach `/login` normally from your desktop. If the desktop is
throttled too, the buckets are collapsed and [§7](#7-caddy) needs revisiting.

---

## 14. Updating

```sh
cd /srv/mealplanner
git pull
docker compose up -d --build
```

Migrations apply on container start. To wire up push-to-deploy instead, the
README's [CI/CD](./README.md#cicd-forgejo-actions) section describes the Forgejo
Actions workflow — the only difference for this instance is that
`/srv/mealplanner/.env` carries the public `APP_URL` rather than a MagicDNS one.
