/**
 * props.js — the outline prop library.
 *
 * Trees, bushes, buildings, lamps and railings, all built as line segments from
 * hand-rolled point pairs. Shared by the streetscape that rushes past while
 * driving and by the showroom that surrounds the car while it is parked, so the
 * two read as the same world seen at two different speeds.
 *
 * Also home to the depth-faded line material both layers use: alpha is computed
 * from view-space depth in the shader rather than per object, so props rise out
 * of the far darkness and dissolve before they clip the lens for free.
 */

import * as THREE from 'three';

const VERTEX_SHADER = /* glsl */ `
  varying float vDepth;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mv.z;                 // metres in front of the camera
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uNear;
  uniform float uFar;
  varying float vDepth;

  void main() {
    // Rise out of the far darkness...
    float a = smoothstep(uFar, uFar * 0.42, vDepth);
    // ...and dissolve before sweeping through the lens.
    a *= smoothstep(uNear * 0.25, uNear, vDepth);
    a *= uOpacity;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

/**
 * @param {{color:number, near:number, far:number}} options
 * @returns {THREE.ShaderMaterial}
 */
export function createOutlineMaterial({ color, near, far }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 0 },
      uNear: { value: near },
      uFar: { value: far },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
}

/** Collects line segments as flat [x,y,z, x,y,z] pairs. */
export class SegmentBuilder {
  constructor() {
    this.points = [];
  }

  line(ax, ay, az, bx, by, bz) {
    this.points.push(ax, ay, az, bx, by, bz);
  }

  /** Closed polyline through a list of [x,y] pairs, at a fixed z. */
  loop(points, z = 0) {
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      this.line(a[0], a[1], z, b[0], b[1], z);
    }
  }

  /** Axis-aligned rectangle outline in the XY plane. */
  rect(x, y, w, h, z = 0) {
    this.loop(
      [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ],
      z
    );
  }

  /** Horizontal ring on the ground plane, at height y. */
  ring(radius, y, segments) {
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const b = ((i + 1) / segments) * Math.PI * 2;
      this.line(
        Math.cos(a) * radius,
        y,
        Math.sin(a) * radius,
        Math.cos(b) * radius,
        y,
        Math.sin(b) * radius
      );
    }
  }

  build() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.points, 3));
    return geometry;
  }
}

/** Blobby canopy outline — a circle with a little per-vertex noise. */
function canopy(builder, cx, cy, radius, segments, seed) {
  const points = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    // Deterministic wobble so no two trees are identical but none are ugly.
    const wobble = 1 + Math.sin(angle * 3 + seed) * 0.11 + Math.sin(angle * 5 + seed * 2) * 0.06;
    points.push([cx + Math.cos(angle) * radius * wobble, cy + Math.sin(angle) * radius * wobble]);
  }
  builder.loop(points);
}

/** A broadleaf tree: tapering trunk, two limbs, blobby crown. */
export function makeTree(seed) {
  const b = new SegmentBuilder();
  const height = 3.4 + (seed % 5) * 0.42;
  const crownR = 1.5 + (seed % 3) * 0.22;

  b.line(-0.11, 0, 0, -0.08, height * 0.62, 0);
  b.line(0.11, 0, 0, 0.08, height * 0.62, 0);
  b.line(-0.08, height * 0.62, 0, 0.08, height * 0.62, 0);
  // Limbs into the crown.
  b.line(0, height * 0.55, 0, -0.55, height * 0.78, 0);
  b.line(0, height * 0.55, 0, 0.5, height * 0.8, 0);

  canopy(b, 0, height * 0.62 + crownR * 0.72, crownR, 16, seed);
  return b.build();
}

/** A narrow conifer: stacked chevrons. */
export function makeConifer(seed) {
  const b = new SegmentBuilder();
  const height = 4.6 + (seed % 4) * 0.5;
  b.line(0, 0, 0, 0, height * 0.22, 0);
  const tiers = 4;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const y = height * (0.2 + t * 0.66);
    const halfWidth = (1.25 - t * 0.85) * (1 + (seed % 3) * 0.06);
    const tierHeight = height * 0.26;
    b.line(-halfWidth, y, 0, 0, y + tierHeight, 0);
    b.line(halfWidth, y, 0, 0, y + tierHeight, 0);
    b.line(-halfWidth, y, 0, halfWidth, y, 0);
  }
  return b.build();
}

/** Low hedge / bush cluster. */
export function makeBush(seed) {
  const b = new SegmentBuilder();
  canopy(b, -0.45, 0.42, 0.52, 10, seed);
  canopy(b, 0.42, 0.55, 0.66, 10, seed + 1.7);
  canopy(b, 0.02, 0.36, 0.45, 9, seed + 3.1);
  return b.build();
}

/** A block of building: box wireframe with a lit window grid. */
export function makeBuilding(seed) {
  const b = new SegmentBuilder();
  const width = 5.5 + (seed % 4) * 1.6;
  const height = 9 + (seed % 6) * 2.4;
  const depth = 5 + (seed % 3) * 1.4;

  // Front and back faces, joined at the corners: a plain box outline.
  b.rect(-width / 2, 0, width, height, depth / 2);
  b.rect(-width / 2, 0, width, height, -depth / 2);
  for (const sx of [-width / 2, width / 2]) {
    for (const sy of [0, height]) {
      b.line(sx, sy, depth / 2, sx, sy, -depth / 2);
    }
  }

  // Window grid on the front face only — enough to read as a facade without
  // turning into visual noise at speed.
  const cols = Math.max(2, Math.floor(width / 1.9));
  const rows = Math.max(3, Math.floor(height / 2.4));
  const cellW = width / cols;
  const cellH = height / rows;
  for (let r = 1; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Skip some so the facade looks inhabited rather than gridded.
      if ((r * 7 + c * 3 + seed) % 5 < 2) continue;
      const x = -width / 2 + c * cellW + cellW * 0.26;
      const y = r * cellH - cellH * 0.62;
      b.rect(x, y, cellW * 0.46, cellH * 0.42, depth / 2);
    }
  }
  return b.build();
}

/** Street lamp: pole, curved arm, lamp head. */
export function makeLamp() {
  const b = new SegmentBuilder();
  const height = 6.2;
  b.line(0, 0, 0, 0, height, 0);
  // Arm, approximated as a short polyline arc reaching over the road.
  const reach = 1.7;
  const steps = 5;
  let px = 0;
  let py = height;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const nx = -reach * t;
    const ny = height + Math.sin(t * Math.PI * 0.5) * 0.55;
    b.line(px, py, 0, nx, ny, 0);
    px = nx;
    py = ny;
  }
  b.rect(px - 0.34, py - 0.26, 0.68, 0.2);
  return b.build();
}

/**
 * UK traffic signal: pole, backing board, three stacked lamps.
 *
 * Built in the XY plane facing +Z like every other prop, so the placement code
 * can orient it with a single rotation.y.
 */
export function makeTrafficLight() {
  const b = new SegmentBuilder();
  const poleHeight = 2.6;
  const headHeight = 1.15;
  const headWidth = 0.46;

  // Pole and a token base plate.
  b.line(-0.06, 0, 0, -0.06, poleHeight, 0);
  b.line(0.06, 0, 0, 0.06, poleHeight, 0);
  b.line(-0.16, 0, 0, 0.16, 0, 0);

  // Backing board and the head inside it.
  b.rect(-headWidth / 2 - 0.09, poleHeight - 0.09, headWidth + 0.18, headHeight + 0.18);
  b.rect(-headWidth / 2, poleHeight, headWidth, headHeight);

  // Three lamps: red at the top, amber, green — UK order, top to bottom.
  const lampR = 0.13;
  for (let i = 0; i < 3; i++) {
    const cy = poleHeight + headHeight - (i + 0.5) * (headHeight / 3);
    const points = [];
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      points.push([Math.cos(a) * lampR, cy + Math.sin(a) * lampR]);
    }
    b.loop(points);
  }
  return b.build();
}

/**
 * UK fixed speed camera, Gatso-style: pole, boxy housing, lens and flash unit.
 * The housing faces back down the road, which is why it is drawn offset on the
 * -Z side of the pole.
 */
export function makeSpeedCamera() {
  const b = new SegmentBuilder();
  const poleHeight = 3.1;
  const boxW = 0.78;
  const boxH = 0.54;
  const boxD = 0.5;

  b.line(-0.07, 0, 0, -0.07, poleHeight, 0);
  b.line(0.07, 0, 0, 0.07, poleHeight, 0);
  b.line(-0.18, 0, 0, 0.18, 0, 0);

  // Housing, as a box: front face, back face, and the four connecting edges.
  const y0 = poleHeight;
  b.rect(-boxW / 2, y0, boxW, boxH, boxD / 2);
  b.rect(-boxW / 2, y0, boxW, boxH, -boxD / 2);
  for (const sx of [-boxW / 2, boxW / 2]) {
    for (const sy of [y0, y0 + boxH]) b.line(sx, sy, boxD / 2, sx, sy, -boxD / 2);
  }

  // Lens on the front face.
  const lensR = 0.15;
  const lensY = y0 + boxH * 0.5;
  const lens = [];
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    lens.push([Math.cos(a) * lensR, lensY + Math.sin(a) * lensR]);
  }
  b.loop(lens, boxD / 2);

  // Flash unit slung underneath.
  b.rect(-0.26, y0 - 0.3, 0.52, 0.22, boxD / 2);
  b.line(0, y0, 0, 0, y0 - 0.08, 0);

  return b.build();
}

/** Roadside railing: posts and a top rail. */
export function makeRailing() {
  const b = new SegmentBuilder();
  const span = 7.5;
  const height = 1.05;
  b.line(-span / 2, height, 0, span / 2, height, 0);
  b.line(-span / 2, height * 0.55, 0, span / 2, height * 0.55, 0);
  for (let i = 0; i <= 6; i++) {
    const x = -span / 2 + (span / 6) * i;
    b.line(x, 0, 0, x, height, 0);
  }
  return b.build();
}
