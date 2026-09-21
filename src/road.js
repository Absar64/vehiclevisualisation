/**
 * road.js — road geometry and turn anticipation.
 *
 * Everything in the driving view is drawn in the car's own frame: the car holds
 * the origin and the world flows past it. A curved road is therefore not a
 * matter of moving the car — it is a centreline that bends *ahead* of a fixed
 * origin, and every prop, ring and streak is placed against it.
 *
 * The centreline is rebuilt every frame by integrating a curvature profile:
 *
 *     θ(s+ds) = θ(s) + κ(s)·ds        heading
 *     x(s+ds) = x(s) + sin(θ)·ds      lateral position
 *     z(s+ds) = z(s) + cos(θ)·ds      distance down the frame
 *
 * Integrating properly in two dimensions, rather than treating lateral offset
 * as a function of z, is what lets the road bend through a genuine 90° junction
 * instead of folding back on itself once the heading passes about 45°.
 *
 * The result lands in one Float32Array that serves two consumers at once: JS
 * samples it directly for the props, rings, car and camera, and the same array
 * is uploaded as a 128×1 DataTexture so the GPU-driven speed streaks can place
 * themselves on the identical curve in their vertex shader. One source of
 * truth, so no layer can disagree about where the road is.
 *
 * Curvature itself comes from three places, in order of preference:
 *   1. A parsed route — waypoints turned into signed heading changes at known
 *      distances, which is genuine *anticipation*: the bend exists in the
 *      geometry long before the car reaches it.
 *   2. Live GPS heading change, when there is no route to follow. That is
 *      detection rather than anticipation, and is smoothed hard because it is
 *      differentiated from noisy fixes.
 *   3. The simulated navigation stream, for testing without moving.
 */

import * as THREE from 'three';
import { ROAD } from './config.js';
import { clamp } from './spring.js';

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

/**
 * Sign convention.
 *
 * Internally, heading follows three.js yaw: a positive heading steers toward
 * +X, which — with the camera looking down +Z and up along +Y — appears on the
 * *left* of the screen. Compass bearings run the other way, positive clockwise.
 *
 * Every public entry point therefore takes "positive = right", the way a driver
 * or a navigation instruction means it, and negates once on the way in. Getting
 * this wrong is silent and total: the road simply bends away from every turn.
 */
const TO_INTERNAL = -1;

/** Wraps an angle into [-π, π]. */
function wrapAngle(a) {
  let x = (a + Math.PI) % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return x - Math.PI;
}

/**
 * One anticipated bend.
 *
 * `start` is metres ahead of the car and counts down as the car travels.
 * Curvature is a raised cosine across the turn's length, which integrates to
 * exactly `angle` while starting and ending at zero curvature — the same
 * property a real clothoid transition has, and the reason a bend eases in
 * rather than snapping to a fixed radius.
 */
class Turn {
  constructor(angle, length, start) {
    this.angle = angle;
    this.length = Math.max(1, length);
    this.start = start;
  }

  curvatureAt(s) {
    const u = (s - this.start) / this.length;
    if (u <= 0 || u >= 1) return 0;
    return (this.angle / this.length) * (1 - Math.cos(u * Math.PI * 2));
  }

  /** True once the whole transition is behind the car. */
  get spent() {
    return this.start + this.length < -ROAD.behind - 10;
  }
}

