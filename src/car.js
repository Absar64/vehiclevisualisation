/**
 * car.js — asset loading, material grading and the wheel interface.
 *
 * The GLB is a rigged, FBX-derived export: the road wheels are skeleton joints
 * whose local +X is the axle and whose local +Z is the steering axis. That
 * makes both spin and steer a single quaternion per wheel, composed here and
 * driven from the physics in drive.js.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { ASSET, RENDER } from './config.js';

const AXLE_AXIS = new THREE.Vector3(1, 0, 0);
const STEER_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * Re-grades the source materials into something that survives studio lighting.
 * The export ships flat PBR factors; dark body paint in particular needs a
 * clearcoat lobe or it reads as matte plastic.
 */
function gradeMaterials(root, envMap) {
  // Materials are shared across dozens of primitives on this export, so the
  // grade is resolved once per source material and cached: `replacements` maps
  // an original material uuid to the material that should stand in for it,
  // which every mesh referencing it then picks up.
  const graded = new Set();
  const replacements = new Map();

  /** Clearcoated body paint — the single most important surface here. */
  const makePaint = () =>
    new THREE.MeshPhysicalMaterial({
      name: 'paint.graded',
      color: 0x0042eb,
      metalness: 0.58,
      roughness: 0.15,
      clearcoat: 1.0,
      clearcoatRoughness: 0.03,
      envMap,
      envMapIntensity: RENDER.envIntensity * 1.45,
    });

  root.traverse((node) => {
    if (!node.isMesh) return;

    node.castShadow = true;
    node.receiveShadow = true;
    node.frustumCulled = false; // skinned bounds are unreliable on this rig

    const materials = Array.isArray(node.material) ? node.material : [node.material];

    materials.forEach((mat, index) => {
      if (!mat) return;

      // Already-resolved replacement: just swap it in.
      if (replacements.has(mat.uuid)) {
        const swap = replacements.get(mat.uuid);
        if (Array.isArray(node.material)) node.material[index] = swap;
        else node.material = swap;
        return;
      }

      const name = (mat.name || '').toLowerCase();

      // Body shells (the paint layer plus its spec-map twin) become car paint.
      if (name === 'paint' || name.includes('smallspecmap_primary')) {
        const paint = makePaint();
        replacements.set(mat.uuid, paint);
        if (Array.isArray(node.material)) node.material[index] = paint;
        else node.material = paint;
        return;
      }

      if (graded.has(mat.uuid)) return;
      graded.add(mat.uuid);

      mat.envMap = envMap;
      mat.envMapIntensity = RENDER.envIntensity;

      // Glass: dark, tight specular, never fully opaque.
      if (name.startsWith('glass')) {
        mat.transparent = true;
        mat.opacity = 0.34;
        mat.color?.setHex(0x05070b);
        mat.roughness = 0.04;
        mat.metalness = 0.0;
        mat.depthWrite = false;
        mat.envMapIntensity = RENDER.envIntensity * 1.6;
      // Brightwork: chrome trim, kidney surround, silver detailing.
      } else if (name.includes('chrm') || name.includes('silver') || name.includes('bmlogo')) {
        mat.metalness = 1.0;
        mat.roughness = 0.085;
        mat.envMapIntensity = RENDER.envIntensity * 1.5;
      // Tyres and the various blacks: keep them genuinely matte so the paint
      // and the brightwork carry all of the specular interest.
      } else if (name.startsWith('t_whs') || name.startsWith('black') || name.includes('carbon')) {
        mat.metalness = 0.0;
        mat.roughness = Math.max(mat.roughness ?? 1.0, 0.78);
        mat.envMapIntensity = RENDER.envIntensity * 0.45;
      // Lamp lenses.
      } else if (name.startsWith('t_light')) {
        mat.roughness = 0.12;
        mat.metalness = 0.25;
        mat.envMapIntensity = RENDER.envIntensity * 1.4;
      }

      mat.needsUpdate = true;
    });
  });
}

/**
 * Wraps one wheel joint.
 *
 * Beyond spin and steer, each wheel re-plants itself on the ground plane every
 * frame. The body shell above it is free to pitch, roll and heave on its
 * springs; without this the wheels would ride that rotation and swing through
 * the floor, which is what makes a dipping car look like it is hovering. The
 * correction is measured in world space and pushed back into the joint's
 * parent space, so it stays correct under any rig scale or orientation.
 */
class Wheel {
  constructor(bone, steerable) {
    this.bone = bone;
    this.steerable = steerable;
    this.bindQuaternion = bone.quaternion.clone();
    this.bindPosition = bone.position.clone();
    this._spin = new THREE.Quaternion();
    this._steer = new THREE.Quaternion();
    this._world = new THREE.Vector3();
    this._local = new THREE.Vector3();
    this._parentInverse = new THREE.Matrix4();
  }

  /**
   * @param {number} spin radians about the axle
   * @param {number} steer radians about the steering axis
   * @param {number} bodyPitch body pitch to cancel, so the tyre stays upright
   */
  orient(spin, steer, bodyPitch) {
    this.bone.quaternion.copy(this.bindQuaternion);
    if (this.steerable && steer !== 0) {
      this._steer.setFromAxisAngle(STEER_AXIS, steer);
      this.bone.quaternion.multiply(this._steer);
    }
    // Cancelling the body's pitch keeps the wheel vertical while the shell
    // dips around it — real suspension travel, not a tilting go-kart.
    this._spin.setFromAxisAngle(AXLE_AXIS, spin + bodyPitch);
    this.bone.quaternion.multiply(this._spin);
    this.bone.position.copy(this.bindPosition);
  }

