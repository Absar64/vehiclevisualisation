/**
 * speed.js — where the number on the HUD comes from.
 *
 * Two sources feed one model:
 *
 *  - Real GPS, via navigator.geolocation.watchPosition(). Browsers may or may
 *    not fill in coords.speed, so a great-circle fallback derives speed from
 *    consecutive fixes. Permission denial, an insecure origin or simply
 *    standing still all resolve to 0 rather than to an error state.
 *  - The simulator, driven by the debug panel. Once the operator touches it, it
 *    latches and outranks GPS until the boot sequence is replayed — otherwise a
 *    stray fix would fight the slider mid-test.
 *
 * The raw target then passes through a rate limiter and a smoothing filter, so
 * jumping the slider produces an *acceleration* rather than a cut. That
 * acceleration is the only thing surge.js watches, which is what lets it tell a
 * hard launch from the same speed reached gently.
 */

import { SPEEDO, IDLE } from './config.js';
import { clamp } from './spring.js';

const MPS_TO_MPH = 2.2369362920544;
const EARTH_RADIUS_M = 6371008.8;

/** Great-circle distance between two fixes, in metres. */
function haversine(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toRad;
  const dLon = (b.longitude - a.longitude) * toRad;
  const lat1 = a.latitude * toRad;
  const lat2 = b.latitude * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class SpeedModel {
  constructor() {
    /** Smoothed, displayed speed in MPH. */
    this.mph = 0;
    /** Smoothed acceleration in MPH/s — what the surge effects key off. */
    this.accel = 0;
    /** 'gps' | 'sim' | 'idle' */
    this.source = 'idle';
    /** Human-readable status for the debug panel. */
    this.status = 'waiting';

    this._target = 0;
    this._ramped = 0;
    this._rate = SPEEDO.minAccelMphPerSec;
    this._simLatched = false;
    this._watchId = null;
    this._lastFix = null;
    this._lastFixTime = 0;

    /**
     * Optional hook for anything else that wants raw fixes — the road model
     * uses it to derive curvature from bearing changes. Assigned by the owner.
     * @type {((coords:GeolocationCoordinates, mph:number)=>void)|null}
     */
    this.onFix = null;
  }

  // -- Sources --------------------------------------------------------------

  /** Begins watching real position. Safe to call when geolocation is absent. */
  startGeolocation() {
    if (!('geolocation' in navigator)) {
      this.status = 'no geolocation api';
      return;
    }

    try {
      this._watchId = navigator.geolocation.watchPosition(
        (position) => this._onFix(position),
        (error) => {
          // Denied, unavailable or timed out — all of which simply mean the
          // HUD has no real speed to show. The simulator still works.
          this.status = `gps ${error.code === 1 ? 'denied' : 'unavailable'}`;
          if (!this._simLatched) this._setTarget(0);
        },
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
      );
      this.status = 'gps pending';
    } catch (error) {
      this.status = 'gps unavailable';
    }
  }

  _onFix(position) {
    const { coords, timestamp } = position;
    let mps = null;

    // Devices with a real GNSS chip report Doppler speed directly; it is far
    // more stable than differentiating positions, so prefer it when present.
    if (typeof coords.speed === 'number' && Number.isFinite(coords.speed) && coords.speed >= 0) {
      mps = coords.speed;
    } else if (this._lastFix) {
      const dt = (timestamp - this._lastFixTime) / 1000;
      if (dt > 0.2) mps = haversine(this._lastFix, coords) / dt;
    }

    this._lastFix = { latitude: coords.latitude, longitude: coords.longitude };
    this._lastFixTime = timestamp;

    this.onFix?.(coords, this.mph);

    if (mps === null) return;
    this.status = 'gps live';
    if (this._simLatched) return; // the operator is driving the simulator

    this.source = 'gps';
    this._setTarget(mps * MPS_TO_MPH, true);
  }

  /**
   * Sets a new target and, with it, the rate the car will travel toward it.
   *
   * The rate is chosen *once*, from the size of the change being asked for, and
   * held for the whole move. Recomputing it each frame from the shrinking gap
   * would make the approach asymptotic — a commanded +10 mph would deliver only
   * about 8.6 of it inside a one-second window, and the tier conditions in
   * surge.js would never quite be met. A fixed rate is also what actually
   * happens: a driver picks a throttle opening and holds it.
   *
   * @param {number} mph
   * @param {boolean} [immediate] follow at full rate — used for real GPS, where
   *   the fix already *is* the truth and rate-limiting it would only add lag.
   */
  _setTarget(mph, immediate = false) {
    this._target = clamp(mph, 0, SPEEDO.maxMph);
    const change = Math.abs(this._target - this._ramped);
    this._rate = immediate
      ? SPEEDO.launchMphPerSec
      : clamp(change * SPEEDO.rateGain, SPEEDO.minAccelMphPerSec, SPEEDO.launchMphPerSec);
  }

  /**
   * The opening demo speed. Deliberately does NOT latch: unlike operator input
   * this is only a stand-in for telemetry that has not arrived yet, so the
   * first real fix must still be able to take over.
   */
  setDemo(mph) {
    if (this._simLatched || this.source === 'gps') return;
    this.source = 'sim';
    this.status = 'demo';
    this._setTarget(mph);
  }

  /** Debug-panel input. Latches until releaseSimulator() is called. */
  setSimulated(mph) {
    this._simLatched = true;
    this.source = 'sim';
    this.status = 'simulated';
    this._setTarget(mph);
  }

  /** Hands control back to GPS (used when the boot sequence is replayed). */
  releaseSimulator() {
    this._simLatched = false;
    this.source = this._lastFix ? 'gps' : 'idle';
    this._setTarget(0);
  }

  /** True once the operator has taken manual control. */
  get isSimulated() {
    return this._simLatched;
  }

  // -- Integration ----------------------------------------------------------

  /**
   * Rate-limits the target, then smooths it, then differentiates the result.
   *
   * The rate limit is what turns a slider jump into a believable surge: speed
   * builds over time, exactly as a real car's would.
   *
   * @param {number} dt seconds
   */
  update(dt) {
    const gap = this._target - this._ramped;

    // The rate was fixed when the target was set, so the pull is steady all the
    // way to it; braking has its own constant.
    const rate = gap > 0 ? this._rate : SPEEDO.brakeMphPerSec;
    const step = dt * rate;
    this._ramped += clamp(gap, -step, step);

    // First-order smoothing rounds off the corners where the ramp starts and
    // stops, so the needle never changes acceleration instantaneously.
    const alpha = 1 - Math.exp(-dt / SPEEDO.smoothing);
    const next = this.mph + (this._ramped - this.mph) * alpha;

    const rawAccel = dt > 0 ? (next - this.mph) / dt : 0;
    // The acceleration signal drives glow and FOV, so smooth it harder than the
    // speed itself — visual effects amplify noise that the number hides.
    this.accel += (rawAccel - this.accel) * (1 - Math.exp(-dt / 0.28));
    this.mph = next;
  }

  /**
   * The speed currently being asked for, as opposed to the one being shown.
   * The route planner compares against this so it only re-commands when the
   * target has genuinely moved — every call resets the rate limiter, so
   * re-issuing the same target each frame would stall the ramp on the spot.
   */
  get commandedMph() {
    return this._target;
  }

  /** Normalised 0..1 speed, for effects that scale across the whole range. */
  get normalised() {
    return clamp(this.mph / SPEEDO.maxMph, 0, 1);
  }

  /** True while the car is effectively stopped. */
  get isStopped() {
    return this.mph < IDLE.speedEpsilon;
  }

  dispose() {
    if (this._watchId !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(this._watchId);
      this._watchId = null;
    }
  }
}
