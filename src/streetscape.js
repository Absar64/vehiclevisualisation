/**
 * streetscape.js — the calm state.
 *
 * Outline trees, bushes, buildings and street lamps drifting past on both
 * verges, plus lane markings down the road edges. This is what shows while
 * cruising, easing up to speed or slowing down; the warp tunnel only takes over
 * for a genuine hard launch.
 *
 * Two decisions carry the look:
 *
 * Props and the depth-faded line material both come from props.js, shared with
 * the parked showroom, so the two read as the same world at different speeds.
 *
 * Each prop tracks its own arc distance `s` down the road rather than a plain
 * z, and is re-placed against the road centreline every frame. On a straight
 * road that is identical to sliding it in z; through a bend the verges sweep
 * around with the carriageway, and a prop recycled at the far end reappears
 * already sitting on the curve — so a bend never pops into being.
 */

import * as THREE from 'three';
import { STREET, DRIVE } from './config.js';
import { clamp } from './spring.js';
import {
  SegmentBuilder,
  createOutlineMaterial,
  makeTree,
  makeConifer,
  makeBush,
  makeBuilding,
  makeLamp,
  makeRailing,
} from './props.js';

export class Streetscape {
  /**
   * @param {THREE.Object3D} parent the drive rig — its +Z is the road ahead
   */
  constructor(parent) {
    this.group = new THREE.Group();
    parent.add(this.group);

    this.material = createOutlineMaterial({
      color: STREET.color,
      near: STREET.fadeNear,
      far: STREET.fadeFar,
    });
    this.dashMaterial = createOutlineMaterial({
      color: STREET.dash.color,
      near: STREET.fadeNear,
      far: STREET.fadeFar,
    });

    // A small library of prop shapes, reused across the pool. Buildings sit
    // further back than greenery, so they are tracked separately.
    this.geometries = {
      verge: [makeTree(1), makeTree(4), makeConifer(2), makeConifer(5), makeBush(3), makeRailing()],
      lamp: [makeLamp()],
      far: [makeBuilding(1), makeBuilding(2), makeBuilding(3), makeBuilding(5)],
    };

    this.origin = -(DRIVE.camera.distance + STREET.recycleBehind);
    this.length = STREET.count * STREET.spacing;

    this.props = [];
    this._populate();
    this._populateDashes();

    this.opacity = 0;
  }

  /** Lays out the prop pool down both verges. */
  _populate() {
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < STREET.count; i++) {
        // Deterministic pseudo-random: cheap, repeatable, no RNG state.
        const seed = i * 2.399963 + (side > 0 ? 1.13 : 4.57);
        const r1 = (Math.sin(seed) * 43758.5453) % 1;
        const r2 = (Math.sin(seed * 1.7 + 2.1) * 24634.6345) % 1;
        const pick = Math.abs(r1);

        let geometry;
        let lateral;
        if (pick < 0.26) {
          // Buildings set back behind the verge.
          geometry = this.geometries.far[i % this.geometries.far.length];
          lateral = STREET.vergeHalf + 9.5 + Math.abs(r2) * 10;
        } else if (pick < 0.38) {
          geometry = this.geometries.lamp[0];
          lateral = STREET.vergeHalf - 0.6;
        } else {
          geometry = this.geometries.verge[i % this.geometries.verge.length];
          lateral = STREET.vergeHalf + Math.abs(r2) * 3.4;
        }

        const mesh = new THREE.LineSegments(geometry, this.material);
        mesh.frustumCulled = false;
        mesh.position.set(side * lateral, 0, this.origin + i * STREET.spacing + r2 * 3.5);
        mesh.userData.s = mesh.position.z;
        mesh.userData.homeS = mesh.position.z;
        mesh.userData.span = this.length;
        mesh.userData.lateral = side * lateral;
        // Lamps hang over the road; everything else faces it.
        mesh.userData.facing = side > 0 ? 0 : Math.PI;
        mesh.rotation.y = mesh.userData.facing;
        mesh.scale.setScalar(0.85 + Math.abs(r1) * 0.5);

        this.group.add(mesh);
        this.props.push(mesh);
      }
    }
  }

  /** Lane markings: short dashes running down both road edges. */
  _populateDashes() {
    const { count, spacing, length, halfWidth } = STREET.dash;
    const builder = new SegmentBuilder();
    builder.line(0, 0.01, -length / 2, 0, 0.01, length / 2);
    const geometry = builder.build();

    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < count; i++) {
        const dash = new THREE.LineSegments(geometry, this.dashMaterial);
        dash.frustumCulled = false;
        dash.position.set(side * halfWidth, 0, this.origin + i * spacing);
        dash.userData.s = dash.position.z;
        dash.userData.homeS = dash.position.z;
        dash.userData.span = count * spacing;
        dash.userData.lateral = side * halfWidth;
        dash.userData.facing = 0;
        this.group.add(dash);
        this.props.push(dash);
      }
    }
    this.dashGeometry = geometry;
  }

  /** Layer fade — driven by the crossfade against the warp tunnel. */
  setOpacity(value) {
    this.opacity = clamp(value, 0, 1);
    this.material.uniforms.uOpacity.value = this.opacity * STREET.opacity;
    this.dashMaterial.uniforms.uOpacity.value = this.opacity * STREET.dash.opacity;
    this.group.visible = this.opacity > 0.002;
  }

  /** Returns every prop to the slot it was laid out in. */
  reset() {
    for (const prop of this.props) {
      prop.userData.s = prop.userData.homeS;
      prop.position.z = prop.userData.homeS;
      prop.position.x = prop.userData.lateral;
      prop.rotation.y = prop.userData.facing;
    }
  }

  /**
   * @param {number} dt seconds
   * @param {number} mph current speed
   * @param {import('./road.js').RoadModel} road
   */
  update(dt, mph, road) {
    if (!this.group.visible) return;

    const travel = mph * 0.44704 * dt;
    // A stationary car on a straight road has nothing to re-place; skip the
    // whole pass rather than burning it on identical transforms.
    if (travel <= 0 && road.isStraight && this._wasStraight) return;
    this._wasStraight = road.isStraight;

    for (const prop of this.props) {
      const data = prop.userData;
      data.s -= travel;
      // Each prop carries the span of its own pool, so greenery and lane
      // markings can recycle on different intervals.
      if (data.s < this.origin) data.s += data.span;

      const centre = road.place(data.s, data.lateral, prop.position);
      // Props turn with the carriageway, so verges stay parallel to the road.
      prop.rotation.y = data.facing + centre.heading;
    }
  }

  dispose() {
    this.group.removeFromParent();
    Object.values(this.geometries).flat().forEach((g) => g.dispose());
    this.dashGeometry.dispose();
    this.material.dispose();
    this.dashMaterial.dispose();
    this.props.length = 0;
  }
}
