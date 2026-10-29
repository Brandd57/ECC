# Chirp

A small Twitter-style microblog: accounts, 280-character posts, likes,
follows, a home timeline, a global feed, and profile pages.

It has no dependencies beyond Node.js 18+: a plain `http` server, a vanilla
JavaScript front end, and a single JSON file for persistence.

## Run

```bash
node examples/chirp/server.js
# open http://localhost:3000
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | Port to listen on |
| `CHIRP_DATA` | unset | Path of the JSON data file. Unset keeps everything in memory. |

## API

All bodies are JSON. Authenticated routes take `Authorization: Bearer <token>`,
where the token comes from `signup` or `login`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/signup` | no | Create an account, returns a token |
| POST | `/api/login` | no | Returns a token |
| POST | `/api/logout` | yes | Invalidate the token |
| GET | `/api/me` | yes | Current user's profile |
| GET | `/api/feed` | no | Everyone's chirps, newest first |
| GET | `/api/timeline` | yes | Own chirps plus those of followed users |
| POST | `/api/chirps` | yes | Post a chirp (`{ "text": "..." }`) |
| DELETE | `/api/chirps/:id` | yes | Delete your own chirp |
| PUT / DELETE | `/api/chirps/:id/like` | yes | Like / unlike |
| GET | `/api/users/:name` | no | Profile with counts |
| GET | `/api/users/:name/chirps` | no | A user's chirps |
| PUT / DELETE | `/api/users/:name/follow` | yes | Follow / unfollow |

List routes accept `limit` (max 50) and `before` (a chirp id cursor).

## Design notes

- Passwords are hashed with scrypt and a per-user salt; sessions are random
  256-bit tokens held in memory, so a restart logs everyone out.
- The front end builds DOM nodes with `textContent` only, and the server sends
  a `default-src 'self'` Content-Security-Policy.
- Static files are served from a fixed allowlist, never from request paths.

## Not included

Replies, retweets, media, search, notifications, rate limiting, and a real
database. Swap `lib/store.js` for a database-backed implementation with the
same methods to scale past a single process.

## Test

```bash
node tests/examples/chirp.test.js
```
