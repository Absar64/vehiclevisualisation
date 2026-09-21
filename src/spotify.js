/**
 * spotify.js — now-playing telemetry.
 *
 * Authorisation is **Authorization Code with PKCE**, not the client-credentials
 * flow. Two reasons, and both are load-bearing:
 *
 *  - Client credentials can only reach public catalogue data. "What is *this
 *    user* playing right now" is user-scoped, so it needs a user token.
 *  - PKCE needs no client secret. A secret placed in front-end JavaScript is
 *    readable by anyone who opens the page, which makes it not a secret — so
 *    this file deliberately holds only the client ID.
 *
 * The flow: a random verifier is stored locally, its SHA-256 challenge goes to
 * Spotify, the returned code is exchanged for tokens, and the refresh token
 * keeps the session alive afterwards. Polling is a self-scheduling timeout
 * rather than an interval, so a slow response or a rate-limit back-off can
 * never stack requests on top of each other.
 */

import { SPOTIFY } from './config.js';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const NOW_PLAYING_URL = 'https://api.spotify.com/v1/me/player/currently-playing';

const TOKEN_STORE = 'bmw.spotify.tokens';
const VERIFIER_STORE = 'bmw.spotify.verifier';

/** URL-safe base64 of an ArrayBuffer, as PKCE requires. */
function base64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomVerifier(length = 64) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(digest);
}

/** localStorage can throw in private windows; never let that break the page. */
function readStore(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStore(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — the session simply won't survive a reload */
  }
}

export class SpotifyNowPlaying {
  /**
   * @param {{onChange:(state:object)=>void}} handlers
   */
  constructor({ onChange }) {
    this.onChange = onChange;
    this.tokens = readStore(TOKEN_STORE);
    this.timer = 0;
    this.disposed = false;

    /** Last state pushed to the UI, so unchanged frames don't touch the DOM. */
    this.state = { connected: false, playing: false };
  }

  /**
   * Spotify matches this exactly against the dashboard entry, so it must be
   * the page's own origin and path with nothing appended.
   */
  get redirectUri() {
    return `${window.location.origin}${window.location.pathname}`;
  }

  _emit(next) {
    const merged = { ...this.state, ...next };
    const changed = Object.keys(merged).some((key) => merged[key] !== this.state[key]);
    this.state = merged;
    if (changed) this.onChange(merged);
  }

  /** Completes a redirect if we are returning from one, then starts polling. */
  async start() {
    const params = new URLSearchParams(window.location.search);

    if (params.has('code')) {
      const code = params.get('code');
      // Strip the code from the address bar before doing anything else: it is
      // single-use, and leaving it there means a reload tries to spend it twice.
      window.history.replaceState({}, document.title, this.redirectUri);
      await this._exchangeCode(code);
    } else if (params.has('error')) {
      window.history.replaceState({}, document.title, this.redirectUri);
    }

    this._emit({ connected: Boolean(this.tokens) });
    this._poll();
  }

  /** Begins the authorisation redirect. */
  async connect() {
    const verifier = randomVerifier();
    writeStore(VERIFIER_STORE, verifier);

    const params = new URLSearchParams({
      client_id: SPOTIFY.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: await challengeFor(verifier),
      scope: SPOTIFY.scopes.join(' '),
    });

    window.location.assign(`${AUTH_URL}?${params.toString()}`);
  }

  /** Forgets the session. */
  disconnect() {
    this.tokens = null;
    writeStore(TOKEN_STORE, null);
    this._emit({ connected: false, playing: false, title: '', artist: '', art: '' });
  }

  async _exchangeCode(code) {
    const verifier = readStore(VERIFIER_STORE);
    if (!verifier) return;

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: SPOTIFY.clientId,
      code_verifier: verifier,
    });

    await this._requestTokens(body);
    writeStore(VERIFIER_STORE, null);
  }

  async _refresh() {
    if (!this.tokens?.refresh_token) return false;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refresh_token,
      client_id: SPOTIFY.clientId,
    });
    return this._requestTokens(body);
  }

  async _requestTokens(body) {
    try {
      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!response.ok) {
        // A refresh token can be revoked from the Spotify account page; when
        // that happens the only sane move is to drop the session.
        this.disconnect();
        return false;
      }

      const data = await response.json();
      this.tokens = {
        access_token: data.access_token,
        // A refresh response may omit the refresh token, meaning "keep the one
        // you have".
        refresh_token: data.refresh_token ?? this.tokens?.refresh_token,
        expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
      };
      writeStore(TOKEN_STORE, this.tokens);
      this._emit({ connected: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Valid access token, refreshing a minute ahead of expiry. */
  async _accessToken() {
    if (!this.tokens) return null;
    if (Date.now() > this.tokens.expires_at - 60_000) {
      const ok = await this._refresh();
      if (!ok) return null;
    }
    return this.tokens.access_token;
  }

  _schedule(seconds) {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._poll(), seconds * 1000);
  }

  async _poll() {
    if (this.disposed) return;

    const token = await this._accessToken();
    if (!token) {
      this._emit({ connected: false, playing: false });
      this._schedule(SPOTIFY.pollSeconds * 2);
      return;
    }

    try {
      const response = await fetch(NOW_PLAYING_URL, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.status === 204) {
        // Authorised, but nothing is playing right now.
        this._emit({ connected: true, playing: false });
        this._schedule(SPOTIFY.pollSeconds);
        return;
      }

      if (response.status === 401) {
        await this._refresh();
        this._schedule(1);
        return;
      }

      if (response.status === 429) {
        // Respect the back-off rather than hammering into a longer ban.
        const retry = Number(response.headers.get('Retry-After')) || 10;
        this._schedule(retry + 1);
        return;
      }

      if (!response.ok) {
        this._schedule(SPOTIFY.pollSeconds * 2);
        return;
      }

      const data = await response.json();
      const item = data?.item;

      if (!item) {
        this._emit({ connected: true, playing: false });
      } else {
        // Tracks carry an album; podcast episodes carry a show. Read both so
        // the card doesn't go blank on a podcast.
        const images = item.album?.images ?? item.images ?? [];
        const artist =
          item.artists?.map((a) => a.name).join(', ') ?? item.show?.name ?? '';

        this._emit({
          connected: true,
          playing: Boolean(data.is_playing),
          title: item.name ?? '',
          artist,
          // Middle image: large enough for a retina thumbnail, far smaller
          // than the 640px original.
          art: images[1]?.url ?? images[0]?.url ?? '',
        });
      }

      this._schedule(SPOTIFY.pollSeconds);
    } catch {
      // Offline or blocked: back off and try again.
      this._schedule(SPOTIFY.pollSeconds * 2);
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
  }
}
