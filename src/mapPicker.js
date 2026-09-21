/**
 * mapPicker.js — the location simulator.
 *
 * A full-window overlay holding a map of the UK. Drop a start pin and an end
 * pin, press DRIVE, and the route between them becomes the road the car is on.
 *
 * Deliberately *outside* the 461:165 stage and appended to the document body:
 * it is an operator tool, not part of the piece, and putting it inside the
 * banner would either squash it to an unusable strip or break the aspect ratio
 * the stage exists to hold.
 *
 * Leaflet and its stylesheet are fetched on first open rather than at page
 * load — the showcase should not pay for a mapping library it may never show.
 */

import { UK_BOUNDS, isInUK } from './osm.js';

const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js';
const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css';

/** Loads a script or stylesheet once, resolving when it is ready. */
function loadAsset(url, kind) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`[data-asset="${url}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') resolve();
      else existing.addEventListener('load', () => resolve(), { once: true });
      return;
    }

    const node =
      kind === 'css'
        ? Object.assign(document.createElement('link'), { rel: 'stylesheet', href: url })
        : Object.assign(document.createElement('script'), { src: url });

    node.dataset.asset = url;
    node.addEventListener('load', () => {
      node.dataset.loaded = 'true';
      resolve();
    });
    node.addEventListener('error', () => reject(new Error(`could not load ${url}`)));
    document.head.append(node);
  });
}

export class MapPicker {
  /**
   * @param {{onDrive:(from:object, to:object)=>Promise<string|void>}} handlers
   *   onDrive may return a status string to show, or throw to report an error.
   */
  constructor(handlers) {
    this.handlers = handlers;
    this.root = null;
    this.map = null;
    this.from = null;
    this.to = null;
    this.markers = [];
    this.line = null;
    this._listeners = [];
  }

  _on(node, type, handler) {
    node.addEventListener(type, handler);
    this._listeners.push([node, type, handler]);
  }

  /** Builds the overlay on first use, then shows it. */
  async open() {
    if (!this.root) {
      this._build();
      document.body.append(this.root);
    }
    this.root.classList.add('is-open');

    if (!this.map) {
      this._setStatus('Loading map…');
      try {
        await Promise.all([loadAsset(LEAFLET_CSS, 'css'), loadAsset(LEAFLET_JS, 'js')]);
        this._createMap();
        this._setStatus('Click to set the start point.');
      } catch (error) {
        this._setStatus(`Map unavailable: ${error.message}`);
      }
    }
  }

  close() {
    this.root?.classList.remove('is-open');
  }

  _build() {
    const root = document.createElement('div');
    root.className = 'mapsim';
    root.innerHTML = `
      <div class="mapsim__panel">
        <header class="mapsim__bar">
          <span class="mapsim__title">ROUTE SIMULATOR · UK</span>
          <button class="mapsim__close" type="button" aria-label="Close">✕</button>
        </header>
        <div class="mapsim__map"></div>
        <footer class="mapsim__bar mapsim__bar--foot">
          <span class="mapsim__status">Loading map…</span>
          <span class="mapsim__actions">
            <button class="mapsim__button" data-action="clear" type="button">CLEAR</button>
            <button class="mapsim__button mapsim__button--go" data-action="drive" type="button" disabled>DRIVE</button>
          </span>
        </footer>
      </div>`;

    this.status = root.querySelector('.mapsim__status');
    this.driveButton = root.querySelector('[data-action="drive"]');
    this.mapElement = root.querySelector('.mapsim__map');

    this._on(root.querySelector('.mapsim__close'), 'click', () => this.close());
    this._on(root.querySelector('[data-action="clear"]'), 'click', () => this._clearPins());
    this._on(this.driveButton, 'click', () => this._drive());
    // Clicking the backdrop closes; clicking the panel must not.
    this._on(root, 'click', (event) => {
      if (event.target === root) this.close();
    });

    this.root = root;
  }

  _createMap() {
    const L = window.L;
    this.L = L;

    this.map = L.map(this.mapElement, {
      // Hold the view inside the UK: the simulator is specified as UK-only, so
      // there is no reason to let the operator wander to another continent and
      // then be told no.
      maxBounds: L.latLngBounds(
        [UK_BOUNDS.south, UK_BOUNDS.west],
        [UK_BOUNDS.north, UK_BOUNDS.east]
      ),
      maxBoundsViscosity: 0.9,
      minZoom: 5,
      zoomControl: true,
    }).setView([54.2, -2.6], 6);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors',
    }).addTo(this.map);

    this.map.on('click', (event) => this._pin(event.latlng));

    // Leaflet measures the container on creation; it was display:none until a
    // moment ago, so the first layout is wrong without this.
    setTimeout(() => this.map.invalidateSize(), 60);
  }

  _pin(latlng) {
    const point = { lat: latlng.lat, lon: latlng.lng };

    if (!isInUK(point)) {
      this._setStatus('Outside the UK — pick a point on the mainland or islands.');
      return;
    }

    // Third click starts a fresh pair rather than silently doing nothing.
    if (this.from && this.to) this._clearPins();

    if (!this.from) {
      this.from = point;
      this._addMarker(point, 'A');
      this._setStatus('Now click to set the destination.');
    } else {
      this.to = point;
      this._addMarker(point, 'B');
      this._setStatus('Ready. Press DRIVE to run the route.');
      this.driveButton.disabled = false;
    }
  }

  _addMarker(point, label) {
    const icon = this.L.divIcon({
      className: 'mapsim__pin',
      html: `<span>${label}</span>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    this.markers.push(this.L.marker([point.lat, point.lon], { icon }).addTo(this.map));
  }

  _clearPins() {
    this.markers.forEach((m) => m.remove());
    this.markers.length = 0;
    this.line?.remove();
    this.line = null;
    this.from = null;
    this.to = null;
    this.driveButton.disabled = true;
    this._setStatus('Click to set the start point.');
  }

  /** Draws the resolved route so the operator can see what will be driven. */
  showRoute(points) {
    if (!this.map || !points?.length) return;
    this.line?.remove();
    this.line = this.L.polyline(
      points.map((p) => [p.lat, p.lon]),
      { color: '#ff8a2b', weight: 4, opacity: 0.9 }
    ).addTo(this.map);
    this.map.fitBounds(this.line.getBounds(), { padding: [30, 30] });
  }

  async _drive() {
    if (!this.from || !this.to) return;
    this.driveButton.disabled = true;
    this._setStatus('Finding a route…');

    try {
      const message = await this.handlers.onDrive(this.from, this.to);
      this._setStatus(message || 'Driving.');
      // Leave the overlay up for a beat so the route and its findings can be
      // read, then hand the screen back to the showcase.
      setTimeout(() => this.close(), 1400);
    } catch (error) {
      this._setStatus(error.message || 'Could not build that route.');
      this.driveButton.disabled = false;
    }
  }

  _setStatus(text) {
    if (this.status) this.status.textContent = text;
  }

  dispose() {
    this._listeners.forEach(([node, type, handler]) => node.removeEventListener(type, handler));
    this._listeners.length = 0;
    this.map?.remove();
    this.map = null;
    this.root?.remove();
    this.root = null;
  }
}
