/**
 * config.js — every tunable number for the showcase lives here.
 * Keeping the "art direction" separate from the engine code means the piece can
 * be re-timed, re-framed or re-tuned without touching any of the systems.
 */

export const ASSET = {
  url: './bmw.glb',
  /** The model is uniformly rescaled so its longest axis equals this (metres). */
  targetLength: 4.71,
  /**
   * Yaw applied once at load so the car's nose points down rig-local +Z.
   * The source is an FBX-derived, Z-up rig; glTF's root node rotates it to
   * Y-up, which leaves the nose on -Z — hence the half turn.
   */
  modelForwardYaw: Math.PI,
  /** Bone names of the four road wheels. */
  wheelBones: {
    frontLeft: 'wheel_lf_048',
    frontRight: 'wheel_rf_045',
    rearLeft: 'wheel_lr_047',
    rearRight: 'wheel_rr_046',
  },
};

export const CAMERA = {
  fov: 27,
  near: 0.1,
  far: 400, // the street and warp layers run a couple of hundred metres out
  /** Wide, slightly higher establishing frame held while the car sweeps in. */
  start: { position: [7.9, 2.55, 11.2], target: [-1.2, 0.85, 0.0] },
  /** Final hero frame: low, close, three-quarter front. */
  hero: { position: [4.75, 1.12, 6.35], target: [0.02, 0.7, 0.12] },
  /** Gentle post-settle drift so the frame never feels frozen. */
  drift: { amplitude: 0.075, speed: 0.17 },
};

// ── Phase 1: the boot sequence ─────────────────────────────────────────────

/**
 * The opening move.
 *
 * The car is parked; only the camera travels, arcing in from a wide
 * establishing frame to a close hero framing. Three keys rather than two, so
 * the path curves around toward the car instead of sliding straight at it.
 */
export const BOOT = {
  /** Seconds for the push. Long enough to feel unhurried, short enough to land. */
  duration: 7.0,
  path: [
    { position: [9.6, 3.15, 14.2], target: [0.0, 1.05, 0.6], fov: 34 },
    { position: [7.4, 1.95, 9.4], target: [0.05, 0.86, 0.3], fov: 30 },
    { position: [4.55, 1.06, 5.85], target: [0.05, 0.72, 0.15], fov: 27 },
  ],
  /**
   * The held frame keeps breathing: a slow arc about the aim point, eased in
   * from a standstill so the join is invisible.
   */
  drift: { azimuth: 0.028, lift: 0.05, period: 26, easeIn: 3.0 },
  /** Welcome line fades up from this fraction of the push, over this long. */
  welcomeStart: 0.52,
  welcomeFade: 1.8,
};

// ── Phase transitions ──────────────────────────────────────────────────────

export const TRANSITION = {
  /** Seconds spent blending the boot's hero frame into the chase frame. */
  duration: 2.1,
  /** Point in that blend where the scene layers and telemetry start fading up. */
  hudFadeStart: 0.45,
};

// ── Phase 2: driving mode ──────────────────────────────────────────────────

export const DRIVE = {
  camera: {
    /** Metres behind the car at a standstill. */
    distance: 6.1,
    height: 1.78,
    targetHeight: 1.98,
    /** How far down the road the camera looks — sets the vanishing point. */
    targetAhead: 30,
    /** Additional pull-back at speed, and the speed at which it is fully applied. */
    pullback: 1.15,
    pullbackReference: 120,
    /** Road shiver, scaled by speed; the second term is the hard-launch kick. */
    shake: 0.0075,
    shakeSurge: 0.026,
    /** Momentary jolt at each tier promotion. */
    shakePulse: 0.03,
  },
  /** Speed-driven field of view: the "FOV stretch" of the warp effect. */
  fov: { base: 30, perMph: 0.055, surge: 5.5 },
  body: {
    /** Metres of lateral lane-wander at full speed. */
    swayAmplitude: 0.05,
    swaySpeed: 0.42,
  },
  /** Rear squat under acceleration; surgeGain multiplies it with the tier. */
  squat: { stiffness: 34, damping: 9.5, gain: 0.0022, limit: 0.042, surgeGain: 1.1 },
  /** Body roll coupled to the lateral wander. */
  sway: { stiffness: 30, damping: 9.0, gain: 0.5, limit: 0.02 },
  /**
   * Speed the simulator eases to on entering drive mode when no GPS fix has
   * arrived. Null by design: the boot sequence holds until the car genuinely
   * moves, so nothing may set it going on its own. Give it a number only if you
   * want the piece to drive itself for a demo loop.
   */
  autoDemoMph: null,
  autoDemoDelay: 1.2,
};

