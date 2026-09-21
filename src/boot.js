/**
 * boot.js — the opening sequence.
 *
 * The car is parked and perfectly still. Nothing about it moves: no roll-in, no
 * wheel rotation, no suspension. The only thing that travels is the camera,
 * which pushes in from a wide establishing frame to a close hero framing and
 * then keeps breathing almost imperceptibly.
 *
 * That is deliberate, and it is what makes this smooth where the previous
 * version was not. A driven car has to fight its own physics for every frame —
 * springs, weight transfer, wheel sync, road contact — and any disagreement
 * between those systems reads as shake. A static subject with a moving camera
 * has exactly one thing to get right: the camera's own path.
 *
 * Two choices carry the smoothness:
 *
 *  - The move is a *curve*, not a straight dolly. Position and aim are each a
 *    Catmull-Rom through three keys, so the camera arcs around toward the car
 *    rather than sliding at it down a ruler.
 *  - The easing is smootherstep (6t⁵−15t⁴+10t³), which has zero velocity *and*
 *    zero acceleration at both ends. An ordinary ease starts and stops with a
 *    visible tug; this one cannot, because there is no instant where the
 *    camera's acceleration jumps.
 *
 * The sequence never ends on a timer. It holds the hero frame indefinitely and
 * hands over only when the car actually starts moving.
 */

import * as THREE from 'three';
import { BOOT } from './config.js';
import { clamp } from './spring.js';

/** Zero velocity and zero acceleration at both ends — the smoothest ramp. */
const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);

export class BootSequence {
  /**
   * @param {object} car rig returned by loadCar()
   * @param {THREE.PerspectiveCamera} camera
   */
  constructor(car, camera) {
    this.car = car;
    this.camera = camera;

    const toCurve = (list) =>
      new THREE.CatmullRomCurve3(
        list.map((v) => new THREE.Vector3().fromArray(v)),
        false,
        'catmullrom',
        0.5
      );

    this.positionCurve = toCurve(BOOT.path.map((k) => k.position));
    this.targetCurve = toCurve(BOOT.path.map((k) => k.target));
    this.fovs = BOOT.path.map((k) => k.fov);

    this.cameraTarget = new THREE.Vector3();
    this._position = new THREE.Vector3();
    this._pivot = new THREE.Vector3();

    /** Kept so the drive phase can pick up a wheel rotation that never moved. */
    this.spin = 0;
    this.steer = 0;

    this.reset();
  }

  reset() {
    this.elapsed = 0;
    this.settled = false;
    this.park();
    this.update(0);
  }

  /** Puts the car dead level and motionless. Called once, not per frame. */
  park() {
    this.car.body.position.set(0, 0, 0);
    this.car.body.rotation.set(0, 0, 0);
    this.car.updateWheels(0, 0, 0);
  }

  /** Field of view along the move — interpolated on the same parameter. */
  fovAt(k) {
    const scaled = clamp(k, 0, 1) * (this.fovs.length - 1);
    const i = Math.min(this.fovs.length - 2, Math.floor(scaled));
    const f = scaled - i;
    return this.fovs[i] + (this.fovs[i + 1] - this.fovs[i]) * f;
  }

  /**
   * @param {number} dt seconds
   * @returns {boolean} true once the push has landed on the hero frame
   */
  update(dt) {
    this.elapsed += dt;

    const t = clamp(this.elapsed / BOOT.duration, 0, 1);
    const k = smootherstep(t);
    this.settled = t >= 1;

    this.positionCurve.getPoint(k, this._position);
    this.targetCurve.getPoint(k, this.cameraTarget);

    if (this.settled) this.applyDrift(this.elapsed - BOOT.duration);

    this.camera.position.copy(this._position);
    this.camera.lookAt(this.cameraTarget);

    const fov = this.fovAt(k);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    return this.settled;
  }

  /**
   * The held frame still breathes: a slow arc around the car, a few degrees
   * either way.
   *
   * The envelope matters more than the amplitude. A bare sine would start
   * moving at full speed the instant the push lands, and that step in velocity
   * is exactly the kind of tug the eye reads as a bump — so the drift is faded
   * in over its first couple of seconds, starting from a standstill.
   *
   * @param {number} since seconds since the push landed
   */
  applyDrift(since) {
    const envelope = smootherstep(clamp(since / BOOT.drift.easeIn, 0, 1));
    const angle =
      Math.sin((since / BOOT.drift.period) * Math.PI * 2) * BOOT.drift.azimuth * envelope;
    const lift =
      Math.sin((since / (BOOT.drift.period * 1.37)) * Math.PI * 2) *
      BOOT.drift.lift *
      envelope;

    // Orbit about the point the camera is looking at, so the subject stays put
    // while the viewpoint moves around it.
    this._pivot.copy(this.cameraTarget);
    this._position.sub(this._pivot);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = this._position.x * cos - this._position.z * sin;
    const z = this._position.x * sin + this._position.z * cos;
    this._position.set(x, this._position.y + lift, z).add(this._pivot);
  }

  /** How far the welcome line has faded up, 0..1. */
  get welcomeFade() {
    const start = BOOT.duration * BOOT.welcomeStart;
    return clamp((this.elapsed - start) / BOOT.welcomeFade, 0, 1);
  }
}
