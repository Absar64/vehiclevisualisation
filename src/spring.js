/**
 * spring.js — a damped spring, integrated in fixed sub-steps.
 *
 * Shared by the boot animation's suspension and the driving phase's weight
 * transfer. Explicit integration of a stiff spring goes unstable when dt gets
 * long (a dropped frame, a tab regaining focus); sub-stepping keeps the
 * effective step bounded so the body never rings or explodes.
 */

const SPRING_STEP = 1 / 240;
const MAX_STEP = 0.1;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Hermite ramp between two edges — the standard crossfade curve. */
export const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

export class Spring {
  /** @param {{stiffness:number, damping:number, limit:number}} config */
  constructor({ stiffness, damping, limit }) {
    this.k = stiffness;
    this.c = damping;
    this.limit = limit;
    this.value = 0;
    this.velocity = 0;
  }

  /**
   * @param {number} target rest position to chase
   * @param {number} dt seconds
   * @returns {number} the new value
   */
  update(target, dt) {
    const t = clamp(target, -this.limit, this.limit);
    let remaining = Math.min(dt, MAX_STEP);
    while (remaining > 0) {
      const step = Math.min(SPRING_STEP, remaining);
      const accel = -this.k * (this.value - t) - this.c * this.velocity;
      this.velocity += accel * step;
      this.value += this.velocity * step;
      remaining -= step;
    }
    return this.value;
  }

  reset() {
    this.value = 0;
    this.velocity = 0;
  }
}
