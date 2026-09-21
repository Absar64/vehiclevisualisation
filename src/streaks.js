/**
 * streaks.js — the speed streaks that ride on top of the warp rings.
 *
 * Thin elongated slivers of light rushing past the car: the element that
 * separates a level-2 pull from a level-1 one, and that stretches into full
 * light-speed smears by level 4.
 *
 * The whole layer is one draw call and costs nothing per frame. Every streak's
 * rest position is baked into vertex attributes and the motion happens in the
 * vertex shader — a single `uTravel` uniform slides the column and wraps it
 * with a modulo, so there is no per-streak CPU work, no recycling pass and no
 * attribute uploads while it runs.
 *
 * Each streak also carries an `aTier` threshold. The fragment shader fades it
 * in across its own band of surge power, so the field densifies as the launch
 * escalates: a few high slivers at first, the low ground-level blur only once
 * the pull is genuinely hard.
 *
 * The road's centreline table is uploaded as a texture and sampled here in the
 * vertex shader, using the same two-tap interpolation the CPU side uses. That
 * matters: streaks are the one layer the CPU never touches per frame, and if
 * they kept their own idea of where the road went they would shear away from
 * the rings and verges the moment a bend arrived.
 */

import * as THREE from 'three';
import { STREAKS, DRIVE } from './config.js';
import { clamp } from './spring.js';

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aBase;        // rest position: x = lateral, z = arc distance
  attribute vec3 aWidthDir;    // in-plane axis the ribbon is widened along
  attribute vec2 aParam;       // x: 0..1 along the streak, y: -1/+1 side
  attribute float aTier;       // surge power at which this streak appears
  attribute float aScale;      // per-streak length multiplier

  uniform float uTravel;
  uniform float uSpan;
  uniform float uOriginZ;
  uniform float uLength;
  uniform float uWidth;

  uniform sampler2D uRoad;     // centreline: rgb = (x, z, heading)
  uniform float uRoadBehind;
  uniform float uRoadSpan;
  uniform float uRoadSamples;

  varying vec2 vParam;
  varying float vTier;
  varying float vDepth;

  /**
   * Centreline at arc distance s. Two nearest texels, interpolated by hand:
   * linear filtering of float textures needs an extension that is not
   * universally available, so this stays portable.
   */
  vec3 roadAt(float s) {
    float position = clamp((s + uRoadBehind) / uRoadSpan, 0.0, 1.0) * (uRoadSamples - 1.0);
    float i = floor(position);
    float f = position - i;
    vec2 uvA = vec2((i + 0.5) / uRoadSamples, 0.5);
    vec2 uvB = vec2((min(i + 1.0, uRoadSamples - 1.0) + 0.5) / uRoadSamples, 0.5);
    return mix(texture2D(uRoad, uvA).xyz, texture2D(uRoad, uvB).xyz, f);
  }

  void main() {
    // Wrap the column in the shader: one uniform moves every streak at once.
    float s = mod(aBase.z - uTravel, uSpan) + uOriginZ;

    float len = uLength * aScale;
    // Sample where this vertex actually sits, not where the streak starts, so
    // a long smear bends along the road rather than cutting the corner.
    float sHere = s + aParam.x * len;

    vec3 road = roadAt(sHere);
    float c = cos(road.z);
    float sn = sin(road.z);
    vec2 normal = vec2(c, -sn);   // right-hand normal to a (sin, cos) tangent

    float lateral = aBase.x + aWidthDir.x * aParam.y * uWidth;
    vec2 planar = road.xy + normal * lateral;
    float height = aBase.y + aWidthDir.y * aParam.y * uWidth;

    vec4 mv = modelViewMatrix * vec4(planar.x, height, planar.y, 1.0);
    vDepth = -mv.z;
    vParam = aParam;
    vTier = aTier;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uPower;
  uniform float uOpacity;
  uniform float uFar;

  varying vec2 vParam;
  varying float vTier;
  varying float vDepth;

  void main() {
    // Soft core across the ribbon's width.
    float across = 1.0 - abs(vParam.y);
    float core = pow(across, 2.2);

    // Taper both ends so a streak reads as a smear, not a stick.
    float along = sin(clamp(vParam.x, 0.0, 1.0) * 3.14159);

    // This streak's own tier has to have arrived.
    float tier = smoothstep(vTier, vTier + 0.16, uPower);

    // Distance fade, and a near fade so nothing flicks through the lens.
    float depth = smoothstep(uFar, uFar * 0.35, vDepth) * smoothstep(1.0, 6.0, vDepth);

    float energy = core * along * tier * depth * uOpacity;
    if (energy <= 0.002) discard;

    // Cores go white-hot as the pull gets harder.
    vec3 colour = mix(uColor, uHot, clamp(uPower * core * 1.3, 0.0, 1.0));
    gl_FragColor = vec4(colour * energy, energy);
  }
`;

/**
 * Builds the streak field: a ring of slivers around the road axis plus a
 * low band that hugs the tarmac for the upper tiers.
 */
function createStreakGeometry() {
  const count = STREAKS.count;
  const positions = new Float32Array(count * 4 * 3);
  const bases = new Float32Array(count * 4 * 3);
  const widthDirs = new Float32Array(count * 4 * 3);
  const params = new Float32Array(count * 4 * 2);
  const tiers = new Float32Array(count * 4);
  const scales = new Float32Array(count * 4);
  const indices = [];

  // Deterministic pseudo-random, so the field is identical every run.
  const rand = (n) => Math.abs(Math.sin(n * 12.9898) * 43758.5453) % 1;

  for (let i = 0; i < count; i++) {
    const r1 = rand(i + 1);
    const r2 = rand(i + 7.3);
    const r3 = rand(i + 19.1);
    const r4 = rand(i + 31.7);

    // A third of the field hugs the ground: that is the tarmac blur, and it is
    // held back for the harder tiers.
    const groundLevel = r4 < 0.34;

    let x;
    let y;
    let widthDir;
    if (groundLevel) {
      x = (r1 < 0.5 ? -1 : 1) * (STREAKS.groundHalf * (0.35 + r2 * 0.65));
      y = 0.02 + r3 * 0.25;
      // Flat slivers on the road read best widened across the carriageway.
      widthDir = new THREE.Vector3(0, 1, 0);
    } else {
      const angle = r1 * Math.PI * 2;
      const radius = STREAKS.radiusMin + r2 * (STREAKS.radiusMax - STREAKS.radiusMin);
      x = Math.cos(angle) * radius;
      y = DRIVE.camera.height + Math.sin(angle) * radius * 0.55;
      // Widen tangentially, so a streak keeps its face toward a camera sitting
      // near the axis of the column.
      widthDir = new THREE.Vector3(-Math.sin(angle), Math.cos(angle) * 0.55, 0).normalize();
    }

    // Ground streaks belong to tier 3; the rest come in from tier 2.
    const tier = groundLevel ? STREAKS.groundTier : STREAKS.airTier + r3 * 0.18;
    const z = r3 * STREAKS.span;
    const scale = 0.55 + r2 * 0.9;

    for (let v = 0; v < 4; v++) {
      const o3 = (i * 4 + v) * 3;
      const o2 = (i * 4 + v) * 2;

      // position is unused by the shader but keeps three's bounding logic and
      // any future raycast sane.
      positions[o3] = x;
      positions[o3 + 1] = y;
      positions[o3 + 2] = z;

      bases[o3] = x;
      bases[o3 + 1] = y;
      bases[o3 + 2] = z;

      widthDirs[o3] = widthDir.x;
      widthDirs[o3 + 1] = widthDir.y;
      widthDirs[o3 + 2] = widthDir.z;

      // Quad corners: (along, side).
      params[o2] = v < 2 ? 0 : 1;
      params[o2 + 1] = v % 2 === 0 ? -1 : 1;

      tiers[i * 4 + v] = tier;
      scales[i * 4 + v] = scale;
    }

    const base = i * 4;
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aBase', new THREE.BufferAttribute(bases, 3));
  geometry.setAttribute('aWidthDir', new THREE.BufferAttribute(widthDirs, 3));
  geometry.setAttribute('aParam', new THREE.BufferAttribute(params, 2));
  geometry.setAttribute('aTier', new THREE.BufferAttribute(tiers, 1));
  geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
  geometry.setIndex(indices);
  return geometry;
}

export class SpeedStreaks {
  /**
   * @param {THREE.Object3D} parent the drive rig — its +Z is the road ahead
   * @param {import('./road.js').RoadModel} road
   */
  constructor(parent, road) {
    this.geometry = createStreakGeometry();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTravel: { value: 0 },
        uSpan: { value: STREAKS.span },
        uOriginZ: { value: -(DRIVE.camera.distance + 6) },
        uLength: { value: STREAKS.lengthBase },
        uWidth: { value: STREAKS.width },
        uColor: { value: new THREE.Color(STREAKS.color) },
        uHot: { value: new THREE.Color(STREAKS.hotColor) },
        uPower: { value: 0 },
        uOpacity: { value: 0 },
        uFar: { value: STREAKS.fadeFar },
        uRoad: { value: road.texture },
        // Snapped values from the model, not the raw config: the shader has to
        // index the table exactly as the CPU side does.
        uRoadBehind: { value: road.behind },
        uRoadSpan: { value: road.span },
        uRoadSamples: { value: road.samples },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
    this.mesh.visible = false;
    parent.add(this.mesh);

    this.travel = 0;
  }

  reset() {
    this.travel = 0;
    this.material.uniforms.uTravel.value = 0;
  }

  /**
   * @param {number} dt seconds
   * @param {number} mph current speed
   * @param {number} power 0..1 surge power
   * @param {number} opacity master fade
   */
  update(dt, mph, power, opacity) {
    const visible = opacity > 0.002 && power > 0.02;
    this.mesh.visible = visible;
    if (!visible) return;

    const uniforms = this.material.uniforms;

    // Streaks outrun the rings — that difference in parallax is most of what
    // sells the speed.
    const flow = mph * 0.44704 * STREAKS.speedScale * (1 + power * 1.2);
    this.travel = (this.travel + flow * dt) % STREAKS.span;
    uniforms.uTravel.value = this.travel;

    // They also stretch as the pull hardens, from short sparks to long smears.
    uniforms.uLength.value = STREAKS.lengthBase + power * STREAKS.lengthPower;
    uniforms.uWidth.value = STREAKS.width * (1 + power * 0.5);
    uniforms.uPower.value = clamp(power, 0, 1);
    uniforms.uOpacity.value = opacity;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