/**
 * Surge tiering — a rolling rate-of-change evaluation.
 *
 * Each tier is a (gain, window) condition tested continuously: "has speed risen
 * by at least `gain` mph at any point inside the last `window` seconds?" The
 * low tier is deliberately given the tighter one-second window, so a +10 mph
 * change has to be genuinely quick to register at all; the upper tiers get
 * 1.5 s, which is what a real pull of that size takes.
 *
 * Speed built up gradually satisfies none of them, so nothing plays — the
 * windows are the whole mechanism for telling a hard pull from a gentle one.
 *
 * The evaluation returns a continuous position through the ladder rather than a
 * tier number, so a pull that escalates mid-sequence blends onward from where
 * the effect already is. `attack` and `release` then decide how fast the drive
 * follows it up and, more importantly, how gracefully it decays once the
 * conditions stop being met.
 */
export const SURGE = {
  /**
   * Calibration knob. Every tier's gain threshold is divided by this before it
   * is tested, so 1.3 makes the whole ladder 30% easier to trigger: the low
   * tier needs +7.7 mph inside its second rather than +10, and the top tier
   * +30.8 inside 1.5 s rather than +40. The `tiers` below stay written as the
   * nominal rule, so the spec and the calibration remain separately readable.
   */
  sensitivity: 1.3,
  tiers: [
    { gain: 10, window: 1.0 },
    { gain: 20, window: 1.5 },
    { gain: 30, window: 1.5 },
    { gain: 40, window: 1.5 },
  ],
  /**
   * Deadband under the first tier, as a fraction of its gain. Below 80% of
   * "+10 mph in 1 s" nothing plays; the last 20% blends in, so the effect
   * arrives rather than popping.
   */
  entryBand: 0.8,
  /** Time constants for the effect drive rising and falling. */
  attack: 0.14,
  release: 0.9,
  /** Decay of the punch fired as each whole tier is crossed. */
  pulseDecay: 0.32,
};

/** How the two scene layers share the frame during a launch. */
export const WARP = {
  /** How far the streetscape dims at full power — never to zero. */
  streetDim: 0.25,
};

/**
 * Speed streaks: the tier-2-and-up element layered over the rings.
 * One draw call; every streak's motion happens in the vertex shader.
 */
export const STREAKS = {
  count: 130,
  /** Recycle length of the column, in metres. */
  span: 190,
  /** Radial spread of the airborne slivers around the road axis. */
  radiusMin: 2.8,
  radiusMax: 15,
  /** Lateral spread of the ground-level tarmac blur. */
  groundHalf: 7.5,
  /** Surge power at which each family appears — airborne first, ground later. */
  airTier: 0.3,
  groundTier: 0.56,
  /** Streak length at rest and the extra length at full power, in metres. */
  lengthBase: 5,
  lengthPower: 30,
  width: 0.05,
  color: 0xff9440,
  hotColor: 0xfff4e2,
  speedScale: 1.9,
  fadeFar: 150,
};

