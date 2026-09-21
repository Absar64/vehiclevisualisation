/**
 * idleShowcase.js — the stationary display.
 *
 * Once the car has been at rest for a few seconds the piece stops pretending to
 * drive and starts presenting. There are no cuts anywhere in it: the camera
 * flies one continuous closed loop around the car, passing through a set of
 * authored hero angles — front three-quarter, both flanks, both rear quarters
 * and a pass directly overhead.
 *
 * Three things make the motion work:
 *
 *  - Position, aim and up-vector are each a *closed* Catmull-Rom through the
 *    keyframes, so the path rejoins itself with no seam and the camera is never
 *    interpolating toward a pose in a straight line.
 *  - The parameter advances at a modulated rate that slows almost to a stop as
 *    it passes each keyframe and glides between them. The eye reads that as the
 *    camera settling on an angle and moving on, which is the part of the GTA
 *    loading screen worth keeping — without the hard cut.
 *  - Keyframes carry their own up-vector. The overhead shot looks straight down,
 *    where a world-up lookAt is degenerate and rolls unpredictably; giving that
 *    key an up along the car's nose pins the framing and the interpolation
 *    tilts into and out of it smoothly.
 */

import * as THREE from 'three';
import { IDLE } from './config.js';
import { clamp } from './spring.js';

/** Closed Catmull-Rom through scalar values — used for the field of view. */
function catmullScalar(values, u) {
  const n = values.length;
  const scaled = u * n;
  const i = Math.floor(scaled);
  const t = scaled - i;
  const p0 = values[(i - 1 + n) % n];
  const p1 = values[i % n];
  const p2 = values[(i + 1) % n];
  const p3 = values[(i + 2) % n];
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

export class IdleShowcase {
  /**
   * @param {THREE.Object3D} rig frame aligned with the car (+Z = nose)
   * @param {THREE.PerspectiveCamera} camera
   */
  constructor(rig, camera) {
    this.rig = rig;
    this.camera = camera;

    const keys = IDLE.orbit.keys;
    this.keyCount = keys.length;

    const toCurve = (list) =>
      new THREE.CatmullRomCurve3(
        list.map((v) => new THREE.Vector3().fromArray(v)),
        true, // closed: the loop has no start and no end
        'catmullrom',
        0.5
      );

    this.positionCurve = toCurve(keys.map((k) => k.position));
    this.targetCurve = toCurve(keys.map((k) => k.target));
    this.upCurve = toCurve(keys.map((k) => k.up ?? [0, 1, 0]));
    this.fovs = keys.map((k) => k.fov);

    this.u = 0;

    this._position = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._quaternion = new THREE.Quaternion();

    /**
     * An optional second subject. When set, the loop keeps orbiting but swings
     * its aim off the car and onto this point — which is how the people
     * standing around it ever get framed, rather than being whatever happens to
     * drift through the edge of a shot composed on the car.
     */
    this._subject = null;
    this._subjectWorld = new THREE.Vector3();
    this.subjectMix = 0;
  }

  /**
   * @param {THREE.Vector3|null} point in the rig's frame, or null to return to
   *   the car
   */
  setSubject(point) {
    this._subject = point ? point.clone() : null;
  }

  /** Starts the loop at the first keyframe. */
  reset() {
    this.u = 0;
    this.sample(0);
  }

  /**
   * Evaluates the loop at parameter u, leaving the pose in _position/_target/_up
   * as world-space vectors. Does not touch the camera.
   */
  sample(u) {
    const wrapped = ((u % 1) + 1) % 1;

    this.positionCurve.getPoint(wrapped, this._position);
    this.targetCurve.getPoint(wrapped, this._target);
    this.upCurve.getPoint(wrapped, this._up);
    this.fov = catmullScalar(this.fovs, wrapped);

    // Keys are authored in the car's frame; lift them into the world.
    this.rig.updateMatrixWorld();
    this.rig.localToWorld(this._position);
    this.rig.localToWorld(this._target);
    // The up-vector is a direction, not a point, so it takes the rig's
    // rotation alone — never its translation.
    this.rig.getWorldQuaternion(this._quaternion);
    this._up.applyQuaternion(this._quaternion).normalize();
  }

  /**
   * Advances the loop and writes the camera.
   * @param {number} dt seconds
   */
  update(dt) {
    // Rate modulation: slowest as the path passes a keyframe, quickest between
    // them. `dwell` of 0 is a constant glide, 1 stops dead on every angle.
    const phase = (this.u * this.keyCount) % 1;
    const nearKey = Math.pow(Math.cos(phase * Math.PI), 2); // 1 at a key, 0 between
    const rate = (1 - IDLE.orbit.dwell * nearKey) / IDLE.orbit.duration;

    this.u = (this.u + rate * dt) % 1;
    this.sample(this.u);

    // Ease on and off the second subject rather than snapping the aim across.
    const want = this._subject ? 1 : 0;
    this.subjectMix += (want - this.subjectMix) * (1 - Math.exp(-dt / IDLE.crewLook.blend));
    if (this._subject && this.subjectMix > 0.001) this._applySubject();

    this.applyToCamera();
  }

  /**
   * Swings the aim toward the subject and opens the lens a little.
   *
   * The camera keeps travelling its own path throughout and never leaves it,
   * so the result is a slow pan around the people rather than a cut to them.
   * The widening is there because the path already passes close to them; see
   * `IDLE.crewLook`.
   */
  _applySubject() {
    this._subjectWorld.copy(this._subject);
    this.rig.localToWorld(this._subjectWorld);

    const k = this.subjectMix;
    this._target.lerp(this._subjectWorld, k * IDLE.crewLook.aim);
    this.fov += k * IDLE.crewLook.widen;
  }

  /** Pushes the sampled pose onto the camera. */
  applyToCamera() {
    this.camera.position.copy(this._position);
    this.camera.up.copy(this._up);
    this.camera.lookAt(this._target);

    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** The pose the loop currently wants, for blending in and out of it. */
  get pose() {
    return { position: this._position, target: this._target, up: this._up, fov: this.fov };
  }

  /**
   * Finds the point on the loop closest to a given camera position, so the
   * entry blend can join the orbit where it is already heading rather than
   * dragging the camera back to a fixed start.
   *
   * @param {THREE.Vector3} from world-space camera position
   */
  seekNearest(from) {
    const samples = 96;
    let bestU = 0;
    let bestDistance = Infinity;
    const probe = new THREE.Vector3();

    for (let i = 0; i < samples; i++) {
      const u = i / samples;
      this.positionCurve.getPoint(u, probe);
      this.rig.localToWorld(probe);
      const distance = probe.distanceToSquared(from);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestU = u;
      }
    }

    this.u = bestU;
    this.sample(this.u);
  }
}
