/**
 * tunnel.js — the acceleration warp tunnel.
 *
 * A column of concentric rounded-rectangle rings receding down the road, which
 * rush the camera at a rate driven by speed. Rings are recycled from the near
 * plane back to the far plane, so the effect runs forever from a fixed pool of
 * geometry — no allocation in the animation loop.
 *
 * This layer is reserved for hard acceleration, and it is *tiered*. Rings are
 * sorted into three density classes at build time, and each class fades in over
 * its own band of surge power: a gentle 10 mph pull lights only every fourth
 * ring, a 40 mph launch lights the lot and drives their cores white-hot. The
 * column therefore densifies as a launch escalates instead of switching on.
 *
 * Rings track an arc distance down the road rather than a plain z, and are
 * re-placed and re-aimed against the centreline every frame, so the column
 * banks through a bend with the carriageway instead of boring straight through
 * the scenery.
 *
 * Each ring is drawn as a *ribbon*, not a line: THREE's LineBasicMaterial
 * ignores linewidth on virtually every platform, so a one-pixel hairline is all
 * you can get from it, and a hairline cannot glow. The ribbon is a thin strip
 * of triangles following the rounded-rect path, shaded with a bright core and
 * an exponential falloff across its width, drawn additively. That gives real
 * thickness, a hot centre and a soft bloom-like halo without a post-process.
 */

import * as THREE from 'three';
import { TUNNEL, DRIVE } from './config.js';
import { clamp } from './spring.js';

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform float uIntensity;
  varying vec2 vUv;

  void main() {
    // uv.y runs 0..1 across the ribbon's width; remap to 0 at the centreline.
    float d = abs(vUv.y - 0.5) * 2.0;

    // A tight core for the filament itself, plus a wide exponential halo that
    // stands in for a bloom pass.
    float core = pow(max(0.0, 1.0 - d), 4.0);
    float halo = exp(-d * 2.4) * 0.42;

    vec3 colour = mix(uColor, uCore, core);
    float energy = (core + halo) * uIntensity;
    if (energy <= 0.001) discard;

    gl_FragColor = vec4(colour * energy, energy);
  }
