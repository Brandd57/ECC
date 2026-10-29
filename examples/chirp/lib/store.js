'use strict';

const crypto = require('crypto');
const fs = require('fs');

const MAX_CHIRP_LENGTH = 280;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const MAX_PAGE = 50;
const USERNAME_RE = /^[a-z0-9_]{3,15}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64);
}

function load(file) {
  const empty = { users: {}, chirps: [], nextId: 1 };
  if (!file || !fs.existsSync(file)) return empty;
  return { ...empty, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}

// All state lives in one object persisted to `file` (in-memory when omitted).
// Sessions are deliberately not persisted: a restart logs everyone out.
function createStore(file) {
  const state = load(file);
  const sessions = new Map();

  function save() {
    if (!file) return;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  }

  function getUser(name) {
    const user = state.users[name];
    if (!user) throw new HttpError(404, 'User not found');
    return user;
  }

  function getChirp(id) {
    const chirp = state.chirps.find(c => c.id === Number(id));
    if (!chirp) throw new HttpError(404, 'Chirp not found');
    return chirp;
  }

  function view(chirp, viewer) {
    return {
      id: chirp.id,
      author: chirp.author,
      text: chirp.text,
      createdAt: chirp.createdAt,
      likes: chirp.likes.length,
      liked: Boolean(viewer) && chirp.likes.includes(viewer)
    };
  }

  // Newest first; `before` is an exclusive id cursor for "load more".
  function page(filter, viewer, { before, limit } = {}) {
    const max = Math.min(Math.max(Number(limit) || 20, 1), MAX_PAGE);
    const cursor = Number(before) || Infinity;
    const out = [];
    for (let i = state.chirps.length - 1; i >= 0 && out.length < max; i--) {
      const chirp = state.chirps[i];
      if (chirp.id < cursor && filter(chirp)) out.push(view(chirp, viewer));
    }
    return out;
  }

  function startSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, username);
    return { token, username };
  }

  return {
    signup(rawUsername, password) {
      const username = String(rawUsername || '').trim().toLowerCase();
      if (!USERNAME_RE.test(username)) {
        throw new HttpError(400, 'Username must be 3-15 characters: letters, numbers, underscore');
      }
      if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        throw new HttpError(400, `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`);
      }
      if (state.users[username]) throw new HttpError(409, 'Username is taken');
      const salt = crypto.randomBytes(16);
      state.users[username] = {
        username,
        salt: salt.toString('hex'),
        hash: hashPassword(password, salt).toString('hex'),
        createdAt: Date.now(),
        following: []
      };
      save();
      return startSession(username);
    },

    login(rawUsername, password) {
      const user = state.users[String(rawUsername || '').trim().toLowerCase()];
      const salt = Buffer.from(user ? user.salt : '00', 'hex');
      const candidate = hashPassword(String(password || ''), salt);
      const expected = Buffer.from(user ? user.hash : '00'.repeat(64), 'hex');
      if (!user || !crypto.timingSafeEqual(candidate, expected)) {
        throw new HttpError(401, 'Invalid username or password');
      }
      return startSession(user.username);
    },

    logout(token) {
      sessions.delete(token);
    },

    userForToken(token) {
      return sessions.get(token) || null;
    },

    post(username, text) {
      const body = typeof text === 'string' ? text.trim() : '';
      if (!body) throw new HttpError(400, 'Chirp cannot be empty');
      if (body.length > MAX_CHIRP_LENGTH) {
        throw new HttpError(400, `Chirp is limited to ${MAX_CHIRP_LENGTH} characters`);
      }
      const chirp = { id: state.nextId++, author: username, text: body, createdAt: Date.now(), likes: [] };
      state.chirps.push(chirp);
      save();
      return view(chirp, username);
    },

    remove(username, id) {
      const chirp = getChirp(id);
      if (chirp.author !== username) throw new HttpError(403, 'You can only delete your own chirps');
      state.chirps.splice(state.chirps.indexOf(chirp), 1);
      save();
      return { deleted: chirp.id };
    },

    like(username, id, on) {
      const chirp = getChirp(id);
      const has = chirp.likes.includes(username);
      if (on && !has) chirp.likes.push(username);
      if (!on && has) chirp.likes = chirp.likes.filter(u => u !== username);
      save();
      return view(chirp, username);
    },

    follow(username, target, on) {
      const user = getUser(username);
      getUser(target);
      if (target === username) throw new HttpError(400, 'You cannot follow yourself');
      const has = user.following.includes(target);
      if (on && !has) user.following.push(target);
      if (!on && has) user.following = user.following.filter(u => u !== target);
      save();
      return this.profile(target, username);
    },

    profile(name, viewer) {
      const user = getUser(name);
      const viewerUser = viewer ? state.users[viewer] : null;
      return {
        username: user.username,
        createdAt: user.createdAt,
        chirps: state.chirps.filter(c => c.author === name).length,
        following: user.following.length,
        followers: Object.values(state.users).filter(u => u.following.includes(name)).length,
        followedByViewer: Boolean(viewerUser) && viewerUser.following.includes(name)
      };
    },

    feed(viewer, opts) {
      return page(() => true, viewer, opts);
    },

    timeline(username, opts) {
      const { following } = getUser(username);
      return page(c => c.author === username || following.includes(c.author), username, opts);
    },

    userChirps(name, viewer, opts) {
      getUser(name);
      return page(c => c.author === name, viewer, opts);
    }
  };
}

module.exports = { createStore, HttpError, MAX_CHIRP_LENGTH };
