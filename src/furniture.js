/**
 * furniture.js — traffic signals and speed cameras, in yellow outline.
 *
 * Unlike the streetscape, which is decorative and recycles a fixed pool
 * endlessly, every item here corresponds to a real object at a real place:
 * a node from OpenStreetMap, projected onto the route to give it a distance
 * along the road and an offset from the centreline. It appears when the car
 * reaches it and never repeats.
 *
 * A route can hold hundreds of them, so meshes are *pooled and reassigned*
 * rather than created per item: each frame the items inside the visible window
 * are gathered and handed the pool's meshes. Scene size therefore stays fixed
 * no matter how long the route is, and a cross-London drive costs exactly as
 * much as a lap of the block.
 */

import * as THREE from 'three';
import { FURNITURE } from './config.js';
import { clamp } from './spring.js';
import { createOutlineMaterial, makeTrafficLight, makeSpeedCamera } from './props.js';

export class RoadFurniture {
  /** @param {THREE.Object3D} parent the drive rig — its +Z is the road ahead */
  constructor(parent) {
    this.group = new THREE.Group();
    parent.add(this.group);

    this.material = createOutlineMaterial({
      color: FURNITURE.color,
      near: FURNITURE.fadeNear,
      far: FURNITURE.fadeFar,
    });

    this.geometries = {
      signal: makeTrafficLight(),
      camera: makeSpeedCamera(),
    };

    // Two pools, because a mesh cannot change shape without swapping geometry
    // and swapping geometry every frame would thrash the renderer's caches.
    this.pools = {
      signal: this._createPool(this.geometries.signal, FURNITURE.signalPool),
      camera: this._createPool(this.geometries.camera, FURNITURE.cameraPool),
    };

    /** @type {{type:string, distance:number, lateral:number}[]} sorted by distance */
    this.items = [];
    this.opacity = 0;
    this._visible = { signal: [], camera: [] };
  }

  _createPool(geometry, size) {
    const pool = [];
    for (let i = 0; i < size; i++) {
      const mesh = new THREE.LineSegments(geometry, this.material);
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
      pool.push(mesh);
    }
    return pool;
  }

  /**
   * Installs the items for a route.
   * @param {{type:'signal'|'camera', distance:number, lateral:number}[]} items
   *   distance is metres from the route's start; lateral is metres right of the
   *   centreline.
   */
  setItems(items) {
    // Sorted once, so the per-frame pass can stop as soon as it runs past the
    // far plane instead of scanning the whole route.
    this.items = [...items].sort((a, b) => a.distance - b.distance);
    this._cursor = 0;
    this.hideAll();
  }

  clear() {
    this.items = [];
    this.hideAll();
  }

  hideAll() {
    for (const pool of Object.values(this.pools)) {
      for (const mesh of pool) mesh.visible = false;
    }
  }

  setOpacity(value) {
    this.opacity = clamp(value, 0, 1);
    this.material.uniforms.uOpacity.value = this.opacity * FURNITURE.opacity;
    this.group.visible = this.opacity > 0.002;
    if (!this.group.visible) this.hideAll();
  }

  /**
   * @param {import('./road.js').RoadModel} road
   */
  update(road) {
    if (!this.group.visible || !this.items.length) return;

    const travelled = road.travelled;
    const near = -FURNITURE.behind;
    const far = FURNITURE.fadeFar;

    this._visible.signal.length = 0;
    this._visible.camera.length = 0;

    // Items are sorted, so this is a windowed scan rather than a full one.
    for (const item of this.items) {
      const s = item.distance - travelled;
      if (s < near) continue;
      if (s > far) break;

      const bucket = this._visible[item.type];
      if (bucket && bucket.length < this.pools[item.type].length) {
        bucket.push({ item, s });
      }
    }

    for (const type of ['signal', 'camera']) {
      const pool = this.pools[type];
      const visible = this._visible[type];

      for (let i = 0; i < pool.length; i++) {
        const mesh = pool[i];
        if (i >= visible.length) {
          mesh.visible = false;
          continue;
        }

        const { item, s } = visible[i];
        const centre = road.place(s, item.lateral, mesh.position);
        // Face back down the road at the oncoming car, which is how a signal
        // head and a camera housing are both actually aimed.
        mesh.rotation.y = centre.heading + Math.PI;
        mesh.visible = true;
      }
    }
  }

  dispose() {
    this.group.removeFromParent();
    Object.values(this.geometries).forEach((g) => g.dispose());
    this.material.dispose();
    this.items = [];
  }
}
