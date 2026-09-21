/**
 * surge.js — rolling rate-of-change evaluation and tier blending.
 *
 * The rule the effects obey is a set of (gain, window) conditions: +10 mph
 * inside 1 s is the low tier, +20 / +30 / +40 mph inside 1.5 s are the three
 * above it, each scaled by SURGE.sensitivity. Speed built up gently satisfies
 * none of them, so nothing plays.
 *
 * Two properties matter more than the thresholds themselves:
 *
 *  - **It is a rolling evaluation, not an event.** A short history of speed
 *    samples is kept, and each tier asks "how much has speed risen inside *my*
 *    window?" every frame. There is no launch to open or close and no floor to
 *    remember, so a pull that begins gently and hardens is measured correctly
 *    from the moment it hardens.
 *
 *  - **The result is continuous, not an integer.** Each tier reports how far
 *    the current gain has carried it between the tier below and its own
 *    threshold, and the model takes the highest. A gain of 25 mph inside 1.5 s
 *    therefore reads as level 2.5, not as "tier 2" — so stepping up mid-pull
 *    blends the tunnel velocity, FOV stretch and glow onward from where they
 *    already are instead of restarting them at a new setting. Everything
 *    downstream reads one signal, `power`, and inherits that continuity.
 *
 * When no condition is met any more the demand falls away and `power` ramps
 * down on a slow release, so the effect ends by decaying rather than cutting.
 */

import { SURGE } from './config.js';
import { clamp } from './spring.js';

export class SurgeModel {
  constructor() {
    /** Continuous tier position, 0 … tiers.length. Fractional between tiers. */
    this.level = 0;
    /** Smoothed 0..1 drive for every effect. */
    this.power = 0;
    /** Short decaying spike fired as each whole tier is crossed. */
    this.pulse = 0;
    /** Largest gain currently satisfying any tier, in mph — for debugging. */
    this.gain = 0;

    // Ring buffer of {t, mph}. Sized for a very high frame rate across the
    // longest window, with a generous margin; it never reallocates.
    this._capacity = 512;
    this._times = new Float64Array(this._capacity);
    this._speeds = new Float32Array(this._capacity);
    this._head = 0; // index one past the newest sample
    this._count = 0;
    this._clock = 0;

    this._lastWholeTier = 0;
  }

  get maxLevel() {
    return SURGE.tiers.length;
  }

  reset() {
    this.level = 0;
    this.power = 0;
    this.pulse = 0;
    this.gain = 0;
    this._head = 0;
    this._count = 0;
    this._clock = 0;
    this._lastWholeTier = 0;
  }

  /** Records the current speed against the model's own clock. */
  _push(mph) {
    this._times[this._head] = this._clock;
    this._speeds[this._head] = mph;
    this._head = (this._head + 1) % this._capacity;
    if (this._count < this._capacity) this._count++;
  }

  /**
   * Speed gained across a window: current speed minus the lowest speed seen
   * inside it. Taking the minimum rather than the sample at exactly `window`
   * ago means a momentary dip part-way through a pull cannot mask the gain.
   *
   * @param {number} window seconds
   * @param {number} current current speed in mph
   */
  gainWithin(window, current) {
    const cutoff = this._clock - window;
    let lowest = current;

    // Walk backwards from the newest sample until the window closes.
    for (let i = 1; i <= this._count; i++) {
      const index = (this._head - i + this._capacity) % this._capacity;
      if (this._times[index] < cutoff) break;
      if (this._speeds[index] < lowest) lowest = this._speeds[index];
    }

    return current - lowest;
  }

  /**
   * @param {number} dt seconds
   * @param {import('./speed.js').SpeedModel} speed
   */
  update(dt, speed) {
    this._clock += dt;
    this._push(speed.mph);

    // Every tier is evaluated every frame against its own window. A tier's
    // contribution is how far the gain has carried it from the tier below it
    // up to its own threshold, offset by its index — so the maximum across all
    // tiers is a single continuous position through the whole ladder.
    let demand = 0;
    let gain = 0;

    for (let i = 0; i < SURGE.tiers.length; i++) {
      const tier = SURGE.tiers[i];
      const tierGain = tier.gain / SURGE.sensitivity;
      // Each tier interpolates from the one below it up to its own threshold.
      // The first tier's floor is a deadband just under its condition, so a
      // pull has to get most of the way there before anything shows at all —
      // without it, any gentle acceleration would raise a faint surge.
      const floorGain =
        i === 0 ? tierGain * SURGE.entryBand : SURGE.tiers[i - 1].gain / SURGE.sensitivity;
      const windowGain = this.gainWithin(tier.window, speed.mph);

      const progress = clamp((windowGain - floorGain) / (tierGain - floorGain), 0, 1);
      // A tier that has not been entered contributes nothing. It must not hand
      // back its own index as a floor, or the ladder could never read below it.
      if (progress <= 0) continue;

      const position = i + progress;
      if (position > demand) {
        demand = position;
        gain = windowGain;
      }
    }

    this.gain = gain;
    this.level = demand;

    // A whole tier crossing fires the punch. Fractional movement inside a tier
    // deliberately does not, so the jolt marks real steps up.
    const whole = Math.floor(demand);
    if (whole > this._lastWholeTier) this.pulse = 1;
    this._lastWholeTier = whole;
    this.pulse *= Math.exp(-dt / SURGE.pulseDecay);

    // Power rises quickly — a harder pull should register immediately — and
    // falls slowly, so when the conditions stop being met the effect ramps
    // down and terminates instead of snapping off.
    const target = demand / this.maxLevel;
    const tau = target > this.power ? SURGE.attack : SURGE.release;
    this.power += (target - this.power) * (1 - Math.exp(-dt / tau));
    this.power = clamp(this.power, 0, 1);
  }

  /**
   * How far a given tier has come in, 0..1.
   *
   * Effects that belong to one tier only (streaks from 2, ground blur from 3,
   * the edge flare at 4) fade themselves in across their own band of `power`,
   * so they arrive on the same continuous build-up as everything else.
   *
   * @param {number} tier 1-based tier number
   */
  tierWeight(tier) {
    const band = 1 / this.maxLevel;
    const start = (tier - 1) * band;
    return clamp((this.power - start) / band, 0, 1);
  }
}