`;

/**
 * Builds a flat ribbon that follows a rounded rectangle in the XY plane.
 * Vertices are emitted in pairs offset along the path's in-plane normal, with
 * uv.y = 0 and 1 on the two edges so the shader knows where the centreline is.
 */
function createRingGeometry(width, height, radius, ribbonWidth) {
  const halfW = width / 2;
  const halfH = height / 2;
  const r = Math.min(radius, halfW, halfH);
  const cornerSegments = 8;

  /** @type {number[][]} points around the path, counter-clockwise */
  const points = [];
  const corners = [
    { cx: halfW - r, cy: halfH - r, start: 0 },              // top-right
    { cx: -halfW + r, cy: halfH - r, start: Math.PI / 2 },   // top-left
    { cx: -halfW + r, cy: -halfH + r, start: Math.PI },      // bottom-left
    { cx: halfW - r, cy: -halfH + r, start: -Math.PI / 2 },  // bottom-right
  ];

  for (const corner of corners) {
    for (let i = 0; i <= cornerSegments; i++) {
      const angle = corner.start + (i / cornerSegments) * (Math.PI / 2);
      points.push([corner.cx + Math.cos(angle) * r, corner.cy + Math.sin(angle) * r]);
    }
  }
  points.push(points[0]); // close the loop

  const half = ribbonWidth / 2;
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    // Outward normal of a rounded rect is simply the direction from its centre
    // for the corners, and the axis direction along the straights; normalising
    // the point itself is a close enough approximation at these proportions.
    const len = Math.hypot(x, y) || 1;
    const nx = x / len;
    const ny = y / len;

    positions.push(x - nx * half, y - ny * half, 0);
    uvs.push(i / (points.length - 1), 0);
    positions.push(x + nx * half, y + ny * half, 0);
    uvs.push(i / (points.length - 1), 1);

    if (i < points.length - 1) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

export class WarpTunnel {
  /**
   * @param {THREE.Object3D} parent frame whose -Z... +Z axis is the road ahead
   */
  constructor(parent) {
    this.group = new THREE.Group();
    // Rings are authored around the origin; lift the whole column so the road
    // surface sits at the bottom of the frame rather than through the car.
    this.group.position.y = TUNNEL.centreHeight;
    parent.add(this.group);

    // One geometry, shared by every ring.
    this.geometry = createRingGeometry(
      TUNNEL.width,
      TUNNEL.height,
      TUNNEL.radius,
      TUNNEL.ribbonWidth
    );

    this.colorFar = new THREE.Color(TUNNEL.colorFar);
    this.colorNear = new THREE.Color(TUNNEL.colorNear);
    this.core = new THREE.Color(TUNNEL.core);

    this.rings = [];
    this.materials = [];
    this.length = TUNNEL.count * TUNNEL.spacing;
    /** Rings are recycled once they get this far behind the chase camera. */
    this.origin = -(DRIVE.camera.distance + TUNNEL.recycleBehind);

    for (let i = 0; i < TUNNEL.count; i++) {
      // Every ring needs its own uniforms (colour and intensity vary with
      // distance), so each gets its own material instance.
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: this.colorFar.clone() },
          uCore: { value: this.core.clone() },
          uIntensity: { value: 0 },
        },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        blending: THREE.AdditiveBlending,
        // Depth-tested but not depth-writing: the car still occludes the rings
        // behind it, while the rings never occlude each other — which is what
        // lets the whole column read as one continuous glow.
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        toneMapped: false,
      });

      const ring = new THREE.Mesh(this.geometry, material);
      ring.frustumCulled = false;
      ring.renderOrder = 10;
      // Density class: every 4th ring carries the subtlest tier, every other
      // one the middle tier, the remainder only show under a hard launch.
      ring.userData.tier = i % 4 === 0 ? 0 : i % 2 === 0 ? 1 : 2;
      // Spread the pool evenly down the road. `s` is arc distance ahead of the
      // car; the world position it maps to depends on how the road bends.
      ring.userData.s = this.origin + i * TUNNEL.spacing;
      ring.position.z = ring.userData.s;
      this.group.add(ring);
      this.rings.push(ring);
      this.materials.push(material);
    }

    this.opacity = 0;
    this._scratch = new THREE.Color();
  }

  /** Global fade, used to blend the tunnel in behind the boot animation. */
  /**
   * Drops a fraction of the rings for a quality tier.
   *
   * Rings are additive-blended transparent geometry, which is the most
   * expensive thing in the warp effect on a mobile GPU — every one of them
   * shades every pixel it covers. Fewer rings simply reads as a longer gap
   * between them at speed.
   *
   * @param {number} fraction 0..1 of the rings to keep
   */
  setDetail(fraction) {
    this._detail = Math.max(0.05, Math.min(1, fraction));
    const step = 1 / this._detail;
    this.rings.forEach((ring, i) => {
      ring.userData.culled = Math.floor(i % step) !== 0;
      // Culling only — see the note in streetscape.setDetail.
      ring.visible = !ring.userData.culled;
    });
  }

  setOpacity(value) {
    this.opacity = clamp(value, 0, 1);
    this.group.visible = this.opacity > 0.001;
  }

  /** Puts every ring back to its resting layout (used when replaying boot). */
  reset() {
    this.rings.forEach((ring, i) => {
      ring.userData.s = this.origin + i * TUNNEL.spacing;
      ring.position.set(0, 0, ring.userData.s);
      ring.rotation.y = 0;
      ring.material.uniforms.uIntensity.value = 0;
    });
  }

  /**
   * @param {number} dt seconds
   * @param {number} mph current speed
   * @param {number} surge 0..1 acceleration signal
   * @param {number} cameraZ the chase camera's position along the rig's +Z
   */
  /**
   * @param {number} dt seconds
   * @param {number} mph current speed
   * @param {number} power 0..1 surge power from the launch tiering
   * @param {number} cameraZ the chase camera's arc position along the road
   * @param {import('./road.js').RoadModel} road
   */
  update(dt, mph, power, cameraZ, road) {
    if (!this.group.visible) return;

    // Ground speed in metres/second, exaggerated a little: a tunnel that flows
    // at exactly road speed reads as slower than it is on a short banner, and
    // pushed harder still while the car is actually pulling.
    const flow = mph * 0.44704 * TUNNEL.speedScale * (1 + power * TUNNEL.surgeFlow);
    // Below a walking pace the tunnel should be all but gone; it is a motion
    // cue, not decoration.
    const speedGate = clamp(mph / 12, 0, 1);

    // Under a hard launch the column swells toward the lens, which reads as the
    // tunnel compressing around the car.
    const swell = 1 + power * 0.09;
    this.group.scale.set(swell, swell, 1);

    for (const ring of this.rings) {
      ring.userData.s -= flow * dt;
      // Recycle once a ring is safely behind the camera.
      if (ring.userData.s < this.origin) ring.userData.s += this.length;

      // Place and aim the ring on the centreline: rings stay perpendicular to
      // the road, so the column leans into a bend rather than shearing.
      const centre = road.place(ring.userData.s, 0, ring.position);
      ring.rotation.y = centre.heading;

      // Distances are measured from the camera, not from the rig origin, so
      // the fades line up with what is actually on screen.
      const ahead = ring.userData.s - cameraZ;
      const t = clamp(1 - ahead / this.length, 0, 1); // 0 at the far plane, 1 at the lens

      // Rings rise out of the far darkness and burn out in the last few metres
      // before they sweep past, so neither end of the column pops.
      const fadeIn = clamp((this.length - ahead) / (this.length * 0.4), 0, 1);
      const fadeOut = clamp(ahead / 9, 0, 1);

      // This ring's density class has to have arrived.
      const band = TUNNEL.tierBands[ring.userData.tier];
      const tier = clamp((power - band) / TUNNEL.tierFade, 0, 1);

      const uniforms = ring.material.uniforms;
      uniforms.uIntensity.value =
        fadeIn * fadeOut * speedGate * tier * this.opacity * (0.4 + power * 1.25 + t * 0.95);

      this._scratch.copy(this.colorFar).lerp(this.colorNear, t * t);
      // The hottest tier bleaches the near colour toward white.
      if (power > 0.6) this._scratch.lerp(this.core, (power - 0.6) * 1.6 * t);
      uniforms.uColor.value.copy(this._scratch);
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.materials.forEach((m) => m.dispose());
    this.rings.length = 0;
    this.materials.length = 0;
  }
}
