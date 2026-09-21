/**
 * environment.js — the studio.
 *
 * A press reveal is lit almost entirely by large, soft, *shaped* sources: an
 * overhead softbox that draws the roof/shoulder line, two vertical strips that
 * carve rim highlights down the flanks, and a dim rear bounce that keeps the
 * shadow side from going to pure black. Rather than faking that with a handful
 * of point lights, we build a tiny scene of emissive planes and pre-filter it
 * into an environment map — dark paint then reflects real, elongated
 * highlights instead of reading as flat unlit polygons.
 */

import * as THREE from 'three';


/** Emissive plane helper: position, look-at, size and radiance in one call. */
function softbox(width, height, color, intensity, position, lookAt) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(intensity),
      side: THREE.DoubleSide,
      toneMapped: false,
    })
  );
  mesh.position.fromArray(position);
  mesh.lookAt(new THREE.Vector3().fromArray(lookAt));
  return mesh;
}

/**
 * Builds the light rig, renders it through PMREM and returns the resulting
 * environment texture plus a dispose() for the scratch resources.
 */
export function createStudioEnvironment(renderer) {
  const rig = new THREE.Scene();

  // Enclosing shell — a near-black cyclorama. Gives the paint something to
  // reflect everywhere the softboxes don't reach, which is what stops dark
  // bodywork from collapsing into silhouette.
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(34, 20, 34),
    new THREE.MeshBasicMaterial({ color: 0x07080b, side: THREE.BackSide, toneMapped: false })
  );
  rig.add(shell);

  // Key: wide overhead softbox, pushed slightly forward of the car.
  rig.add(softbox(13, 7.5, 0xffffff, 3.6, [0.5, 8.4, 1.6], [0.5, 0, 1.6]));

  // Flank strips — long and narrow so they read as elegant specular streaks
  // running the length of the shoulder line rather than as round hotspots.
  rig.add(softbox(17, 1.5, 0xdfe9ff, 3.2, [-7.6, 3.6, -0.6], [0, 1.0, -0.6]));
  rig.add(softbox(17, 1.2, 0xffeede, 2.4, [7.6, 3.2, 0.4], [0, 1.0, 0.4]));

  // Rear kicker: separates the tail from the black background.
  rig.add(softbox(10, 3.0, 0xbcd2ff, 1.5, [0, 3.0, -10.5], [0, 1.2, 0]));

  // Low front fill, deliberately weak — just enough to hint at the grille.
  rig.add(softbox(9, 2.0, 0xffffff, 0.45, [0, 1.2, 10.5], [0, 0.8, 0]));

  // Negative fill: a black flag under the car keeps the lower body crisp.
  rig.add(softbox(24, 24, 0x000000, 1.0, [0, -0.6, 0], [0, 1, 0]));

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envMap = pmrem.fromScene(rig, 0.035).texture;

  // The rig itself is disposable — only the pre-filtered cubemap survives.
  pmrem.dispose();
  rig.traverse((o) => {
    if (o.isMesh) {
      o.geometry.dispose();
      o.material.dispose();
    }
  });

  return {
    envMap,
    dispose() {
      envMap.dispose();
    },
  };
}

/**
 * Practical lights layered on top of the IBL: a sharp key for the contact
 * shadow and two tight rim lights for the hard specular edges that an
 * environment map alone renders too softly.
 */