/** The warp tunnel: concentric rounded-rectangle rings rushing the camera. */
export const TUNNEL = {
  count: 34,
  /** Metres between rings. */
  spacing: 7.0,
  width: 9.6,
  height: 4.6,
  radius: 1.15,
  /**
   * Height of the column's centreline above the road. Chosen so the bottom
   * edge clears the tarmac by a few centimetres: sink it any lower and the
   * road occludes it, leaving the rings reading as arches rather than as the
   * closed rectangles the effect is built from.
   */
  centreHeight: 2.45,
  /** Thickness of the glowing ribbon, in metres. */
  ribbonWidth: 0.17,
  /** Metres behind the chase camera at which a ring is recycled to the far end. */
  recycleBehind: 4.0,
  colorFar: 0x4a0f02,
  colorNear: 0xff6a12,
  core: 0xffd9a0,
  /** Tunnel flow relative to true ground speed, and its hard-launch boost. */
  speedScale: 1.35,
  surgeFlow: 0.6,
  /**
   * Surge power at which each density class lights up. Class 0 is every fourth
   * ring (the subtle tier-1 look), class 1 fills in every other one, class 2
   * completes the column only under a hard pull.
   */
  tierBands: [0.02, 0.3, 0.55],
  tierFade: 0.2,
};

/**
 * The streetscape: outline trees, bushes, buildings and lamps drifting past.
 * Cool, dim and low-contrast on purpose — this is the calm state, and it has to
 * sit behind a bright white speed readout for minutes at a time.
 */
export const STREET = {
  /** Props per side of the road. */
  count: 22,
  /** Average metres between props; each is jittered around its slot. */
  spacing: 13.5,
  /** Where the verge begins — props are never closer to the centre than this. */
  vergeHalf: 6.2,
  /** Metres behind the camera at which a prop recycles to the far end. */
  recycleBehind: 6.0,
  /** Distance fog: props rise out of the dark and fade before they clip. */
  fadeFar: 165,
  fadeNear: 7.0,
  color: 0x86c6ec,
  opacity: 0.46,
  /** Lane markings down both edges of the road. */
  dash: {
    count: 24,
    spacing: 14.0,
    length: 3.0,
    halfWidth: 4.6,
    color: 0xa8d8f5,
    opacity: 0.3,
  },
};

/**
 * The idle showcase: once the car has been stationary for a few seconds the
 * camera flies one continuous loop around it — no cuts anywhere — and drops
 * back into the drive view the moment it starts rolling again.
 */
export const IDLE = {
  /** Speeds below this count as stopped. */
  speedEpsilon: 0.5,
  /** Seconds at rest before the showcase takes over. */
  holdSeconds: 5,
  /** Seconds spent easing out of the chase camera and into the orbit. */
  enterDuration: 2.6,
  /** Seconds spent blending back to the chase camera when it moves off. */
  resumeDuration: 1.6,
  /**
   * Breaking off to look at the people.
   *
   * Only sometimes: a loop that always cut to the crew would stop being a car
   * showcase. `chance` is rolled once per idle, and the detour happens after a
   * random delay so it never lands at the same point in the lap twice.
   */
  crewLook: {
    chance: 0.3,
    /** Seconds into the idle before it may happen, picked in this range. */
    delay: [6, 15],
    /** How long it lingers on them. */
    duration: 8,
    /** Time constant of the swing on and off the subject. */
    blend: 1.6,
    /**
     * How far the aim swings onto them, and how much the lens opens up.
     *
     * The camera does not move off its path at all — re-pointing is the whole
     * detour, which is what keeps it a pan rather than a cut. It *widens*
     * rather than tightens, which is the opposite of the instinct: the marks
     * stand ~3 m out and the orbit passes within 2.8 m of them, so at the
     * closest point a 30° lens cannot fit a whole figure vertically. Opening
     * six degrees is what takes the pair from 75% fully in frame to 100%,
     * and it keeps the car in shot beside them.
     */
    aim: 0.7,
    /** Degrees the lens opens while on them. */
    widen: 6,
  },
  orbit: {
    /** Seconds for one full lap at the nominal rate. */
    duration: 38,
    /**
     * How much the camera slows as it passes each keyframe: 0 is a constant
     * glide, 1 stops dead. High values read as settling on an angle and moving
     * on, which is the part of a loading-screen reel worth keeping.
     */
    dwell: 0.72,
    /**
     * Hero angles, in the car's own frame: +Z is the nose, +X the right flank.
     * The list is a closed loop, so the last key flows back into the first.
     * Every key stays low and roughly level with the car: the orbit reads as a
     * walk-around, and the camera never rises far enough for the ground plane
     * to sweep through the frame.
     */
    keys: [
      { position: [3.45, 0.72, 4.6], target: [0, 0.74, 0.5], fov: 30 },
      { position: [6.4, 1.0, 0.25], target: [0, 0.8, 0.1], fov: 29 },
      { position: [3.7, 1.15, -4.6], target: [0, 0.8, -0.3], fov: 31 },
      { position: [0, 2.35, -6.4], target: [0, 0.75, -0.2], fov: 33 },
      { position: [-3.8, 1.15, -4.4], target: [0, 0.8, -0.3], fov: 31 },
      { position: [-6.3, 0.95, 0.1], target: [0, 0.78, 0.1], fov: 29 },
      { position: [-3.25, 0.64, 4.5], target: [0, 0.72, 0.45], fov: 28 },
    ],
  },
};

