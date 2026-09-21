/**
 * miiLibrary.js — finds and loads the Mii heads.
 *
 * Heads are authored elsewhere and dropped into the `Mii/` folder as .glb
 * files, so nothing here is hard-coded: the folder is read at runtime and
 * whatever is in it becomes the cast list. Two ways, in order:
 *
 *   1. `Mii/manifest.json` — an explicit array of filenames, for hosts that
 *      serve no directory index (most production static hosts).
 *   2. The directory listing itself, which is what the dev server returns.
 *      This is the path that makes "just drop a file in" work.
 *
 * A name comes from the filename with the `_mii` suffix stripped, as asked:
 * `absar_mii.glb` is Absar.
 *
 * Loaded heads are cached by URL and cloned per character, so using the same
 * Mii for driver and passenger costs one download and one parse.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const FOLDER = './Mii/';
const loader = new GLTFLoader();

/** url -> Promise<{scene, skin, hair}> */
const cache = new Map();

/**
 * Whether a manifest exists. Looked for once: most setups have none, and
 * re-requesting a known-absent file on every refresh just fills the console
 * with 404s.
 */
let manifestPresent = null;

/** `absar_mii.glb` -> `Absar`. */
export function nameFromFile(file) {
  const base = file
    .replace(/\.glb$/i, '')
    .replace(/_mii$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return base.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Pulls .glb filenames out of a server-generated directory index. */
function parseIndex(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const files = new Set();

  // A directory index generated on Windows emits backslash-separated hrefs,
  // so the filename is whatever follows the last separator of either kind.
  const BACKSLASH = String.fromCharCode(92);

  for (const link of doc.querySelectorAll('a[href]')) {
    const raw = decodeURIComponent(link.getAttribute('href') ?? '');
    const cut = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf(BACKSLASH));
    const file = cut >= 0 ? raw.slice(cut + 1) : raw;
    if (/\.glb$/i.test(file)) files.add(file);
  }
  return [...files];
}

/**
 * Lists every Mii in the folder.
 * @returns {Promise<{id:string, name:string, url:string}[]>}
 */
export async function discoverMiis() {
  let files = [];

  if (manifestPresent !== false) {
    try {
      const manifest = await fetch(`${FOLDER}manifest.json`, { cache: 'no-cache' });
      manifestPresent = manifest.ok;
      if (manifest.ok) {
        const data = await manifest.json();
        files = Array.isArray(data) ? data : (data.files ?? []);
      }
    } catch {
      manifestPresent = false;
    }
  }

  if (!files.length) {
    try {
      const index = await fetch(FOLDER, { cache: 'no-cache' });
      if (index.ok) files = parseIndex(await index.text());
    } catch {
      /* no index either; the cast will be empty and the UI says so */
    }
  }

  return files
    .filter((file) => /\.glb$/i.test(file))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => ({ id: file, name: nameFromFile(file), url: `${FOLDER}${file}` }));
}

/**
 * Loads one head, once.
 *
 * The export carries its own colours as base-colour factors — the faceline is
 * the skin tone and the hair mesh the hair colour — so they are read back here
 * and handed to the body builder. That is what lets a procedural body match a
 * head nobody on this side of the code has ever seen.
 *
 * @param {string} url
 * @returns {Promise<{scene:THREE.Object3D, skin:THREE.Color, hair:THREE.Color}>}
 */
export function loadMiiHead(url) {
  if (cache.has(url)) return cache.get(url);

  const promise = loader.loadAsync(url).then((gltf) => {
    const scene = gltf.scene;
    let skin = new THREE.Color(0xf3c19c);
    let hair = new THREE.Color(0x2b2320);

    scene.traverse((node) => {
      if (!node.isMesh) return;
      const name = node.name || node.material?.name || '';
      const color = node.material?.color;
      if (!color) return;
      if (/faceline/i.test(name)) skin = color.clone();
      else if (/hair/i.test(name)) hair = color.clone();
    });

    return { scene, skin, hair };
  });

  cache.set(url, promise);
  return promise;
}

/**
 * A fresh, independently fadeable copy of a cached head.
 *
 * Materials are cloned along with the meshes: the originals are shared by every
 * copy, and the crew fades characters by writing `opacity`, which would
 * otherwise fade all of them together.
 */
export function instantiateHead(source) {
  const head = source.clone(true);
  head.traverse((node) => {
    if (!node.isMesh) return;
    node.material = Array.isArray(node.material)
      ? node.material.map((m) => m.clone())
      : node.material.clone();
    // Every part has to be able to fade, including the masked face plane.
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) material.transparent = true;
    node.castShadow = true;
    node.frustumCulled = false;
  });
  return head;
}

export function disposeHeadInstance(head) {
  head.traverse((node) => {
    if (!node.isMesh) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) material.dispose();
  });
  head.removeFromParent();
}
