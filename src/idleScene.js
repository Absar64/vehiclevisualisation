/**
 * idleScene.js — the showroom the car sits in once it is parked.
 *
 * Driving mode can get away with a black void because everything is rushing
 * past. A stationary car cannot: with nothing around it there is no parallax,
 * so an orbiting camera reads as a turntable spinning a cut-out. This layer
 * gives the orbit something to move through — a wireframe plaza on a marked
 * deck, ringed by the same outline city the streetscape is built from, under a
 * faint graded dome so the frame never bottoms out to pure black.
 *
 * It fades in with the idle showcase and back out the moment the car rolls.
 */

import * as THREE from 'three';
import { SHOWROOM } from './config.js';
import { clamp } from './spring.js';
import {
  SegmentBuilder,
  createOutlineMaterial,
  makeTree,
  makeConifer,
  makeBuilding,
  makeLamp,
  makeBush,
} from './props.js';

/** A very dark graded dome: lifts the horizon off pure black without glowing. */
const DOME_VERTEX = /* glsl */ `
  varying float vHeight;
  void main() {
    vHeight = normalize(position).y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DOME_FRAGMENT = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform float uOpacity;
  varying float vHeight;

  void main() {
    // Concentrated just above the ground line, gone by the time it reaches the
    // top of the frame — the letterbox stays black where it should.
    float t = smoothstep(-0.05, 0.55, vHeight);
    vec3 colour = mix(uHorizon, uZenith, t);
    gl_FragColor = vec4(colour * uOpacity, uOpacity);
  }
`;

/** The marked deck the car stands on: concentric rings and radial ticks. */
function buildDeck() {
  const b = new SegmentBuilder();

  for (const radius of SHOWROOM.deckRings) b.ring(radius, 0.004, 96);

  // Radial ticks between the two outer rings, like a turntable's index marks.
  const inner = SHOWROOM.deckRings[SHOWROOM.deckRings.length - 2];
  const outer = SHOWROOM.deckRings[SHOWROOM.deckRings.length - 1];
  for (let i = 0; i < SHOWROOM.deckTicks; i++) {
    const angle = (i / SHOWROOM.deckTicks) * Math.PI * 2;
    const long = i % 4 === 0;
    const from = long ? inner : outer - (outer - inner) * 0.35;
    b.line(
      Math.cos(angle) * from,
      0.004,
      Math.sin(angle) * from,
      Math.cos(angle) * outer,
      0.004,
      Math.sin(angle) * outer
    );
  }
  return b.build();
}

export class IdleScene {
  /** @param {THREE.Object3D} parent the drive rig, aligned with the car */
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.visible = false;
    parent.add(this.group);

    this.material = createOutlineMaterial({
      color: SHOWROOM.color,
      near: SHOWROOM.fadeNear,
      far: SHOWROOM.fadeFar,
    });
    this.deckMaterial = createOutlineMaterial({
      color: SHOWROOM.deckColor,
      near: 0.5,
      far: SHOWROOM.fadeFar,
    });

    this.geometries = [];

    // Deck.
    const deck = buildDeck();
    this.geometries.push(deck);
    this.group.add(new THREE.LineSegments(deck, this.deckMaterial));

    // Surrounding city: two belts, greenery close in and blocks behind it.
    const near = [makeTree(2), makeConifer(3), makeBush(5), makeTree(6), makeConifer(1)];
    const far = [makeBuilding(1), makeBuilding(2), makeBuilding(4), makeBuilding(6)];
    const lamp = makeLamp();
    this.geometries.push(...near, ...far, lamp);

    this._populateBelt(near, SHOWROOM.greenBelt, 0.85);
    this._populateBelt(far, SHOWROOM.cityBelt, 1.0);

    // Four lamps on the deck's compass points, arms turned inward.
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const mesh = new THREE.LineSegments(lamp, this.material);
      mesh.position.set(
        Math.cos(angle) * SHOWROOM.lampRadius,
        0,
        Math.sin(angle) * SHOWROOM.lampRadius
      );
      mesh.rotation.y = -angle + Math.PI / 2;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }

    // Graded dome.
    const domeGeometry = new THREE.SphereGeometry(SHOWROOM.domeRadius, 32, 16);
    this.geometries.push(domeGeometry);
    this.domeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uHorizon: { value: new THREE.Color(SHOWROOM.domeHorizon) },
        uZenith: { value: new THREE.Color(SHOWROOM.domeZenith) },
        uOpacity: { value: 0 },
      },
      vertexShader: DOME_VERTEX,
      fragmentShader: DOME_FRAGMENT,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    const dome = new THREE.Mesh(domeGeometry, this.domeMaterial);
    dome.frustumCulled = false;
    dome.renderOrder = -1;
    this.group.add(dome);

    this.opacity = 0;
  }

  /** Scatters a set of prop geometries evenly around a ring. */
  _populateBelt(geometries, belt, scaleBase) {
    for (let i = 0; i < belt.count; i++) {
      const spread = (i / belt.count) * Math.PI * 2;
      const jitter = Math.sin(i * 12.9898) * 0.5;
      const angle = spread + jitter * belt.jitterAngle;
      const radius = belt.radius + Math.abs(Math.sin(i * 7.77)) * belt.radiusSpread;

      const mesh = new THREE.LineSegments(geometries[i % geometries.length], this.material);
      mesh.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      // Face the centre, so facades and canopies read from the car's position.
      mesh.rotation.y = -angle + Math.PI / 2;
      mesh.scale.setScalar(scaleBase * (0.8 + Math.abs(Math.sin(i * 3.31)) * 0.55));
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
  }

  setOpacity(value) {
    this.opacity = clamp(value, 0, 1);
    this.material.uniforms.uOpacity.value = this.opacity * SHOWROOM.opacity;
    this.deckMaterial.uniforms.uOpacity.value = this.opacity * SHOWROOM.deckOpacity;
    this.domeMaterial.uniforms.uOpacity.value = this.opacity * SHOWROOM.domeOpacity;
    this.group.visible = this.opacity > 0.002;
  }

  dispose() {
    this.group.removeFromParent();
    this.geometries.forEach((g) => g.dispose());
    this.material.dispose();
    this.deckMaterial.dispose();
    this.domeMaterial.dispose();
  }
}
