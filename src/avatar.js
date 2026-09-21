/**
 * avatar.js — a Mii head on a procedural body.
 *
 * The heads are authored elsewhere and imported from `Mii/`; this builds the
 * rest, matching the proportions of the official artwork: a slim torso that
 * tapers toward the shoulders, long thin limbs, detached ball hands and small
 * rounded shoes.
 *
 * Limbs are a *single* segment each — no elbows, no knees. That is not a
 * simplification for cheapness, it is what the style is: a Mii's arm is one
 * smooth taper from shoulder to floating hand, and putting a joint half way
 * along it immediately reads as a different kind of character.
 *
 * Two details make an imported head sit correctly on a generated body:
 *
 *  - **It is measured, not assumed.** The export's units are its own (this one
 *    is about 69 units tall), so the head is scaled to a target height from its
 *    own bounding box and shifted so its neck lands at the group's origin.
 *    Drop in a head authored at any scale and it still fits.
 *  - **Its colours drive the body.** The skin tone comes from the head's own
 *    faceline material, so hands and arms match a face this code has never
 *    seen. The costume is picked from a small palette by name, so a given Mii
 *    always dresses the same way without anyone choosing it.
 *
 * The skeleton — hips → torso → head, torso → arms, hips → legs — is unchanged
 * from before, so the idle activities in crew.js drive it as they always did.
 */

import * as THREE from 'three';
import { instantiateHead, disposeHeadInstance } from './miiLibrary.js';

/**
 * Height the imported head is normalised to, and the body built around.
 * With a 0.44 torso and 0.58 legs the head lands at about a third of total
 * height, which is the ratio in the reference art — oversized, but nothing
 * like the squat build a bigger head gives.
 */
const HEAD_HEIGHT = 0.5;
const TORSO_HEIGHT = 0.44;
const LEG_LENGTH = 0.58;

/** Outfits, chosen per character by name so each Mii is consistently dressed. */
const COSTUMES = [
  { top: 0x3b4658, bottom: 0x2b2f38, accent: 0x5d6b80 },
  { top: 0x2f6f9e, bottom: 0x2b3038, accent: 0x63aef0 },
  { top: 0x4c535f, bottom: 0x32363f, accent: 0x646d7d },
  { top: 0x6d4550, bottom: 0x33262b, accent: 0xa4707c },
  { top: 0x3f6250, bottom: 0x2a3330, accent: 0x6f9c85 },
  { top: 0x5a5340, bottom: 0x33302a, accent: 0x8d8360 },
];

// Shared primitives: smooth enough to read as sculpted, and reused by every
// character so geometry never grows with the cast.
const SPHERE = new THREE.SphereGeometry(0.5, 24, 18);
const CAPSULE = new THREE.CapsuleGeometry(0.5, 1, 6, 16);
/** A frustum, for the torso's taper: wider at the hem than at the shoulders. */
const TAPER = new THREE.CylinderGeometry(0.42, 0.5, 1, 20, 1, false);

/** Stable per-name pick, so a Mii's outfit never changes between runs. */
function costumeFor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return COSTUMES[hash % COSTUMES.length];
}

export class Avatar {
  /**
   * @param {{name:string, url:string}} mii
   * @param {{scene:THREE.Object3D, skin:THREE.Color, hair:THREE.Color}} loaded
   *   the cached head from miiLibrary
   */
  constructor(mii, loaded) {
    this.name = mii.name;
    this.url = mii.url;
    this.group = new THREE.Group();
    this.materials = [];

    const costume = costumeFor(mii.name);
    this.skin = this._material(loaded.skin.clone(), 0.9, 0);
    this.topMat = this._material(new THREE.Color(costume.top), 0.62, 0);
    this.bottomMat = this._material(new THREE.Color(costume.bottom), 0.66, 0);
    this.accentMat = this._material(new THREE.Color(costume.accent), 0.5, 0.08);

    this.headMesh = instantiateHead(loaded.scene);
    this._build();
  }