/**
 * The showroom the car sits in while parked. A stationary car in a void reads
 * as a turntable; this gives the orbit parallax to move through.
 */
export const SHOWROOM = {
  color: 0x7fb8e0,
  opacity: 0.4,
  fadeNear: 3.0,
  fadeFar: 90,
  /** Marked deck under the car. */
  deckRings: [3.6, 5.4, 9.2, 11.0],
  deckTicks: 48,
  deckColor: 0x9fd4f2,
  deckOpacity: 0.34,
  lampRadius: 9.8,
  /** Greenery close in, city blocks behind it. */
  greenBelt: { count: 14, radius: 16, radiusSpread: 4.5, jitterAngle: 0.28 },
  cityBelt: { count: 16, radius: 30, radiusSpread: 12, jitterAngle: 0.22 },
  /** A faint graded dome, so the frame never bottoms out to flat black. */
  domeRadius: 120,
  domeHorizon: 0x0a1626,
  domeZenith: 0x000000,
  domeOpacity: 0.85,
};

/** Speed model: limits and response rates. */
export const SPEEDO = {
  maxMph: 140,
  /**
   * The ramp rate scales with how big a change is being asked for: nudging 55
   * to 60 gains a couple of mph per second, while a big jump launches at the
   * cap. The cap is set so a launch can actually satisfy the top tier's "+40
   * mph inside 1.5 s" — at 30 mph/s it clears it with room to spare, where a
   * lower cap would leave tier 4 permanently just out of reach.
   */
  rateGain: 2.4,
  minAccelMphPerSec: 2.2,
  launchMphPerSec: 30,
  brakeMphPerSec: 30,
  /**
   * Time constant of the smoothing filter on top of the rate limit. Kept short:
   * it only has to round the corners where a ramp starts and stops, and every
   * millisecond of lag it adds is gain that never lands inside the surge
   * model's measuring window.
   */
  smoothing: 0.11,
};

/**
 * Road geometry and turn anticipation.
 *
 * The centreline is integrated into a table covering `behind`…`range` metres
 * around the car every frame. 128 samples over ~275 m is roughly one sample
 * every two metres — finer than anything on screen can resolve, and small
 * enough that rebuilding it and re-uploading the texture is free.
 */
