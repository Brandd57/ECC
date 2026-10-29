/* global document, location, window */
'use strict';

const MAX_LENGTH = 280;
const main = document.getElementById('main');
const nav = document.getElementById('nav');

let token = null;
let me = null;
try { token = localStorage.getItem('chirp-token'); } catch { /* storage blocked */ }

// Elements are built with textContent/append only, so user text is never parsed as HTML.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value);
  }
  el.append(...kids.filter(kid => kid !== null && kid !== false));
  return el;
}

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) setSession(null);
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function setSession(next) {
  token = next;
  try {
    if (next) localStorage.setItem('chirp-token', next);
    else localStorage.removeItem('chirp-token');
  } catch { /* storage blocked */ }
}

function errorBox(error) {
  return h('p', { class: 'error', role: 'alert' }, error.message);
}

function chirpCard(chirp, onChange) {
  const card = h('article', { class: 'chirp' });
  const like = h('button', {
    class: `link${chirp.liked ? ' on' : ''}`,
    onclick: async () => {
      try {
        Object.assign(chirp, await api(chirp.liked ? 'DELETE' : 'PUT', `/chirps/${chirp.id}/like`));        card.replaceWith(chirpCard(chirp, onChange));
      } catch (error) { card.append(errorBox(error)); }
    }
  }, `${chirp.liked ? 'Unlike' : 'Like'} (${chirp.likes})`);
  const remove = me && me.username === chirp.author && h('button', {
    class: 'link danger',
    onclick: async () => {
      try {
        await api('DELETE', `/chirps/${chirp.id}`);
        card.remove();
        if (onChange) onChange();
      } catch (error) { card.append(errorBox(error)); }
    }
  }, 'Delete');
  card.append(
    h('div', { class: 'meta' },
      h('a', { href: `#/u/${encodeURIComponent(chirp.author)}` }, `@${chirp.author}`),
      ` · ${new Date(chirp.createdAt).toLocaleString()}`),
    h('div', { class: 'text' }, chirp.text),
    h('div', { class: 'actions' }, token ? like : h('span', { class: 'muted' }, `${chirp.likes} likes`), remove)
  );
  return card;
}

// Paged list with a "Load more" button driven by the `before` id cursor.
function chirpList(path) {
  const list = h('div');
  const empty = h('p', { class: 'muted' }, 'Nothing here yet.');
  const more = h('button', { class: 'ghost', hidden: '' }, 'Load more');
  let last = null;
  const syncEmpty = () => {
    if (list.querySelector('.chirp')) empty.remove();
    else list.append(empty);
  };
  async function load() {
    try {
      const sep = path.includes('?') ? '&' : '?';
      const items = await api('GET', last ? `${path}${sep}before=${last}` : path);
      for (const chirp of items) list.append(chirpCard(chirp, syncEmpty));
      if (items.length) last = items[items.length - 1].id;
      more.hidden = items.length < 20;
      syncEmpty();
    } catch (error) { list.append(errorBox(error)); }
  }
  more.addEventListener('click', load);
  load();
  return h('div', null, list, more);
}

function composer(onPosted) {
  const text = h('textarea', { placeholder: "What's happening?", maxlength: '1000', 'aria-label': 'New chirp' });
  const counter = h('span', { class: 'counter' }, String(MAX_LENGTH));
  const button = h('button', { type: 'submit', disabled: '' }, 'Chirp');
  const error = h('div');
  text.addEventListener('input', () => {
    const left = MAX_LENGTH - text.value.length;
    counter.textContent = String(left);
    counter.className = `counter${left < 0 ? ' over' : ''}`;
    button.disabled = left < 0 || !text.value.trim();
  });
  return h('form', {
    class: 'stack',
    onsubmit: async event => {
      event.preventDefault();
      try {
        await api('POST', '/chirps', { text: text.value });
        onPosted();
      } catch (e) { error.replaceChildren(errorBox(e)); }
    }
  }, text, h('div', { class: 'row' }, counter, button), error);
}

function authForm() {
  const username = h('input', { placeholder: 'Username', autocomplete: 'username', 'aria-label': 'Username' });
  const password = h('input', { type: 'password', placeholder: 'Password (8+ characters)', autocomplete: 'current-password', 'aria-label': 'Password' });
  const error = h('div');
  const submit = mode => async () => {
    try {
      const session = await api('POST', `/${mode}`, { username: username.value, password: password.value });
      setSession(session.token);
      await start();
    } catch (e) { error.replaceChildren(errorBox(e)); }
  };
  return h('form', { class: 'stack', onsubmit: event => event.preventDefault() },
    h('h2', null, 'Join the conversation'),
    username, password, error,
    h('div', { class: 'row' },
      h('button', { type: 'submit', onclick: submit('login') }, 'Log in'),
      h('button', { type: 'button', class: 'ghost', onclick: submit('signup') }, 'Sign up')));
}

function tabs(active) {
  const tab = (href, label, key) => h('a', { href, class: active === key ? 'active' : '' }, label);
  return h('div', { class: 'tabs' }, tab('#/', 'Home', 'home'), tab('#/explore', 'Everyone', 'explore'));
}

async function profileView(name) {
  try {
    const p = await api('GET', `/users/${encodeURIComponent(name)}`);
    const own = me && me.username === p.username;
    const follow = token && !own && h('button', {
      class: p.followedByViewer ? 'ghost' : '',
      onclick: async () => {
        try { await api(p.followedByViewer ? 'DELETE' : 'PUT', `/users/${encodeURIComponent(name)}/follow`); render(); }
        catch (error) { main.append(errorBox(error)); }
      }
    }, p.followedByViewer ? 'Unfollow' : 'Follow');
    return h('div', null,
      h('div', { class: 'row' }, h('h2', null, `@${p.username}`), follow),
      h('p', { class: 'muted' }, `${p.chirps} chirps · ${p.following} following · ${p.followers} followers`),
      chirpList(`/users/${encodeURIComponent(name)}/chirps`));
  } catch (error) {
    return errorBox(error);
  }
}

async function render() {
  const [, view, arg] = (location.hash || '#/').slice(1).split('/');
  nav.replaceChildren(...(me
    ? [h('a', { href: `#/u/${encodeURIComponent(me.username)}` }, `@${me.username}`),
      h('button', { class: 'ghost', onclick: logout }, 'Log out')]
    : []));
  main.replaceChildren();
  if (view === 'u' && arg) return main.append(await profileView(decodeURIComponent(arg)));
  if (view === 'explore') return main.append(tabs('explore'), chirpList('/feed'));
  if (!me) return main.append(authForm(), h('h2', null, 'Latest chirps'), chirpList('/feed'));
  main.append(composer(render), tabs('home'), chirpList('/timeline'));
}

async function logout() {
  try { await api('POST', '/logout'); } catch { /* session already gone */ }
  setSession(null);
  await start();
}

async function start() {
  me = null;
  if (token) {
    try { me = await api('GET', '/me'); } catch { me = null; }
  }
  await render();
}

window.addEventListener('hashchange', render);
start();
