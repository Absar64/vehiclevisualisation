/**
 * quality.js — render cost, measured and adapted at runtime.
 *
 * The piece was built on a desktop GPU and then run on an Adreno 610 head
 * unit, where it managed about 5 fps. Nothing was wrong with it: a 2048²
 * soft-shadow map, MSAA, a 2x pixel ratio and three lights over PBR materials
 * is simply more than that chip can do. Guessing a device's budget from its
 * name is a losing game, so this measures instead.
 *
 * Two mechanisms, in order:
 *
 *  1. **A starting guess.** Mobile GPU families and low reported memory start
 *     a tier or two down, so a weak device never has to suffer several
 *     seconds of unusable frames before the loop notices.
 *  2. **Adaptation.** Median frame time over a window decides whether to drop
 *     a tier. The median, not the mean: a single 300 ms hitch from a texture
 *     upload should not trigger a downgrade, and a median ignores it.
 *
 * It only ever steps *down* on its own. A tier that climbs back up
 * oscillates — raising quality lowers the frame rate, which lowers quality
 * again — and the flapping is far more noticeable than the lower setting.
 * Going back up is a deliberate act, from the settings menu.
 */

import * as THREE from 'three';

/**
 * Tiers, richest first.
 *
 * `scale` multiplies the device pixel ratio: it is the single most effective
 * dial on a mobile GPU, because everything expensive here is per-fragment.
 */
export const TIERS = [
  {
    name: 'high',
    maxPixelRatio: 2,
    scale: 1,
    shadows: true,
    shadowMapSize: 2048,
    shadowType: THREE.PCFSoftShadowMap,
    antialias: true,
    rimLights: true,
    envSize: 256,
    detail: 1,
  },
  {
    name: 'medium',
    maxPixelRatio: 1.5,
    scale: 1,
    shadows: true,
    shadowMapSize: 1024,
    shadowType: THREE.PCFShadowMap,
    antialias: true,
    rimLights: true,
    envSize: 128,
    detail: 0.7,
  },
  {
    name: 'low',
    maxPixelRatio: 1,
    scale: 1,
    shadows: false,
    shadowMapSize: 512,
    shadowType: THREE.BasicShadowMap,
    antialias: false,
    rimLights: true,
    envSize: 128,
    detail: 0.5,
  },
  {
    name: 'minimal',
    maxPixelRatio: 1,
    // Render below native and let the browser scale it up. Ugly on a desk,
    // hard to notice on a dash, and it is the difference between moving and
    // not on the slowest hardware.
    scale: 0.7,
    shadows: false,
    shadowMapSize: 512,
    shadowType: THREE.BasicShadowMap,
    antialias: false,
    rimLights: false,
    envSize: 64,
    detail: 0.3,
  },
];

/** Frame time above which a tier is considered too expensive (~24 fps). */
const BUDGET_MS = 42;
/** Frames per judgement window. */
const WINDOW = 45;
/** Windows in a row over budget before dropping. */
const STRIKES = 2;

/**
 * A first guess from what the browser will admit about the hardware.
 * Deliberately coarse — it only has to avoid starting a phone at 'high'.
 */
function guessTier(gl) {
  let index = 0;
  try {
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    // Integrated mobile parts. Adreno 6xx and below, older Mali, PowerVR and
    // anything falling back to software all want to start low.
    if (/SwiftShader|Software|llvmpipe/i.test(name)) index = 3;
    else if (/Adreno \(TM\) [1-6]\d\d|Mali-[GT]?[1-6]\d|PowerVR/i.test(name)) index = 2;
    else if (/Adreno|Mali|Apple A[0-9]|PowerVR/i.test(name)) index = 1;
  } catch {
    /* no debug extension; fall through to the memory check */
  }

  const memory = navigator.deviceMemory;
  if (memory && memory <= 4) index = Math.max(index, 2);
  if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) {
    index = Math.max(index, 2);
  }
  return Math.min(index, TIERS.length - 1);
}

/**
 * The starting tier, worked out before the real renderer exists.
 *
 * Multisampling is fixed when a WebGL context is created and cannot be turned
 * off afterwards, so the tier has to be known before `new WebGLRenderer()` —
 * hence a throwaway context purely to read the GPU string. It is released
 * immediately; holding a second context open costs a real slot on mobile.
 */
export function probeTier() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  const index = guessTier(gl);
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return index;
}

export class QualityManager {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {(tier:object)=>void} onChange applies tier settings owned elsewhere
   */
  constructor(renderer, onChange, startIndex) {
    this.renderer = renderer;
    this.onChange = onChange;
    this.index = startIndex ?? guessTier(renderer.getContext());
    this.auto = true;
    this.frames = [];
    this.strikes = 0;
    this.locked = false;
  }

  get tier() {
    return TIERS[this.index];
  }

  /** Applies the current tier. Call after construction and on every change. */
  apply() {
    const tier = this.tier;
    const dpr = Math.min(window.devicePixelRatio || 1, tier.maxPixelRatio) * tier.scale;
    this.renderer.setPixelRatio(dpr);
    this.renderer.shadowMap.enabled = tier.shadows;
    this.renderer.shadowMap.type = tier.shadowType;
    // Shadow maps are cached; the light has to be told they are stale.
    this.renderer.shadowMap.needsUpdate = true;
    this.onChange?.(tier);
  }

  /**
   * Feeds one frame's cost in. Returns true when the tier changed, so the
   * caller can resize and re-apply.
   *
   * @param {number} ms milliseconds that frame took
   */
  sample(ms) {
    if (!this.auto || this.locked || this.index >= TIERS.length - 1) return false;

    this.frames.push(ms);
    if (this.frames.length < WINDOW) return false;

    this.frames.sort((a, b) => a - b);
    const median = this.frames[this.frames.length >> 1];
    this.frames.length = 0;

    if (median <= BUDGET_MS) {
      this.strikes = 0;
      return false;
    }

    this.strikes++;
    if (this.strikes < STRIKES) return false;

    this.strikes = 0;
    this.index++;
    this.apply();
    console.info(
      `[showcase] ${median.toFixed(0)} ms/frame — dropping to "${this.tier.name}" quality`
    );
    return true;
  }

  /** Pins a tier by name, switching off adaptation. */
  set(name) {
    const index = TIERS.findIndex((t) => t.name === name);
    if (index < 0) return;
    this.index = index;
    this.auto = false;
    this.strikes = 0;
    this.frames.length = 0;
    this.apply();
  }

  /** Hands control back to the measurement. */
  setAuto() {
    this.auto = true;
    this.strikes = 0;
    this.frames.length = 0;
  }
}
