/**
 * drive.js — Phase 2: the chase camera and the car's behaviour at speed.
 *
 * The car never actually translates here. It holds the mark it settled on at
 * the end of the boot animation, and the world moves instead: the tunnel flows
 * past, the wheels spin at true ground speed, and the body squats and sways on
 * its springs. That keeps the studio lighting, the floor and the shadow exactly
 * where they were tuned, and it means speed can jump around under the
 * simulator without the car ever leaving the frame.
 *
 * A "drive rig" — an empty frame positioned at the car with its +Z along the
 * car's nose — gives everything a common reference: the chase camera sits at a
 * fixed offset inside it, and the scene layers are parented to it.
 *
 * Curvature enters here in three places, and all three read the same road
 * model, so the car, the camera and the scenery execute a turn together:
 * the front wheels steer by δ ≈ wheelbase · κ, the body leans on its sway
 * spring under lateral acceleration v²κ, and the camera rides the centreline
 * behind the car while aiming at a point further along the curve.
 */

import * as THREE from 'three';
import { DRIVE, ROAD } from './config.js';
import { Spring, clamp } from './spring.js';

const MPH_TO_MPS = 0.44704;

export class DriveMode {
  /**
   * @param {THREE.Scene} scene
   * @param {object} car rig from loadCar()
   * @param {THREE.PerspectiveCamera} camera
   */
  constructor(scene, car, camera) {
    this.car = car;
    this.camera = camera;

    this.rig = new THREE.Group();
    scene.add(this.rig);

    this.squat = new Spring(DRIVE.squat);
    this.sway = new Spring(DRIVE.sway);

    this.spin = 0;
    this.elapsed = 0;
    this.heading = 0;
    this.cameraLocalZ = -DRIVE.camera.distance;
    /** Smoothed steering angle, so the wheels lead the bend rather than snap. */
    this.steer = 0;
    /** @type {import('./road.js').RoadModel|null} */
    this.road = null;

    // Reusable vectors — the loop allocates nothing.
    this._cameraPosition = new THREE.Vector3();
    /** Public: the transition and idle blends read this. */
    this.cameraTarget = new THREE.Vector3();
  }

  /**
   * Anchors the rig to wherever the boot animation left the car.
   * @param {number} spin the wheels' accumulated rotation, carried over
   */
  anchor(spin) {
    this.rig.position.copy(this.car.group.position);
    this.rig.rotation.y = this.car.group.rotation.y;
    this.heading = this.car.group.rotation.y;
    this.spin = spin;
    this.elapsed = 0;
    this.squat.reset();
    this.sway.reset();
  }

  /**
   * Chase camera pose in world space, written into the supplied vectors.
   * Exposed separately from update() so the transition can blend toward the
   * drive framing before the drive phase owns the camera.
   *
   * @param {number} mph used for the speed-proportional pull-back
   */
  resolveCamera(mph, outPosition, outTarget, road = this.road) {
    const normalised = clamp(mph / DRIVE.camera.pullbackReference, 0, 1);
    // Kept as a plain number too: the tunnel measures its fades from the
    // camera, in arc distance along the road rather than in world space.
    this.cameraLocalZ = -(DRIVE.camera.distance + normalised * DRIVE.camera.pullback);

    outPosition.set(0, DRIVE.camera.height, this.cameraLocalZ);
    outTarget.set(0, DRIVE.camera.targetHeight, DRIVE.camera.targetAhead);

    if (road) {
      // The camera rides the centreline behind the car...
      road.place(this.cameraLocalZ, 0, outPosition);

      // ...and aims at the road ahead, with the aim point's sideways travel
      // scaled and capped. That turns the frame into the bend without letting
      // the camera chase the corner and leave the car behind.
      const ahead = road.sample(DRIVE.camera.targetAhead);
      const swing = clamp(
        ahead.x * ROAD.cameraSwing.gain,
        -ROAD.cameraSwing.limit,
        ROAD.cameraSwing.limit
      );
      outTarget.set(swing, DRIVE.camera.targetHeight, ahead.z);
    }

    this.rig.updateMatrixWorld();
    this.rig.localToWorld(outPosition);
    this.rig.localToWorld(outTarget);
  }