  _material(color, roughness, metalness) {
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness,
      transparent: true,
      opacity: 1,
    });
    this.materials.push(material);
    return material;
  }

  _part(geometry, material, parent, scale, position = [0, 0, 0]) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.set(scale[0], scale[1], scale[2]);
    mesh.position.set(position[0], position[1], position[2]);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }

  _build() {
    this.legLength = LEG_LENGTH;

    this.hips = new THREE.Group();
    this.hips.position.y = LEG_LENGTH;
    this.group.add(this.hips);

    this.torso = new THREE.Group();
    this.hips.add(this.torso);

    // A tapered shell, narrower at the shoulders than at the hem, capped with a
    // rounded shoulder line. Slimmer than a capsule and much closer to the art.
    this._part(TAPER, this.topMat, this.torso, [0.3, TORSO_HEIGHT, 0.23], [0, TORSO_HEIGHT * 0.5, 0]);
    this._part(SPHERE, this.topMat, this.torso, [0.3, 0.17, 0.23], [0, TORSO_HEIGHT * 0.93, 0]);
    this._part(SPHERE, this.topMat, this.torso, [0.35, 0.16, 0.25], [0, TORSO_HEIGHT * 0.08, 0]);

    // Head sits straight on the shoulders; a Mii has no visible neck.
    this.head = new THREE.Group();
    this.head.position.y = TORSO_HEIGHT * 0.96;
    this.torso.add(this.head);
    this._fitHead();

    this.arms = { left: this._buildArm(1), right: this._buildArm(-1) };
    this.legs = { left: this._buildLeg(1), right: this._buildLeg(-1) };

    this.restPose();
  }

  /**
   * Scales the imported head to the body and seats its neck at the origin.
   * Measured from the mesh rather than assumed, so any export scale works.
   */
  _fitHead() {
    const box = new THREE.Box3().setFromObject(this.headMesh);
    const size = box.getSize(new THREE.Vector3());
    const scale = HEAD_HEIGHT / Math.max(size.y, 1e-6);

    const holder = new THREE.Group();
    holder.scale.setScalar(scale);
    // Mii hair usually makes the raw bounding box asymmetric, so the centre is
    // taken from the box rather than assumed to be the origin.
    holder.position.set(
      -((box.min.x + box.max.x) / 2) * scale,
      -box.min.y * scale,
      -((box.min.z + box.max.z) / 2) * scale * 0.35
    );
    holder.add(this.headMesh);
    this.head.add(holder);
    this.headHolder = holder;
  }

  /**
   * Two segments, shoulder to floating hand, with a hinge between them.
   *
   * The style calls for a limb that reads as one smooth taper, and for a long
   * time this was literally one capsule. It could not do the job: a rigid
   * 0.445 m arm reaching a mouth 0.35 m away has to overshoot, which is why
   * the cigar draw ended up at the forehead. Bending is the only way to put a
   * hand somewhere *nearer* than the arm is long.
   *
   * The look survives because the two capsules are the same radius and their
   * rounded caps meet exactly at the hinge: straight, they are one unbroken
   * taper with no visible seam, and bent, the overlapping caps act as the ball
   * of the elbow. Nothing about the resting silhouette changes.
   */
  _buildArm(side) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.145, TORSO_HEIGHT * 0.84, 0);
    this.torso.add(shoulder);

    // Split evenly, so the total is the arm length it always was.
    const upper = 0.2;
    const fore = 0.2;
    const length = upper + fore;

    this._part(CAPSULE, this.topMat, shoulder, [0.058, upper * 0.62, 0.058], [0, -upper * 0.5, 0]);

    const elbow = new THREE.Group();
    elbow.position.y = -upper;
    shoulder.add(elbow);
    this._part(CAPSULE, this.topMat, elbow, [0.058, fore * 0.62, 0.058], [0, -fore * 0.5, 0]);

    const hand = new THREE.Group();
    hand.position.y = -fore - 0.045;
    elbow.add(hand);
    this._part(SPHERE, this.skin, hand, [0.085, 0.085, 0.085]);

    return { shoulder, elbow, hand, length, upper, fore };
  }

  /** One segment, hip to shoe. No knee. */
  _buildLeg(side) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.072, 0, 0);
    this.hips.add(hip);

    this._part(CAPSULE, this.bottomMat, hip, [0.068, LEG_LENGTH * 0.54, 0.068], [0, -LEG_LENGTH * 0.5, 0]);
    this._part(SPHERE, this.accentMat, hip, [0.105, 0.075, 0.15], [0, -LEG_LENGTH - 0.005, 0.022]);

    return { hip };
  }

  restPose() {
    this.setPose({
      hips: [0, 0, 0],
      torso: [0, 0, 0],
      head: [0, 0, 0],
      armL: [0.02, 0, 0.13],
      armR: [0.02, 0, -0.13],
      elbowL: [0, 0, 0],
      elbowR: [0, 0, 0],
      legL: [0, 0, 0.015],
      legR: [0, 0, -0.015],
      lift: 0,
    });
  }

  /** Missing joints keep what they had, so an animation can drive one limb. */
  setPose(pose) {
    const set = (node, angles) => {
      if (angles) node.rotation.set(angles[0], angles[1], angles[2]);
    };
    set(this.hips, pose.hips);
    set(this.torso, pose.torso);
    set(this.head, pose.head);
    set(this.arms.left.shoulder, pose.armL);
    set(this.arms.right.shoulder, pose.armR);
    set(this.arms.left.elbow, pose.elbowL);
    set(this.arms.right.elbow, pose.elbowR);
    set(this.legs.left.hip, pose.legL);
    set(this.legs.right.hip, pose.legR);
    if (pose.lift !== undefined) this.hips.position.y = this.legLength + pose.lift;
  }

  /** Fades body and head together, including the head's imported materials. */
  setOpacity(value) {
    const v = Math.min(1, Math.max(0, value));
    this.group.visible = v > 0.01;
    for (const material of this.materials) material.opacity = v;
    this.headMesh.traverse((node) => {
      if (!node.isMesh) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) material.opacity = v;
    });
  }

  dispose() {
    this.group.removeFromParent();
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    disposeHeadInstance(this.headMesh);
  }
}

/** Shared primitives outlive every avatar; disposed once at teardown. */
export function disposeAvatarGeometry() {
  SPHERE.dispose();
  CAPSULE.dispose();
  TAPER.dispose();
}