export class RoadModel {
  constructor() {
    this.samples = ROAD.samples;
    this.step = (ROAD.behind + ROAD.range) / (this.samples - 1);
    /**
     * Index of s = 0. The requested `behind` is then snapped to a whole number
     * of steps and that snapped value is used everywhere — otherwise s = 0
     * falls between two texels and the whole road sits a fraction of a step out
     * of place, which shows up as the car not quite sitting on its own
     * centreline through a bend.
     */
    this.originIndex = Math.round(ROAD.behind / this.step);
    this.behind = this.originIndex * this.step;
    this.span = this.behind + (this.samples - 1 - this.originIndex) * this.step;

    // [x, z, heading, curvature] per sample.
    this.data = new Float32Array(this.samples * 4);

    this.texture = new THREE.DataTexture(
      this.data,
      this.samples,
      1,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    // Sampled with explicit two-tap interpolation in the shader, so nearest
    // filtering here keeps it portable — linear filtering of float textures
    // needs an extension that is not universally present.
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;

    /** @type {Turn[]} */
    this.turns = [];
    /**
     * The subset of turns overlapping the sampled window, refreshed once per
     * rebuild. A city route holds hundreds of bends but only a handful are
     * ever inside 276 m of the car; without this the integration would be
     * O(samples x turns) and a long route would cost real frame time.
     * @type {Turn[]}
     */
    this._active = [];
    /** Curvature derived from live GPS heading change, when there is no route. */
    this.liveCurvature = 0;
    this._liveTarget = 0;

    // Route state.
    this.route = null;
    this.travelled = 0;

    this._lastFix = null;
    this._lastBearing = null;

    // Separate scratch objects. sample() hands back a shared one, so anything
    // that samples again before reading the previous result would silently
    // clobber it; the accessors below therefore keep their own.
    this._scratch = { x: 0, z: 0, heading: 0, curvature: 0 };
    this._carScratch = { x: 0, z: 0, heading: 0, curvature: 0 };

    this.rebuild();
  }

  // ── Curvature sources ────────────────────────────────────────────────────

  /**
   * Queues a bend from the simulated navigation stream.
   * @param {number} angleDegrees signed; positive turns right
   * @param {number} [distance] metres ahead to place it
   */
  queueTurn(angleDegrees, distance = ROAD.previewDistance) {
    const angle = angleDegrees * DEG * TO_INTERNAL;
    const length = clamp(
      Math.abs(angle) * ROAD.turnLengthPerRadian,
      ROAD.minTurnLength,
      ROAD.maxTurnLength
    );
    this.turns.push(new Turn(angle, length, distance));
    // Integrate straight away: a bend queued between frames must be on the
    // centreline the very next time anything samples it.
    this.rebuild();
  }

  /** Clears every bend and returns to straight-road kinematics. */
  setStraight() {
    this.turns.length = 0;
    this.liveCurvature = 0;
    this._liveTarget = 0;
    this.route = null;
    this.travelled = 0;
    this._lastBearing = null;
    this.rebuild();
  }

  /**
   * Installs a route to anticipate.
   *
   * Waypoints are flattened to local metres about the first point, which is
   * accurate well past the few kilometres this ever looks ahead, and each
   * interior vertex becomes a turn whose angle is the heading change there.
   *
   * @param {{lat:number, lon:number}[]} points
   */
  setRoute(points) {
    if (!points || points.length < 3) {
      this.setStraight();
      return;
    }

    const origin = points[0];
    const cosLat = Math.cos(origin.lat * DEG);
    const local = points.map((p) => ({
      x: (p.lon - origin.lon) * DEG * EARTH_RADIUS_M * cosLat,
      z: (p.lat - origin.lat) * DEG * EARTH_RADIUS_M,
    }));

    // Cumulative distance and per-segment bearing.
    const distances = [0];
    const bearings = [];
    for (let i = 1; i < local.length; i++) {
      const dx = local[i].x - local[i - 1].x;
      const dz = local[i].z - local[i - 1].z;
      distances.push(distances[i - 1] + Math.hypot(dx, dz));
      bearings.push(Math.atan2(dx, dz));
    }

    this.route = { local, distances, bearings, origin, cosLat };
    this.travelled = 0;
    this.turns.length = 0;

    // Interior vertices carry the heading changes.
    for (let i = 1; i < bearings.length; i++) {
      // Bearings are compass-positive (clockwise); flip into the internal
      // convention so a route that turns right renders as a right-hand bend.
      const angle = wrapAngle(bearings[i] - bearings[i - 1]) * TO_INTERNAL;
      if (Math.abs(angle) < ROAD.minTurnAngle) continue;

      const length = clamp(
        Math.abs(angle) * ROAD.turnLengthPerRadian,
        ROAD.minTurnLength,
        ROAD.maxTurnLength
      );
      // Centre the transition on the vertex, as a real road does.
      this.turns.push(new Turn(angle, length, distances[i] - length / 2));
    }

    this.rebuild();
  }

  /**
   * A live position fix.
   *
   * With a route loaded this only advances progress along it. Without one, the
   * change in bearing between fixes gives the curvature the car is *currently*
   * in — detection rather than anticipation, but better than assuming straight.
   *
   * @param {{latitude:number, longitude:number}} coords
   * @param {number} mph current speed
   */
  onFix(coords, mph) {
    const previous = this._lastFix;
    this._lastFix = coords;
    if (!previous) return;

    const cosLat = Math.cos(previous.latitude * DEG);
    const dx = (coords.longitude - previous.longitude) * DEG * EARTH_RADIUS_M * cosLat;
    const dz = (coords.latitude - previous.latitude) * DEG * EARTH_RADIUS_M;
    const moved = Math.hypot(dx, dz);
    // Below a couple of metres the bearing is mostly GPS noise.
    if (moved < 2) return;

    const bearing = Math.atan2(dx, dz);
    if (this._lastBearing !== null && !this.route) {
      // κ = dθ/ds — heading change per metre travelled.
      const curvature = (wrapAngle(bearing - this._lastBearing) / moved) * TO_INTERNAL;
      this._liveTarget = clamp(curvature, -ROAD.maxCurvature, ROAD.maxCurvature);
    }
    this._lastBearing = bearing;
  }

  // ── Per-frame ────────────────────────────────────────────────────────────

  /**
   * @param {number} dt seconds
   * @param {number} mph current speed
   */
  update(dt, mph) {
    const travel = mph * 0.44704 * dt;

    if (travel > 0) {
      this.travelled += travel;
      // Bends approach at road speed. Nothing is rebuilt or spawned as they
      // arrive — they were always in the profile, just further away — which is
      // what keeps a bend from popping into existence.
      for (const turn of this.turns) turn.start -= travel;
    }

    // Retire bends once they are fully behind the camera.
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i].spent) this.turns.splice(i, 1);
    }

    // Live curvature is eased rather than applied raw: it is differentiated
    // from GPS fixes and would otherwise jitter the whole road.
    this.liveCurvature +=
      (this._liveTarget - this.liveCurvature) * (1 - Math.exp(-dt / ROAD.liveSmoothing));

    this.rebuild();
  }

  /**
   * Total curvature at a distance ahead, from every active source.
   * Reads `_active`, so refreshActive() must have run for this window.
   */
  curvatureAt(s) {
    let k = this.liveCurvature;
    for (const turn of this._active) k += turn.curvatureAt(s);
    return clamp(k, -ROAD.maxCurvature, ROAD.maxCurvature);
  }

  /** Narrows `turns` to those overlapping the table's span. */
  refreshActive() {
    const near = -this.behind;
    const far = this.span - this.behind;
    this._active.length = 0;
    for (const turn of this.turns) {
      if (turn.start + turn.length < near || turn.start > far) continue;
      this._active.push(turn);
    }
  }

  /**
   * Re-integrates the centreline.
   *
   * Integration starts at the car (s = 0, where position and heading are zero
   * by definition) and runs forward to the far plane, then backward to cover
   * the stretch behind the camera. Both halves share the same origin, so the
   * road is continuous across it.
   */
  rebuild() {
    const { data, samples, step, originIndex } = this;
    this.refreshActive();

    // Forward from the car.
    let x = 0;
    let z = 0;
    let heading = 0;
    for (let i = originIndex; i < samples; i++) {
      const s = (i - originIndex) * step;
      const k = this.curvatureAt(s);
      const o = i * 4;
      data[o] = x;
      data[o + 1] = z;
      data[o + 2] = heading;
      data[o + 3] = k;

      heading += k * step;
      x += Math.sin(heading) * step;
      z += Math.cos(heading) * step;
    }

    // Backward from the car, undoing the same integration.
    x = 0;
    z = 0;
    heading = 0;
    for (let i = originIndex - 1; i >= 0; i--) {
      const s = (i - originIndex) * step;
      const k = this.curvatureAt(s);
      heading -= k * step;
      x -= Math.sin(heading) * step;
      z -= Math.cos(heading) * step;

      const o = i * 4;
      data[o] = x;
      data[o + 1] = z;
      data[o + 2] = heading;
      data[o + 3] = k;
    }

    this.texture.needsUpdate = true;
  }

  // ── Sampling ─────────────────────────────────────────────────────────────

  /**
   * Centreline state at a distance ahead of the car.
   *
   * The default return value is a shared object that the *next* call to
   * sample() overwrites. Read what you need before sampling again, or pass your
   * own `out`.
   *
   * @param {number} s metres; negative is behind
   * @param {{x:number,z:number,heading:number,curvature:number}} [out]
   */
  sample(s, out = this._scratch) {
    const position = clamp((s + this.behind) / this.step, 0, this.samples - 1);
    const i = Math.min(this.samples - 2, Math.floor(position));
    const f = position - i;

    const a = i * 4;
    const b = a + 4;
    const data = this.data;

    out.x = data[a] + (data[b] - data[a]) * f;
    out.z = data[a + 1] + (data[b + 1] - data[a + 1]) * f;
    out.heading = data[a + 2] + (data[b + 2] - data[a + 2]) * f;
    out.curvature = data[a + 3] + (data[b + 3] - data[a + 3]) * f;
    return out;
  }

  /**
   * World-space position of a point offset laterally from the centreline.
   * @param {number} s metres along the road
   * @param {number} lateral metres to the right of the centreline
   * @param {THREE.Vector3} out receives (x, existing y, z)
   */
  place(s, lateral, out) {
    const road = this.sample(s);
    const cos = Math.cos(road.heading);
    const sin = Math.sin(road.heading);
    // Right-hand normal to a tangent of (sin θ, cos θ) is (cos θ, -sin θ).
    out.x = road.x + cos * lateral;
    out.z = road.z - sin * lateral;
    return road;
  }

  /** Total length of the loaded route, in metres. 0 when there is none. */
  get routeLength() {
    const distances = this.route?.distances;
    return distances ? distances[distances.length - 1] : 0;
  }

  /** How far through the loaded route the car is, 0..1. */
  get routeProgress() {
    const length = this.routeLength;
    return length > 0 ? clamp(this.travelled / length, 0, 1) : 0;
  }

  /**
   * Projects a real-world point onto the loaded route.
   *
   * Returns how far along the route its closest point lies and how far to the
   * side it sits — which is exactly the (distance, lateral) pair the furniture
   * layer needs to place a real traffic signal or camera on this road.
   *
   * @param {number} lat
   * @param {number} lon
   * @param {number} [maxLateral] discard anything further from the road than this
   * @returns {{distance:number, lateral:number}|null}
   */
  projectOntoRoute(lat, lon, maxLateral = 40) {
    const route = this.route;
    if (!route) return null;

    // Same flattening as setRoute, about the same origin.
    const px = (lon - route.origin.lon) * DEG * EARTH_RADIUS_M * route.cosLat;
    const pz = (lat - route.origin.lat) * DEG * EARTH_RADIUS_M;

    let best = null;

    for (let i = 1; i < route.local.length; i++) {
      const a = route.local[i - 1];
      const b = route.local[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const lengthSq = dx * dx + dz * dz;
      if (lengthSq < 1e-6) continue;

      // Closest point on this segment, clamped to its ends.
      const t = clamp(((px - a.x) * dx + (pz - a.z) * dz) / lengthSq, 0, 1);
      const cx = a.x + dx * t;
      const cz = a.z + dz * t;
      const offset = Math.hypot(px - cx, pz - cz);

      if (best && offset >= best.offset) continue;

      // Signed side: the cross product of the segment direction with the
      // vector to the point. Positive is the left-hand side of travel, which
      // matches the lateral convention used by place().
      const length = Math.sqrt(lengthSq);
      const cross = (dx * (pz - a.z) - dz * (px - a.x)) / length;

      best = {
        offset,
        distance: route.distances[i - 1] + length * t,
        lateral: cross,
      };
    }

    if (!best || best.offset > maxLateral) return null;
    return { distance: best.distance, lateral: best.lateral };
  }

  /** Curvature under the car — what the steering and body lean respond to. */
  get curvatureAtCar() {
    return this.sample(0, this._carScratch).curvature;
  }

  /** True when nothing is bending the road right now. */
  get isStraight() {
    return this.turns.length === 0 && Math.abs(this.liveCurvature) < 1e-4;
  }

  dispose() {
    this.texture.dispose();
  }
}