  /**
   * Field of view for a given speed and launch power — the "FOV stretch".
   * @param {number} mph
   * @param {number} power 0..1 surge power
   */
  resolveFov(mph, power) {
    return DRIVE.fov.base + mph * DRIVE.fov.perMph + power * DRIVE.fov.surge;
  }

  /**
   * @param {number} dt seconds
   * @param {import('./speed.js').SpeedModel} speed
   * @param {import('./surge.js').SurgeModel} surge launch tiering
   * @param {import('./road.js').RoadModel} [road] road geometry
   */
  update(dt, speed, surge, road = this.road) {
    this.road = road ?? null;
    this.elapsed += dt;
    const mps = speed.mph * MPH_TO_MPS;

    // Wheels turn at true ground speed, same omega = v / r as the boot phase.
    this.spin -= (mps / this.car.wheelRadius) * dt;

    // Weight transfer: accelerating squats the rear (nose up, so negative
    // pitch under this rig's convention), lifting off settles it forward. The
    // tier multiplier is what makes a 40 mph launch visibly heavier on its
    // haunches than a 10 mph one, rather than merely faster.
    const squatDrive = speed.accel * (1 + surge.power * DRIVE.squat.surgeGain);
    const pitch = this.squat.update(-squatDrive * DRIVE.squat.gain, dt);

    // Lane-keeping wander — two incommensurate sines so it never visibly
    // repeats, scaled by speed so the car is dead still at a standstill.
    const wander =
      Math.sin(this.elapsed * DRIVE.body.swaySpeed) * 0.6 +
      Math.sin(this.elapsed * DRIVE.body.swaySpeed * 1.71 + 2.1) * 0.4;
    const lateral = wander * DRIVE.body.swayAmplitude * speed.normalised;

    // Cornering. Curvature under the car sets the steering angle; lateral
    // acceleration v²κ sets the lean, so the body rolls *out* of the turn
    // exactly as weight transfer makes a real one do, and harder the faster it
    // is taken.
    const curvature = road ? road.curvatureAtCar : 0;
    const steerTarget = clamp(
      Math.atan(ROAD.steer.wheelbase * curvature),
      -ROAD.steer.limit,
      ROAD.steer.limit
    );
    this.steer += (steerTarget - this.steer) * (1 - Math.exp(-dt / 0.22));

    const lateralAccel = mps * mps * curvature;
    const leanTarget = clamp(
      lateralAccel * ROAD.lean.gain,
      -ROAD.lean.limit,
      ROAD.lean.limit
    );
    const roll = this.sway.update(-lateral * DRIVE.sway.gain + leanTarget, dt);

    // Applied to the body shell, not the chassis frame, so the wheel-planting
    // pass still holds all four tyres on the ground.
    this.car.body.position.x = lateral;
    this.car.body.position.y = 0;
    this.car.body.rotation.x = pitch;
    this.car.body.rotation.z = roll;

    this.car.updateWheels(this.spin, this.steer, pitch);

    // Camera: fixed chase offset plus a high-speed pull-back, with a shiver
    // that grows with speed to suggest road texture through the chassis.
    this.resolveCamera(speed.mph, this._cameraPosition, this.cameraTarget, road);
    // Road shiver scales with speed; the surge terms are the extra kick that
    // makes a hard launch feel like the chassis loading up. The pulse gives
    // each tier promotion a momentary jolt on top.
    const shake =
      DRIVE.camera.shake * speed.normalised +
      DRIVE.camera.shakeSurge * surge.power +
      DRIVE.camera.shakePulse * surge.pulse;
    this._cameraPosition.x += Math.sin(this.elapsed * 23.3) * shake;
    this._cameraPosition.y += Math.sin(this.elapsed * 31.7 + 1.3) * shake * 0.7;

    this.camera.position.copy(this._cameraPosition);
    this.camera.lookAt(this.cameraTarget);

    const fov = this.resolveFov(speed.mph, surge.power + surge.pulse * 0.35);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  dispose() {
    this.rig.removeFromParent();
  }
}
