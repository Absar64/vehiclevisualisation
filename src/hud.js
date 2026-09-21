/**
 * hud.js — the DOM overlay.
 *
 * Built in JS rather than authored in index.html so the whole overlay is one
 * self-disposing unit: it owns its elements and its listeners, and dispose()
 * removes both. Sizing is expressed in container-query units (cqw/cqh) against
 * the 461:165 stage, so the HUD scales with the banner instead of with the
 * viewport — a readout sized in vw would blow out of a small embed.
 *
 * Everything is pointer-events: none except the simulator panel, so the overlay
 * never eats interaction meant for the canvas.
 */

import { SPEEDO } from './config.js';

/** Gear glyph for the settings button. Inline so it needs no icon font. */
const GEAR_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path fill="currentColor" d="M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.24-1.13.55-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.65 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.5.39 1.05.7 1.63.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.58-.24 1.13-.55 1.63-.94l2.39.96c.22.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64ZM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5Z"/>
</svg>`;

/** Small helper: element with class, optional text, optional attributes. */
function el(tag, className, text, attrs) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

export class Hud {
  /**
   * @param {HTMLElement} container the stage element
   * @param {{onSimulate:(mph:number)=>void, onReplay:()=>void}} handlers
   */
  constructor(container, handlers) {
    this.handlers = handlers;
    this._listeners = [];
    this._lastShown = -1;
    this._lastFlare = -1;
    this._lastWelcome = -1;
    this._lastRider = -1;
    this._welcomeHidden = false;
    this._welcomeTarget = 0;

    this.root = el('div', 'hud');
    this.root.setAttribute('aria-hidden', 'true');

    // -- Giant readout (right) ----------------------------------------------
    const readout = el('div', 'hud__readout');
    this.value = el('div', 'hud__value', '0');
    const unit = el('div', 'hud__unit', 'MPH');
    readout.append(this.value, unit);
    this.readout = readout;
    this.root.append(readout);

    this.root.append(this._buildPassenger());

    // Welcome line, shown on the boot screen only.
    this.welcome = el('div', 'welcome');
    this.root.append(this.welcome);

    // Edge flare: the top tier's contribution to the HUD. Driven per frame
    // rather than by a CSS transition so it stays locked to the launch.
    this.flare = el('div', 'hud__flare');
    this.root.append(this.flare);

    this.root.append(this._buildNowPlaying());
    this.root.append(this._buildPanel());
    this.root.append(this._buildSettings());
    container.append(this.root);

    // Closing the settings menu by clicking away from it. Registered on the
    // stage rather than the menu so it fires for the canvas too.
    this._on(container, 'pointerdown', (event) => {
      if (!this.settingsWrap.contains(event.target)) this.settingsWrap.classList.remove('is-open');
    });
  }

  /**
   * The settings menu, top right.
   *
   * Icon only, no label — it is a gear, which needs no explaining. It owns the
   * things that are not part of setting off: hiding the crew, and the
   * simulator, which used to sit in the corner on its own.
   */
  _buildSettings() {
    const wrap = el('div', 'settings');
    this.settingsWrap = wrap;

    const button = el('button', 'settings__button', null, {
      type: 'button',
      'aria-label': 'Settings',
      title: 'Settings',
    });
    button.innerHTML = GEAR_SVG;
    this._on(button, 'click', () => wrap.classList.toggle('is-open'));
    wrap.append(button);

    const menu = el('div', 'settings__menu');

    // Same state as the boot-screen tick box; both are kept in step by
    // setHideCrew, so whichever one is used the other agrees.
    this.settingsHide = this._buildToggle('settings__row', 'Hide Miis', (v) =>
      this.handlers.onHideCrew?.(v)
    );
    menu.append(this.settingsHide.row);

    // The greeting only ever appears on the boot screen, so this lives here
    // alone rather than being doubled onto the boot screen as well.
    this.settingsHideWelcome = this._buildToggle('settings__row', 'Hide welcome text', (v) =>
      this.setHideWelcome(v)
    );
    menu.append(this.settingsHideWelcome.row);

    const sim = el('button', 'settings__item', 'Simulation', { type: 'button' });
    this._on(sim, 'click', () => {
      wrap.classList.remove('is-open');
      this.panel.classList.toggle('is-open');
    });
    menu.append(sim);

    wrap.append(menu);
    return wrap;
  }

  /**
   * One tick box. "Hide Miis" is built twice — once for the boot screen, once
   * for the settings menu — because the same switch is wanted in both places.
   */
  _buildToggle(className, label, onChange) {
    const row = el('label', className);
    const input = el('input', null, null, { type: 'checkbox' });
    this._on(input, 'change', () => onChange(input.checked));
    row.append(input, el('span', null, label));
    return { row, input };
  }

  /** Reflects the hide-crew state on both tick boxes at once. */
  setHideCrew(hidden) {
    this.settingsHide.input.checked = hidden;
    this.riderHide.input.checked = hidden;
  }

  /**
   * Hides the greeting outright, whatever the boot fade is doing.
   *
   * Handled here rather than by suppressing the text, because the opacity is
   * written every frame by the boot sequence — gating it at the one setter is
   * what stops the next frame putting it straight back.
   */
  setHideWelcome(hidden) {
    this._welcomeHidden = hidden;
    this.settingsHideWelcome.input.checked = hidden;
    this.setWelcomeOpacity(this._welcomeTarget);
  }

  /**
   * The passenger control, shown on the boot screen.
   *
   * A single small button until it is pressed, then a short list of whatever
   * Miis are in the folder. Deliberately not in the sim panel: it is part of
   * setting off, not a debug tool.
   */
  _buildPassenger() {
    const wrap = el('div', 'rider');
    this.riderWrap = wrap;

    this.riderButton = el('button', 'rider__button', 'Add passenger', { type: 'button' });
    this._on(this.riderButton, 'click', () => {
      const open = wrap.classList.toggle('is-open');
      if (open) this.handlers.onPassengerOpen?.();
    });
    wrap.append(this.riderButton);

    // The same tick box as in the settings menu, put where someone deciding
    // who is coming along would look for it. The wrap is column-reverse, so
    // appending before the list stacks it button → tick box → list going up.
    this.riderHide = this._buildToggle('rider__hide', 'Hide Miis', (v) =>
      this.handlers.onHideCrew?.(v)
    );
    wrap.append(this.riderHide.row);

    this.riderList = el('div', 'rider__list');
    wrap.append(this.riderList);

    return wrap;
  }

  /**
   * Fills the passenger list.
   * @param {{name:string, url:string}[]} miis
   * @param {string|null} current url of the passenger already riding, if any
   */
  setPassengerOptions(miis, current) {
    this.riderList.innerHTML = '';

    if (!miis.length) {
      this.riderList.append(el('span', 'rider__empty', 'No Miis found in /Mii'));
      return;
    }

    const rows = [{ name: 'Drive solo', url: null }, ...miis];
    for (const mii of rows) {
      const row = el('button', 'rider__option', mii.name, { type: 'button' });
      if (mii.url === current) row.classList.add('is-active');
      this._on(row, 'click', () => {
        this.riderWrap.classList.remove('is-open');
        this.handlers.onPassengerPick?.(mii.url ? mii : null);
      });
      this.riderList.append(row);
    }
  }

  /** Reflects who is riding, if anyone. */
  setPassenger(name) {
    this.riderButton.textContent = name ? `Passenger: ${name}` : 'Add passenger';
    this.riderWrap.classList.toggle('has-rider', Boolean(name));
  }

  /** The control belongs to the boot screen; it fades with the welcome line. */
  setPassengerOpacity(value) {
    const rounded = Math.round(value * 100) / 100;
    if (rounded === this._lastRider) return;
    this._lastRider = rounded;
    this.riderWrap.style.opacity = rounded.toFixed(2);
    this.riderWrap.style.pointerEvents = rounded > 0.5 ? 'auto' : 'none';
    if (rounded <= 0.5) this.riderWrap.classList.remove('is-open');
  }

  /**
   * The now-playing card, top left.
   *
   * Status is carried entirely by iconography — an animated equaliser while a
   * track is running, a Spotify-style glyph to connect — so the only text on
   * the card is the track's own title and artist.
   */
  _buildNowPlaying() {
    const card = el('div', 'now');
    this.nowCard = card;

    this.nowArt = el('div', 'now__art');
    card.append(this.nowArt);

    const body = el('div', 'now__body');

    // Four bars that bounce while audio is playing and flatten when it is not.
    const eq = el('div', 'now__eq');
    for (let i = 0; i < 4; i++) eq.append(el('span'));
    this.nowEq = eq;

    this.nowTitle = el('div', 'now__title');
    this.nowArtist = el('div', 'now__artist');

    const heading = el('div', 'now__heading');
    heading.append(eq, this.nowTitle);
    body.append(heading, this.nowArtist);
    card.append(body);

    // Icon-only connect control, shown until a session exists.
    const connect = el('button', 'now__connect', null, { type: 'button', title: 'Connect Spotify' });
    connect.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="11" fill="currentColor" opacity="0.14"/>' +
      '<path d="M6.5 9.2c3.6-1.1 7.9-.8 11.1 1.1" />' +
      '<path d="M7.3 12.4c3-0.9 6.5-0.6 9.1 0.9" />' +
      '<path d="M8.1 15.5c2.4-0.7 5.2-0.5 7.3 0.7" />' +
      '</svg>';
    this._on(connect, 'click', () => this.handlers.onSpotifyConnect?.());
    this.nowConnect = connect;
    card.append(connect);

    return card;
  }

  /**
   * @param {{connected:boolean, playing:boolean, title?:string,
   *          artist?:string, art?:string}} state
   */
  setNowPlaying(state) {
    const hasTrack = Boolean(state.connected && state.title);

    this.nowCard.classList.toggle('is-connected', Boolean(state.connected));
    this.nowCard.classList.toggle('has-track', hasTrack);
    this.nowCard.classList.toggle('is-playing', Boolean(state.playing));

    if (state.art !== this._lastArt) {
      this._lastArt = state.art;
      this.nowArt.style.backgroundImage = state.art ? `url("${state.art}")` : '';
    }
    if (state.title !== this._lastTitle) {
      this._lastTitle = state.title;
      this.nowTitle.textContent = state.title ?? '';
    }
    if (state.artist !== this._lastArtist) {
      this._lastArtist = state.artist;
      this.nowArtist.textContent = state.artist ?? '';
    }
  }

  /**
   * The collapsible simulator/debug panel.
   *
   * It has no toggle of its own any more — it is opened from the settings
   * menu, which is where a debug surface belongs rather than sitting in the
   * corner of the stage permanently.
   */
  _buildPanel() {
    const panel = el('div', 'panel');
    this.panel = panel;

    const body = el('div', 'panel__body');
    const close = el('button', 'panel__close', '×', { type: 'button', 'aria-label': 'Close' });
    this._on(close, 'click', () => panel.classList.remove('is-open'));
    body.append(close);

    // Slider 0..140
    const row = el('div', 'panel__row');
    this.slider = el('input', 'panel__slider', null, {
      type: 'range',
      min: '0',
      max: String(SPEEDO.maxMph),
      step: '1',
      value: '0',
    });
    this.sliderValue = el('span', 'panel__readout', '0');
    this._on(this.slider, 'input', () => {
      const mph = Number(this.slider.value);
      this.sliderValue.textContent = String(mph);
      this.handlers.onSimulate(mph);
    });
    row.append(this.slider, this.sliderValue);
    body.append(row);

    // Presets
    const presets = el('div', 'panel__presets');
    for (const mph of [0, 55, 90, 127]) {
      const button = el('button', 'panel__button', `${mph} MPH`, { type: 'button' });
      this._on(button, 'click', () => {
        this.slider.value = String(mph);
        this.sliderValue.textContent = String(mph);
        this.handlers.onSimulate(mph);
      });
      presets.append(button);
    }
    body.append(presets);

    // Route controls: feed the simulated navigation stream so straight and
    // curved scenarios can be tested without moving.
    const route = el('div', 'panel__presets panel__presets--route');
    const bends = [
      ['STRAIGHT', null],
      ['◀ 30°', -30],
      ['30° ▶', 30],
      ['◀ 60°', -60],
      ['60° ▶', 60],
      ['S-BEND', 's'],
    ];
    for (const [label, angle] of bends) {
      const button = el('button', 'panel__button', label, { type: 'button' });
      this._on(button, 'click', () => this.handlers.onRoute?.(angle));
      route.append(button);
    }
    body.append(route);

    // Force the parked state, to inspect the crew without waiting for the
    // five-second idle timer.
    const crewRow = el('div', 'panel__presets panel__presets--route');
    for (const [label, action] of [
      ['FORCE IDLE', 'idle'],
      ['SHUFFLE', 'shuffle'],
      ['RELOAD MIIS', 'reload'],
    ]) {
      const button = el('button', 'panel__button', label, { type: 'button' });
      this._on(button, 'click', () => this.handlers.onCrew?.(action));
      crewRow.append(button);
    }
    body.append(crewRow);

    const map = el('button', 'panel__button panel__button--wide', 'ROUTE SIMULATOR (MAP)', {
      type: 'button',
    });
    this._on(map, 'click', () => this.handlers.onOpenMap?.());
    body.append(map);

    const replay = el('button', 'panel__button panel__button--wide', 'REPLAY BOOT ANIMATION', {
      type: 'button',
    });
    this._on(replay, 'click', () => {
      this.slider.value = '0';
      this.sliderValue.textContent = '0';
      this.handlers.onReplay();
    });
    body.append(replay);

    panel.append(body);
    return panel;
  }

  _on(node, type, handler) {
    node.addEventListener(type, handler);
    this._listeners.push([node, type, handler]);
  }

  /** Fades the telemetry in as the drive phase takes over. */
  setOpacity(value) {
    this.root.style.setProperty('--hud-opacity', String(value));
  }

  /**
   * Sets the greeting shown over the boot screen.
   * @param {string} text already lower case
   */
  setWelcome(text) {
    this.welcome.textContent = text;
  }

  /** @param {number} value 0..1 */
  setWelcomeOpacity(value) {
    // Kept so setHideWelcome can re-apply the fade's current level when the
    // tick box is cleared, rather than guessing at it.
    this._welcomeTarget = value;
    const rounded = Math.round((this._welcomeHidden ? 0 : value) * 100) / 100;
    if (rounded === this._lastWelcome) return;
    this._lastWelcome = rounded;
    this.welcome.style.opacity = rounded.toFixed(2);
  }

  /**
   * Edge flare for the hardest launches only.
   * @param {number} value 0..1
   */
  setFlare(value) {
    const rounded = Math.round(value * 100) / 100;
    if (rounded === this._lastFlare) return;
    this._lastFlare = rounded;
    this.flare.style.opacity = rounded.toFixed(2);
  }

  /**
   * @param {import('./speed.js').SpeedModel} speed
   */
  update(speed, surgePower = 0) {
    const shown = Math.round(speed.mph);
    // Only touch the DOM when the displayed integer actually changes; writing
    // identical text every frame forces needless layout work.
    if (shown !== this._lastShown) {
      this.value.textContent = String(shown);
      this._lastShown = shown;
    }

    // Surge gives the number a little weight: a touch of scale and a hotter
    // glow while accelerating, settling back at constant speed.
    // The readout keys off launch power, not raw acceleration, so its lift
    // matches whichever tier is playing.
    this.readout.style.setProperty('--surge', surgePower.toFixed(3));
  }

  dispose() {
    this._listeners.forEach(([node, type, handler]) => node.removeEventListener(type, handler));
    this._listeners.length = 0;
    this.root.remove();
  }
}