export const ROAD = {
  samples: 128,
  /** Metres of road held ahead of the car, and behind the chase camera. */
  range: 260,
  behind: 16,
  /**
   * Transition length of a bend, scaled by its angle. A raised-cosine turn of
   * angle A over length L has a minimum radius of L/2A, so this constant is
   * really a radius setting: 70 m/rad puts a 60° bend on a ~35 m radius over
   * 74 m of road.
   *
   * That is tighter than a real road of the same angle would be. It is a
   * deliberate trade: at this focal length and with the scenery fading out by
   * ~165 m, a highway-realistic 250 m radius subtends barely a degree and the
   * road reads as dead straight. These radii put the whole bend inside the
   * visible range, and the lean and steer clamps keep the car's response
   * plausible rather than cartoonish.
   */
  turnLengthPerRadian: 70,
  minTurnLength: 30,
  maxTurnLength: 130,
  /** Route vertices below this heading change are noise, not turns. */
  minTurnAngle: 0.07,
  /** Where a simulated bend is placed when queued, in metres ahead. */
  previewDistance: 100,
  /** Easing on curvature derived from live GPS bearing changes. */
  liveSmoothing: 0.6,
  /** Safety clamp, a 25 m radius. Beyond this the chase camera cannot track. */
  maxCurvature: 0.04,
  /** Front-wheel steer angle follows δ ≈ wheelbase · κ. */
  steer: { wheelbase: 2.85, limit: 0.5 },
  /** Body lean, driven by lateral acceleration v²κ. */
  lean: { gain: 0.0022, limit: 0.055 },
  /**
   * How the camera leads a bend.
   *
   * The aim point is taken from the centreline ahead, but its lateral offset is
   * scaled and then hard-limited. Without the limit the camera aims right
   * around the corner — 30 m along a 35 m radius is already 50° off axis — and
   * the car swings out of frame entirely. Clamping the swing lets the view turn
   * into the bend while keeping the car as the subject.
   *
   * The cap is also a composition constraint: the speed readout owns the right
   * third of the frame, so the car must never drift far enough under it to be
   * obscured on a left-hand bend.
   */
  cameraSwing: { gain: 0.28, limit: 3.5 },
};

/**
 * The crew: Absar and an optional passenger, who exist only while parked.
 * There is no cycle timer — a scene is picked when the car settles and holds
 * for that whole idle.
 */
export const CREW = {
  /** Seconds to fade in when the car stops, and out when it moves. */
  fadeIn: 1.1,
  fadeOut: 0.45,
};

/**
 * Road furniture: real traffic signals and speed cameras from OpenStreetMap.
 * Yellow to match the UK's own camera livery, and to separate them at a glance
 * from the blue scenery, which is decorative rather than real.
 */
export const FURNITURE = {
  color: 0xffd400,
  opacity: 0.95,
  fadeNear: 5.0,
  /** Items appear at this distance and are dropped this far behind the car. */
  fadeFar: 150,
  behind: 12,
  /**
   * Pool sizes. A route may hold hundreds of items; only the handful inside the
   * visible window are ever drawn, so these bound the scene regardless of how
   * long the drive is.
   */
  signalPool: 14,
  cameraPool: 6,
  /**
   * Signals are mapped in OSM as nodes *on* the carriageway centreline, so
   * placing them at their true offset would stand them in the middle of the
   * road. Anything closer in than this is pushed out to the nearside verge.
   */
  minLateral: 5.0,
  maxLateral: 11.0,
};

/** Driving a picked route. */
export const ROUTE = {
  /** Cruising speed the simulator holds between bends. */
  cruiseMph: 45,
  /**
   * Comfortable cornering acceleration. The simulator slows for a bend to
   * v = sqrt(a/κ), which is how a real driver picks a corner speed — and it
   * keeps the tight radii this build uses from being taken at absurd g.
   */
  cornerAccel: 3.6,
  /** How far ahead the speed planner looks for curvature, in metres. */
  lookahead: 70,
  /** Minimum speed it will slow to for a corner. */
  minCornerMph: 16,
};

/**
 * Spotify now-playing.
 *
 * Client ID only — the flow is Authorization Code with PKCE, which needs no
 * client secret. Never put one in here: everything in this file ships to the
 * browser and is readable by anyone who opens the page.
 *
 * The redirect URI is derived at runtime from the page's own origin and path,
 * and must be registered verbatim in the Spotify app dashboard. Spotify only
 * accepts http for explicit loopback addresses, so serve the page from
 * http://127.0.0.1:5173/ rather than http://localhost:5173/.
 */
export const SPOTIFY = {
  clientId: 'f91cc82c4fc24fd2be5ba3225aab1b0b',
  scopes: ['user-read-currently-playing', 'user-read-playback-state'],
  /** Seconds between polls. Spotify rate-limits, and a track is minutes long. */
  pollSeconds: 5,
};

export const RENDER = {
  maxPixelRatio: 2,
  exposure: 1.08,
  /** Studio softbox rig baked into the PMREM environment map. */
  envIntensity: 1.25,
};