  /**
   * Slides the joint along world-up until its axle sits exactly `radius` above
   * y = 0. Requires the parent chain's world matrices to be current.
   * @param {number} radius rolling radius in world units
   */
  plant(radius) {
    this.bone.updateWorldMatrix(true, false);
    this.bone.getWorldPosition(this._world);

    const correction = radius - this._world.y;
    // Ignore absurd corrections; a broken measurement should never launch the
    // wheel across the scene.
    if (!Number.isFinite(correction) || Math.abs(correction) > 0.5) return;

    // Convert the world-space vertical offset into parent-local space by
    // differencing two transformed points, which respects the chain's rotation
    // and scale (unlike normalising a transformed direction).
    this._parentInverse.copy(this.bone.parent.matrixWorld).invert();
    this._local.copy(this._world).applyMatrix4(this._parentInverse);
    this._world.y += correction;
    this._world.applyMatrix4(this._parentInverse).sub(this._local);
    this.bone.position.add(this._world);
  }

  reset() {
    this.bone.quaternion.copy(this.bindQuaternion);
    this.bone.position.copy(this.bindPosition);
  }
}

/**
 * Loads bmw.glb, normalises scale/orientation and returns a rig object whose
 * `group` can be driven freely by the animation layer.
 *
 * @param {THREE.Texture} envMap
 * @param {(progress:number)=>void} onProgress 0…1
 */
export async function loadCar(envMap, onProgress) {
  const loader = new GLTFLoader();

  // The model is meshopt-compressed: 46 MB of raw glTF down to 5.8 MB, which
  // is the difference between loading and not on a car head unit — the
  // uncompressed file died mid-download at 32 MB there. Meshopt rather than
  // Draco because it decodes several times faster, and the devices that need
  // the smaller download are the same ones that cannot afford a slow decode.
  loader.setMeshoptDecoder(MeshoptDecoder);

  const gltf = await loader.loadAsync(ASSET.url, (event) => {
    if (onProgress && event.lengthComputable) onProgress(event.loaded / event.total);
  });

  const model = gltf.scene;
  model.rotation.y = ASSET.modelForwardYaw;
  model.updateMatrixWorld(true);

  // Normalise to a known real-world length so camera framing is deterministic
  // regardless of the units the DCC tool exported in.
  const rawBox = new THREE.Box3().setFromObject(model);
  const rawSize = rawBox.getSize(new THREE.Vector3());
  const scale = ASSET.targetLength / Math.max(rawSize.x, rawSize.y, rawSize.z);
  model.scale.setScalar(scale);
  model.updateMatrixWorld(true);

  // Re-centre laterally/longitudinally and drop the tyres onto y = 0.
  const box = new THREE.Box3().setFromObject(model);
  const centre = box.getCenter(new THREE.Vector3());
  model.position.x -= centre.x;
  model.position.z -= centre.z;
  model.position.y -= box.min.y;
  model.updateMatrixWorld(true);

  gradeMaterials(model, envMap);

  // ── Wheels ──────────────────────────────────────────────────────────────
  const bones = {};
  model.traverse((node) => {
    for (const [key, boneName] of Object.entries(ASSET.wheelBones)) {
      if (node.name === boneName) bones[key] = node;
    }
  });

  const wheels = [];
  for (const [key, bone] of Object.entries(bones)) {
    wheels.push(new Wheel(bone, key === 'frontLeft' || key === 'frontRight'));
  }

  // Rolling radius = height of the axle above the ground plane. Derived from
  // the rig rather than hard-coded, so wheel spin stays synced to ground speed
  // even if the normalisation scale changes.
  const axle = new THREE.Vector3();
  let radius = 0.34;
  if (wheels.length) {
    wheels[0].bone.getWorldPosition(axle);
    radius = Math.max(0.05, axle.y);
  }

  // `group` is the chassis frame the animation drives; `body` is nested inside
  // it so suspension pitch/roll/heave can be applied without disturbing the
  // path position or heading.
  const body = new THREE.Group();
  body.add(model);
  const group = new THREE.Group();
  group.add(body);

  return {
    group,
    body,
    model,
    wheels,
    wheelRadius: radius,
    /**
     * Orients all four wheels and re-plants them on the ground plane.
     * Runs in two passes because planting has to measure world positions that
     * only exist once the chassis pose and wheel orientation are both applied.
     *
     * @param {number} spin radians of accumulated axle rotation
     * @param {number} steer radians of front-wheel steering
     * @param {number} bodyPitch current body pitch, cancelled on the wheels
     */
    updateWheels(spin, steer, bodyPitch = 0) {
      for (const wheel of wheels) {
        wheel.orient(spin, wheel.steerable ? steer : 0, bodyPitch);
      }
      group.updateMatrixWorld(true);
      for (const wheel of wheels) wheel.plant(radius);
    },
    dispose() {
      model.traverse((node) => {
        if (!node.isMesh) return;
        node.geometry?.dispose();
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        mats.forEach((m) => {
          if (!m) return;
          for (const value of Object.values(m)) {
            if (value && value.isTexture) value.dispose();
          }
          m.dispose();
        });
      });
      group.removeFromParent();
    },
  };
}