export function createLightRig(scene) {
  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(-6.5, 8.0, 4.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0009;
  key.shadow.normalBias = 0.022;
  const c = key.shadow.camera;
  c.near = 1;
  c.far = 26;
  c.left = -7;
  c.right = 7;
  c.top = 7;
  c.bottom = -7;
  scene.add(key, key.target);

  const rimLeft = new THREE.DirectionalLight(0xcddcff, 2.3);
  rimLeft.position.set(-8.5, 2.4, -7.5);
  scene.add(rimLeft);

  const rimRight = new THREE.DirectionalLight(0xffe7cc, 1.25);
  rimRight.position.set(9.0, 2.0, -5.0);
  scene.add(rimRight);

  const ambient = new THREE.AmbientLight(0x1a2030, 0.35);
  scene.add(ambient);

  // Offset the key holds while the light tracks the car: a shadow camera tight
  // enough to stay sharp cannot also cover the length of the entry path, so it
  // travels with its subject instead.
  const keyOffset = key.position.clone();
  const rotatedOffset = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  const lights = [key, rimLeft, rimRight, ambient];
  return {
    key,
    /**
     * @param {THREE.Vector3} position where the car currently is
     * @param {number} [heading] yaw to rotate the key's offset into, so the
     *   chase view keeps the same relative rim lighting the hero frame had.
     *   Blended in gradually during the phase transition to avoid a shadow jump.
     */
    follow(position, heading = 0) {
      if (heading === 0) {
        key.position.copy(position).add(keyOffset);
      } else {
        rotatedOffset.copy(keyOffset).applyAxisAngle(UP, heading);
        key.position.copy(position).add(rotatedOffset);
      }
      key.target.position.set(position.x, 0, position.z);
      key.target.updateMatrixWorld();
    },
    dispose() {
      lights.forEach((l) => {
        l.dispose?.();
        scene.remove(l);
      });
      scene.remove(key.target);
    },
  };
}

/**
 * The floor: a dark, faintly glossy disc that fades to nothing at its rim so
 * there is never a visible horizon line against the black frame, plus a
 * shadow-catcher for the car's contact shadow.
 */
export function createFloor(scene, envMap) {
  const disposables = [];

  // Radial alpha ramp — opaque under the car, transparent at the edges.
  const ramp = document.createElement('canvas');
  ramp.width = ramp.height = 256;
  const ctx = ramp.getContext('2d');
  // The disc has to span the whole entry path so the car always has ground
  // under it, while the visible pool of light stays tight around the hero
  // mark — hence a ramp that falls off hard well inside the geometry.
  const grad = ctx.createRadialGradient(128, 128, 4, 128, 128, 128);
  grad.addColorStop(0.0, '#ffffff');
  grad.addColorStop(0.10, '#9a9a9a');
  grad.addColorStop(0.22, '#1e1e1e');
  grad.addColorStop(0.55, '#050505');
  grad.addColorStop(1.0, '#000000');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  const alphaMap = new THREE.CanvasTexture(ramp);
  alphaMap.colorSpace = THREE.NoColorSpace;
  disposables.push(alphaMap);

  const floorGeo = new THREE.CircleGeometry(34, 128);
  const floorMat = new THREE.MeshPhysicalMaterial({
    color: 0x030406,
    roughness: 0.46,
    metalness: 0.0,
    envMap,
    envMapIntensity: 0.26,
    transparent: true,
    alphaMap,
    depthWrite: false,
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = false;
  scene.add(floor);
  disposables.push(floorGeo, floorMat);

  // Shadow catcher sits a hair above the floor to avoid z-fighting.
  const shadowGeo = new THREE.PlaneGeometry(40, 40);
  const shadowMat = new THREE.ShadowMaterial({ opacity: 0.72 });
  const shadowPlane = new THREE.Mesh(shadowGeo, shadowMat);
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.position.y = 0.002;
  shadowPlane.receiveShadow = true;
  scene.add(shadowPlane);
  disposables.push(shadowGeo, shadowMat);

  return {
    /**
     * Fades the ground out.
     *
     * The disc is built for a camera that stays in front of the car: an alpha
     * ramp on a flat plane, plus a shadow catcher. The idle showcase orbits
     * low around the car instead, and at those grazing angles the ramp's edge
     * and the catcher's square read as a grey card swinging through the frame
     * rather than as ground — so the showcase drops them both and lets the
     * showroom deck carry the ground plane.
     */
    setOpacity(value) {
      const v = Math.min(1, Math.max(0, value));
      floorMat.opacity = v;
      shadowMat.opacity = 0.72 * v;
      floor.visible = v > 0.002;
      shadowPlane.visible = v > 0.002;
    },
    dispose() {
      scene.remove(floor, shadowPlane);
      disposables.forEach((d) => d.dispose());
    },
  };
}
