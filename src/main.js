/**
 * main.js — renderer, phase machine, loop and lifecycle.
 *
 * createShowcase(container) wires the whole piece up and returns a handle whose
 * dispose() tears down every GPU resource, DOM node, listener, geolocation
 * watch and timer — so it drops cleanly into a component unmount.
 *
 * The sequence is a five-state machine:
 *
 *   BOOT ─(the car moves)─▶ TRANSITION ─▶ DRIVE ─(5s at rest)─▶ SHOWCASE
 *     ▲                                      ▲                       │
 *     │                                      └──── RESUME ◀──────────┘
 *     └──── "replay boot" from the sim panel ┘         (car moves off)
 *
 * BOOT holds indefinitely. It is a parked car with a camera moving around it,
 * and nothing about elapsed time advances the sequence — the hand-off happens
 * when the speed model reports genuine movement, whether that comes from a real
 * GPS fix, the sim panel or a picked route. Booting never starts driving.
 *
 * BOOT, DRIVE and SHOWCASE each own the camera outright. TRANSITION and RESUME
 * own it in between, blending from a snapshot of wherever the camera was into
 * the pose the next phase resolves live — which is what makes every hand-off a
 * move rather than a cut.
 *
 * Within DRIVE, which *scene layer* is showing is a separate, continuous
 * decision driven by acceleration rather than by the phase machine: see
 * resolveLayers().
 */

import * as THREE from 'three';
import { CAMERA, RENDER, BOOT, TRANSITION, DRIVE, WARP, IDLE, ROAD, ROUTE, FURNITURE, CREW } from './config.js';
import { createStudioEnvironment, createLightRig, createFloor } from './environment.js';
import { loadCar } from './car.js';
import { BootSequence } from './boot.js';
import { pickWelcome } from './welcome.js';
import { Crew } from './crew.js';
import { disposeAvatarGeometry } from './avatar.js';
import { discoverMiis } from './miiLibrary.js';
import { DriveMode } from './drive.js';
import { WarpTunnel } from './tunnel.js';
import { Streetscape } from './streetscape.js';
import { IdleShowcase } from './idleShowcase.js';
import { IdleScene } from './idleScene.js';
import { SpeedStreaks } from './streaks.js';
import { SurgeModel } from './surge.js';
import { RoadModel } from './road.js';
import { RoadFurniture } from './furniture.js';
import { MapPicker } from './mapPicker.js';
import { fetchRoute, fetchFurniture } from './osm.js';
import { SpeedModel } from './speed.js';
import { Hud } from './hud.js';
import { SpotifyNowPlaying } from './spotify.js';
import { clamp } from './spring.js';

/** Frame-time ceiling: a backgrounded tab must not teleport the car. */
const MAX_DELTA = 1 / 30;

const Phase = {
  BOOT: 'boot',
  TRANSITION: 'transition',
  DRIVE: 'drive',
  SHOWCASE: 'showcase',
  RESUME: 'resume',
};

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function createShowcase({ container, canvas, onProgress, onReady }) {
  // ── Renderer ──────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x000000, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = RENDER.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, CAMERA.near, CAMERA.far);
  camera.position.fromArray(CAMERA.start.position);
  camera.lookAt(new THREE.Vector3().fromArray(CAMERA.start.target));

  const studio = createStudioEnvironment(renderer);
  scene.environment = studio.envMap;

  const lights = createLightRig(scene);
  const floor = createFloor(scene, studio.envMap);

  // ── Telemetry + overlay ──────────────────────────────────────────────────
  const speed = new SpeedModel();
  speed.startGeolocation();

  const hud = new Hud(container, {
    onSimulate: (mph) => {
      autoDemoArmed = false; // operator input always wins
      speed.setSimulated(mph);
    },
    onReplay: () => replayBoot(),
    onSpotifyConnect: () => spotify.connect(),
    onOpenMap: () => mapPicker.open(),
    onPassengerOpen: () => refreshCast(),
    onPassengerPick: (mii) => {
      passengerId = mii?.id ?? null;
      refreshCast();
    },
    onHideCrew: (hidden) => {
      hideCrew = hidden;
      refreshCast();
    },
    onCrew: (action) => {
      if (action === 'reload') refreshCast();
      else if (action === 'shuffle') crew?.pickScene();
      else if (action === 'idle') {
        // Jump straight to the parked showcase, skipping the five-second wait.
        // Reachable from the boot screen too, which is where it is most useful:
        // the orbit is the only view that sees every activity mark.
        autoDemoArmed = false;
        speed.setSimulated(0);
        speed.mph = 0;
        if (phase !== Phase.SHOWCASE) {
          drive.anchor(0);
          beginShowcase();
        }
      }
    },
    onRoute: (angle) => {
      if (angle === null) road.setStraight();
      else if (angle === 's') {
        // An S-bend: two opposed turns, the second placed beyond the first.
        road.queueTurn(-34);
        road.queueTurn(34, ROAD.previewDistance + 95);
      } else road.queueTurn(angle);
    },
  });
  hud.setOpacity(0);

  // Now-playing telemetry is independent of the render loop: it polls on its
  // own schedule and pushes state into the overlay when it changes.
  /**
   * Runs a picked route.
   *
   * The route becomes the road — its bends are anticipated exactly as before —
   * and the real traffic signals and speed cameras along it are projected onto
   * it so they arrive at their true positions.
   */
  async function driveRoute(from, to) {
    const { points, distance } = await fetchRoute(from, to);
    road.setRoute(points);
    mapPicker.showRoute(points);

    let found = { signal: 0, camera: 0 };
    try {
      const items = await fetchFurniture(points);
      const placed = [];
      for (const item of items) {
        const projected = road.projectOntoRoute(item.lat, item.lon);
        if (!projected) continue;

        // Signals are mapped on the carriageway centreline, so their true
        // offset would stand them in the middle of the road; push anything too
        // close out to the nearside verge, keeping whichever side it was on.
        const side = projected.lateral >= 0 ? 1 : -1;
        const magnitude = clamp(
          Math.abs(projected.lateral),
          FURNITURE.minLateral,
          FURNITURE.maxLateral
        );

        placed.push({ type: item.type, distance: projected.distance, lateral: side * magnitude });
        found[item.type]++;
      }
      furniture.setItems(placed);
    } catch (error) {
      // Furniture is a bonus; a route with none is still perfectly drivable.
      furniture.clear();
      console.warn('[showcase] road furniture unavailable:', error.message);
    }

    routeDrive = true;
    autoDemoArmed = false;
    speed.setSimulated(ROUTE.cruiseMph);

    const km = (distance / 1000).toFixed(1);
    return `${km} km · ${found.signal} signals · ${found.camera} cameras`;
  }

  const mapPicker = new MapPicker({ onDrive: (from, to) => driveRoute(from, to) });

  /**
   * Speed planning while driving a route.
   *
   * Looks ahead for the sharpest curvature within a short distance and holds
   * the speed a real driver would take it at, v = sqrt(a/κ). That is what stops
   * the car carrying cruising speed into a tight bend, and the acceleration
   * back out of one is a genuine surge the effects respond to.
   */
  function planRouteSpeed() {
    if (!routeDrive) return;

    if (road.routeLength > 0 && road.travelled >= road.routeLength) {
      // Arrived. Coming to a stop hands over to the idle showcase on its own.
      routeDrive = false;
      speed.setSimulated(0);
      return;
    }

    let sharpest = 0;
    for (let s = 0; s <= ROUTE.lookahead; s += 10) {
      sharpest = Math.max(sharpest, Math.abs(road.sample(s).curvature));
    }

    const corner =
      sharpest > 1e-4
        ? Math.sqrt(ROUTE.cornerAccel / sharpest) * 2.2369362920544
        : ROUTE.cruiseMph;
    const target = clamp(Math.min(ROUTE.cruiseMph, corner), ROUTE.minCornerMph, ROUTE.cruiseMph);

    // Only re-command when it has moved enough to matter; every call restarts
    // the rate limiter, and re-issuing the same target each frame would stall
    // the ramp completely.
    if (Math.abs(target - speed.commandedMph) > 1.5) speed.setSimulated(target);
  }

  // Live fixes drive the road model too: with no route loaded it derives the
  // curvature the car is actually in from the change in bearing between fixes.
  speed.onFix = (coords, mph) => road.onFix(coords, mph);

  const spotify = new SpotifyNowPlaying({
    onChange: (state) => hud.setNowPlaying(state),
  });
  spotify.start();

  // ── Sizing (high-DPI aware) ──────────────────────────────────────────────
  /**
   * The same condition as the stylesheet's fill breakpoint, so the two cannot
   * disagree about which layout is in force.
   */
  const fillQuery = window.matchMedia('(max-width: 900px), (max-aspect-ratio: 8 / 5)');

  /**
   * Publishes the HUD's sizing units as plain pixels.
   *
   * These were container query units, which is the tidier way to express them
   * and which a 2022 Android WebView does not implement — Chrome only shipped
   * them in 105, and car head units run well behind that. There, every
   * `cqh`/`cqw` length is invalid, so the whole HUD loses its dimensions and
   * the page is unusable even when the 3D side is fine.
   *
   * Computing them here costs one pass per resize and works everywhere.
   */
  function publishUnits(width, height) {
    const u = fillQuery.matches
      ? Math.min(width / 110, height / 200)
      : Math.min(height / 100, width / 279.4);
    container.style.setProperty('--u', `${u}px`);
    container.style.setProperty('--w', `${width / 100}px`);
  }

  function resize() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height) return;

    publishUnits(width, height);

    // Cap the device pixel ratio: beyond 2x the extra fragments buy nothing
    // visible on this kind of banner but cost a lot on dense mobile panels.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, RENDER.maxPixelRatio));
    renderer.setSize(width, height, false);

    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  /**
   * The design aspect, and how much the lens has to open to survive a
   * narrower one.
   *
   * A perspective camera's `fov` is *vertical*, so the horizontal extent is
   * `fov × aspect`. Filling a phone screen drops the aspect from 2.794 to
   * about 0.46, which would cut the horizontal view to a sixth and slice the
   * car off at both doors. Widening the vertical fov until the horizontal
   * extent matches the design keeps the whole car in frame; the picture shows
   * *more* above and below rather than less to the sides.
   */
  const DESIGN_ASPECT = 461 / 165;

  /** Vertical fov, in degrees, that preserves the design's horizontal view. */
  function framedFov(fov) {
    if (camera.aspect >= DESIGN_ASPECT) return fov;
    const halfWidth = Math.tan(THREE.MathUtils.degToRad(fov) / 2) * DESIGN_ASPECT;
    return THREE.MathUtils.radToDeg(2 * Math.atan(halfWidth / camera.aspect));
  }

  /**
   * Renders with the compensated lens, then puts the logical one back.
   *
   * Restoring matters: every subsystem writes `camera.fov` each frame and
   * several compare against what they last wrote, so leaving a widened value
   * on the camera would compound frame after frame.
   */
  function render() {
    const logical = camera.fov;
    const framed = framedFov(logical);
    if (framed !== logical) {
      camera.fov = framed;
      camera.updateProjectionMatrix();
    }
    renderer.render(scene, camera);
    camera.fov = logical;
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  window.addEventListener('resize', resize);
  resize();

  // ── State ────────────────────────────────────────────────────────────────
  let car = null;
  let boot = null;
  let drive = null;
  let tunnel = null;
  let street = null;
  let furniture = null;
  let streaks = null;
  let idle = null;
  let idleScene = null;
  let crew = null;

  let phase = Phase.BOOT;
  let phaseElapsed = 0;
  let autoDemoArmed = DRIVE.autoDemoMph !== null;
  /** Seconds the car has been continuously stationary, for the idle showcase. */
  let stillElapsed = 0;
  /** Launch tiering: decides which acceleration animation is playing. */
  const surge = new SurgeModel();
  /**
   * The cast.
   *
   * Heads come from the `Mii/` folder rather than from a customizer, so there
   * is nothing to build on first run: the driver is whichever Mii is named
   * Absar, or failing that the first one in the folder.
   *
   * The passenger is deliberately *not* remembered. Every boot starts with
   * nobody riding, so the opening screen always asks the same question rather
   * than quietly reinstating a choice made in some earlier session.
   *
   * And nobody stands by the car alone: with no passenger the driver is hidden
   * too, so the crew is either a pair or not there at all.
   */
  let miis = [];
  let passengerId = null;
  /** Set from either "Hide Miis" tick box; suppresses the crew outright. */
  let hideCrew = false;

  function driverMii() {
    return miis.find((m) => /^absar$/i.test(m.name)) ?? miis[0] ?? null;
  }

  function passengerMii() {
    if (!passengerId) return null;
    const found = miis.find((m) => m.id === passengerId);
    // The file may have been removed from the folder since it was chosen.
    if (!found) passengerId = null;
    return found ?? null;
  }

  /** Re-reads the folder and rebuilds whoever should be standing there. */
  async function refreshCast() {
    miis = await discoverMiis();
    const driver = driverMii();
    const passenger = passengerMii();

    hud.setPassengerOptions(
      miis.filter((m) => m !== driver),
      passenger?.url ?? null
    );
    hud.setPassenger(passenger?.name ?? null);
    hud.setHideCrew(hideCrew);

    // No passenger, or hidden on purpose: nobody is staged at all.
    const cast = hideCrew || !passenger ? [] : [driver, passenger];
    if (crew) await crew.setCast(cast);
  }

  /** Blend weight of the crew: 1 parked, 0 driving. */
  let crewMix = 0;
  /** When, if ever, this idle breaks off to look at the crew. */
  let crewLookAt = 0;
  let crewLookUntil = 0;
  const crewFocus = new THREE.Vector3();

  /** Road geometry: straight until a route or the sim panel bends it. */
  const road = new RoadModel();
  /** True while driving a picked route, so the speed planner takes over. */
  let routeDrive = false;
  /** Blend weight of the idle showcase, 0 in drive mode, 1 fully parked. */
  let idleMix = 0;

  let rafId = 0;
  let disposed = false;
  const clock = new THREE.Clock();

  // Snapshot of the camera at the instant the transition begins.
  const blendFrom = { position: new THREE.Vector3(), target: new THREE.Vector3() };
  const blendTo = { position: new THREE.Vector3(), target: new THREE.Vector3() };
  const scratch = new THREE.Vector3();
  const scratchUp = new THREE.Vector3();
  const blendFromUp = new THREE.Vector3(0, 1, 0);
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  let blendFromFov = CAMERA.fov;

  /** BOOT → TRANSITION: freeze the current framing as the blend's origin. */
  function beginTransition() {
    phase = Phase.TRANSITION;
    phaseElapsed = 0;

    blendFrom.position.copy(camera.position);
    blendFrom.target.copy(boot.cameraTarget);
    blendFromUp.copy(camera.up);
    blendFromFov = camera.fov;

    drive.anchor(boot.spin);
    tunnel.reset();
    street.reset();
  }

  /** TRANSITION/RESUME → DRIVE. */
  function beginDrive() {
    phase = Phase.DRIVE;
    phaseElapsed = 0;
    stillElapsed = 0;
    crewMix = 0;
    crew.setOpacity(0);
    hud.setOpacity(1);
    hud.setWelcomeOpacity(0);
    hud.setPassengerOpacity(0);
    idleMix = 0;
    idleScene.setOpacity(0);
    floor.setOpacity(1);
  }

  /**
   * DRIVE → SHOWCASE: the car has been parked long enough to present itself.
   *
   * The orbit is joined at whichever point on the loop is nearest the chase
   * camera, and the first couple of seconds are a blend from the chase pose
   * into it — so the hand-off is a move, never a cut.
   */
  function beginShowcase() {
    phase = Phase.SHOWCASE;
    phaseElapsed = 0;
    // The greeting belongs to the boot screen alone. Clearing it here matters
    // because the debug jump reaches the showcase without passing through the
    // transition that would otherwise have faded it.
    hud.setWelcomeOpacity(0);
    hud.setPassengerOpacity(0);
    // One scene, chosen at random, held for this whole idle.
    crew.pickScene();

    // Roll once per idle for whether the orbit detours onto the people, and if
    // so when. Rolling per idle rather than per lap keeps it an event.
    idle.setSubject(null);
    const [from, to] = IDLE.crewLook.delay;
    const wants = crew.members.length > 0 && Math.random() < IDLE.crewLook.chance;
    crewLookAt = wants ? from + Math.random() * (to - from) : Infinity;
    crewLookUntil = crewLookAt + IDLE.crewLook.duration;

    blendFrom.position.copy(camera.position);
    blendFrom.target.copy(drive.cameraTarget);
    blendFromUp.copy(camera.up);
    blendFromFov = camera.fov;

    idle.seekNearest(camera.position);
  }

  /** SHOWCASE → RESUME: it started rolling, so blend back to the chase view. */
  function beginResume() {
    phase = Phase.RESUME;
    phaseElapsed = 0;
    idle.setSubject(null);
    blendFrom.position.copy(camera.position);
    blendFrom.target.copy(idle.pose.target);
    blendFromUp.copy(camera.up);
    blendFromFov = camera.fov;
    street.reset();
    tunnel.reset();
    streaks.reset();
  }

  /** Back to the top of the sequence, from the sim panel's replay button. */
  function replayBoot() {
    if (!boot) return;
    autoDemoArmed = DRIVE.autoDemoMph !== null;
    speed.releaseSimulator();

    phase = Phase.BOOT;
    phaseElapsed = 0;

    boot.reset();
    hud.setWelcome(pickWelcome());
    crewMix = 0;
    // A replay is a boot, so it starts with nobody riding, exactly as a fresh
    // load does — otherwise the two would disagree about who is in the car.
    passengerId = null;
    refreshCast();
    crew.pickScene();
    tunnel.reset();
    tunnel.setOpacity(0);
    street.reset();
    street.setOpacity(0);
    streaks.reset();
    surge.reset();
    road.setStraight();
    furniture.clear();
    routeDrive = false;
    idleScene.setOpacity(0);
    idleMix = 0;
    floor.setOpacity(1);
    stillElapsed = 0;
    hud.setOpacity(0);
    hud.setFlare(0);
    camera.up.set(0, 1, 0);

    car.body.position.set(0, 0, 0);
    car.body.rotation.set(0, 0, 0);
  }

  // ── Per-phase updates ────────────────────────────────────────────────────

  function updateBoot(dt) {
    boot.update(dt);
    lights.follow(car.group.position, 0);

    // Background: the same wireframe showroom the idle display uses, so the car
    // is parked somewhere rather than floating in a void.
    idleScene.setOpacity(1);
    hud.setWelcomeOpacity(boot.welcomeFade);
    hud.setPassengerOpacity(boot.welcomeFade);

    // Parked, so the crew is out of the car. They fade up with the welcome
    // rather than the moment the model loads, so the opening frame is the car.
    crewMix = Math.min(1, crewMix + dt / CREW.fadeIn);
    crew.setOpacity(crewMix * boot.welcomeFade);
    crew.update(dt);

    // The sequence holds here for as long as the car is stationary. Only real
    // movement — a GPS fix, the sim panel, a picked route — ends it.
    if (!speed.isStopped) beginTransition();
  }

  function updateTransition(dt) {
    phaseElapsed += dt;
    const t = clamp(phaseElapsed / TRANSITION.duration, 0, 1);
    const k = easeInOutCubic(t);

    // The car is still parked through the blend; only the camera travels.
    // The crew goes first and quickly — nobody should still be standing there
    // as the road starts moving.
    crewMix = Math.max(0, crewMix - dt / CREW.fadeOut);
    crew.setOpacity(crewMix);
    crew.update(dt);
    hud.setPassengerOpacity(Math.max(0, 1 - k * 2));
    idleScene.setOpacity(1 - k);
    hud.setWelcomeOpacity(boot.welcomeFade * (1 - k * 2));

    // Resolve the live chase framing each frame rather than snapshotting it,
    // so the blend ends exactly where the drive phase will pick up.
    drive.resolveCamera(speed.mph, blendTo.position, blendTo.target);

    camera.position.copy(blendFrom.position).lerp(blendTo.position, k);
    scratch.copy(blendFrom.target).lerp(blendTo.target, k);
    camera.lookAt(scratch);

    // Ease the lens from wherever the boot left it to the speed-driven one.
    const fov = blendFromFov + (drive.resolveFov(speed.mph, surge.power) - blendFromFov) * k;
    camera.fov = fov;
    camera.updateProjectionMatrix();

    // The key light's offset rotates into the car's frame as the camera swings
    // behind it, so the chase view keeps its rim highlights.
    lights.follow(car.group.position, drive.heading * k);
    car.updateWheels(0, 0, 0);

    const fade = clamp((t - TRANSITION.hudFadeStart) / (1 - TRANSITION.hudFadeStart), 0, 1);
    resolveLayers(dt, fade);
    hud.setOpacity(fade);

    if (t >= 1) beginDrive();
  }

  /**
   * Decides which scene layer is showing, and by how much.
   *
   * The streetscape is the resting state; the acceleration layers are an event.
   * Both are driven by the launch tiering in surge.js rather than by speed, so
   * cruising at 120 shows trees and buildings while a hard pull from a
   * standstill lights the rings and streaks — and the same speed gained gently
   * shows nothing at all.
   *
   * @param {number} dt seconds
   * @param {number} strength 0..1 master fade for the whole scene
   */
  function resolveLayers(dt, strength) {
    const power = surge.power;

    tunnel.setOpacity(strength * clamp(power * 3, 0, 1));
    // The street never fades out completely under warp: something has to carry
    // the road while the rings flash past, or the car floats in the void.
    street.setOpacity((1 - power * (1 - WARP.streetDim)) * strength);

    tunnel.update(dt, speed.mph, power, drive.cameraLocalZ, road);
    street.update(dt, speed.mph, road);
    // Real furniture keeps its own brightness: it is information, not scenery,
    // so it does not dim away behind the warp the way the streetscape does.
    furniture.setOpacity(strength);
    furniture.update(road);
    streaks.update(dt, speed.mph, power, strength);

    // Tier 4 only: heat bleeding in from the frame edges, punched by the pulse
    // fired at each promotion.
    const flare = surge.tierWeight(4) * (0.55 + surge.pulse * 0.45) * strength;
    hud.setFlare(flare);
  }

  function updateDrive(dt) {
    phaseElapsed += dt;

    // With no real fix and no operator input, ease up to a demo speed so the
    // reveal lands on a live HUD instead of a static zero.
    if (autoDemoArmed && phaseElapsed >= DRIVE.autoDemoDelay) {
      autoDemoArmed = false;
      speed.setDemo(DRIVE.autoDemoMph);
    }

    // The road advances first: the car, camera and every layer below read the
    // same centreline within a single frame, so nothing lags a frame behind.
    road.update(dt, speed.mph);
    planRouteSpeed();
    drive.update(dt, speed, surge, road);
    lights.follow(car.group.position, drive.heading);
    resolveLayers(dt, 1);

    // Park for long enough and the piece stops driving and starts presenting.
    stillElapsed = speed.isStopped ? stillElapsed + dt : 0;
    if (stillElapsed >= IDLE.holdSeconds) beginShowcase();
  }

  function updateShowcase(dt) {
    phaseElapsed += dt;

    // The orbit runs from the first frame; the entry blend only decides how
    // much of it the camera is allowed to have yet.
    idle.update(dt);

    const entry = clamp(phaseElapsed / IDLE.enterDuration, 0, 1);
    const k = easeInOutCubic(entry);

    if (entry < 1) {
      // Blend from the chase pose into the live orbit pose. The target is
      // moving, so this lands on the loop rather than on a stale snapshot.
      const pose = idle.pose;
      camera.position.copy(blendFrom.position).lerp(pose.position, k);
      scratch.copy(blendFrom.target).lerp(pose.target, k);
      scratchUp.copy(blendFromUp).lerp(pose.up, k).normalize();
      camera.up.copy(scratchUp);
      camera.lookAt(scratch);
      camera.fov = blendFromFov + (pose.fov - blendFromFov) * k;
      camera.updateProjectionMatrix();
    }

    // Showroom and telemetry crossfade over the same blend.
    idleMix = k;
    idleScene.setOpacity(idleMix);
    floor.setOpacity(1 - idleMix);
    furniture.setOpacity(1 - idleMix);

    // Everyone gets out once the showcase takes over.
    crewMix = Math.min(1, crewMix + dt / CREW.fadeIn);
    crew.setOpacity(crewMix * idleMix);
    crew.update(dt);
    street.setOpacity((1 - idleMix) * 0.4);
    tunnel.setOpacity(0);
    streaks.update(dt, 0, 0, 0);
    hud.setOpacity(1 - idleMix);
    hud.setFlare(0);

    // The car is parked: wheels still, body level, but still re-planted so the
    // overhead and close passes have all four tyres exactly on the ground.
    car.body.position.set(0, 0, 0);
    car.body.rotation.set(0, 0, 0);
    car.updateWheels(drive.spin, 0, 0);
    lights.follow(car.group.position, drive.heading);

    if (!speed.isStopped) beginResume();
  }

  function updateResume(dt) {
    phaseElapsed += dt;
    const t = clamp(phaseElapsed / IDLE.resumeDuration, 0, 1);
    const k = easeInOutCubic(t);

    road.update(dt, speed.mph);
    drive.update(dt, speed, surge, road);

    // drive.update() has already written the live chase pose; blend back from
    // the orbit framing towards it rather than cutting.
    drive.resolveCamera(speed.mph, blendTo.position, blendTo.target);
    camera.position.copy(blendFrom.position).lerp(blendTo.position, k);
    scratch.copy(blendFrom.target).lerp(blendTo.target, k);
    scratchUp.copy(blendFromUp).lerp(WORLD_UP, k).normalize();
    camera.up.copy(scratchUp);
    camera.lookAt(scratch);

    camera.fov = blendFromFov + (drive.resolveFov(speed.mph, surge.power) - blendFromFov) * k;
    camera.updateProjectionMatrix();

    lights.follow(car.group.position, drive.heading);

    idleMix = 1 - k;
    idleScene.setOpacity(idleMix);
    floor.setOpacity(k);

    crewMix = Math.max(0, crewMix - dt / CREW.fadeOut);
    crew.setOpacity(crewMix);
    resolveLayers(dt, k);
    hud.setOpacity(k);

    if (t >= 1) {
      camera.up.copy(WORLD_UP);
      beginDrive();
    }
  }

  // ── Loop ─────────────────────────────────────────────────────────────────
  function frame() {
    rafId = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), MAX_DELTA);

    // Speed and launch tiering run in every phase, so a pull started during
    // the boot sequence is already under way when drive mode takes over.
    speed.update(dt);
    surge.update(dt, speed);

    if (phase === Phase.BOOT) updateBoot(dt);
    else if (phase === Phase.TRANSITION) updateTransition(dt);
    else if (phase === Phase.SHOWCASE) updateShowcase(dt);
    else if (phase === Phase.RESUME) updateResume(dt);
    else updateDrive(dt);

    hud.update(speed, surge.power);
    render();
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  const ready = loadCar(studio.envMap, onProgress)
    .then(async (loaded) => {
      if (disposed) {
        loaded.dispose();
        return;
      }
      car = loaded;
      scene.add(car.group);

      drive = new DriveMode(scene, car, camera);
      tunnel = new WarpTunnel(drive.rig);
      tunnel.setOpacity(0);
      street = new Streetscape(drive.rig);
      street.setOpacity(0);
      furniture = new RoadFurniture(drive.rig);
      furniture.setOpacity(0);
      streaks = new SpeedStreaks(drive.rig, road);
      idle = new IdleShowcase(drive.rig, camera);
      idleScene = new IdleScene(drive.rig);

      // The boot sequence needs the rig in place, because the showroom it uses
      // as a backdrop is parented to it.
      boot = new BootSequence(car, camera);
      hud.setWelcome(pickWelcome());

      crew = new Crew(drive.rig);
      crew.setOpacity(0);
      // Reading the folder is a network round trip; the boot sequence starts
      // without waiting and the crew fades in whenever they arrive.
      refreshCast();

      // Warm-up pass. This model is 200+ meshes and 40 textures; compiling
      // their programs and uploading their textures lazily, on the frames where
      // they first become visible, is exactly what makes an intro hitch. Doing
      // it up front — before the clock starts — costs a moment of black screen
      // and buys a clean first second.
      if (renderer.compileAsync) await renderer.compileAsync(scene, camera);
      else renderer.compile(scene, camera);
      if (disposed) return;
      render();

      onReady?.();

      clock.start();
      rafId = requestAnimationFrame(frame);
    })
    .catch((error) => {
      console.error('[showcase] failed to load the vehicle asset:', error);
      // Say so on the page. A console message is no use on a car head unit or
      // a phone, which is exactly where this fails.
      window.__showcaseFail?.(
        `The car model (bmw.glb) failed to load: ${error?.message ?? error}`
      );
      throw error;
    });

  // ── Teardown ─────────────────────────────────────────────────────────────
  function dispose() {
    if (disposed) return;
    disposed = true;

    cancelAnimationFrame(rafId);
    resizeObserver.disconnect();
    window.removeEventListener('resize', resize);

    speed.dispose();
    spotify.dispose();
    hud.dispose();
    tunnel.dispose();
    drive?.dispose();
    car?.dispose();
    floor.dispose();
    lights.dispose();
    studio.dispose();
    scene.environment = null;
    scene.clear();
    renderer.dispose();
    renderer.forceContextLoss?.();
  }

  return {
    scene,
    camera,
    renderer,
    ready,
    dispose,
    replayBoot,
    /**
     * Road geometry. Feed real navigation data with
     * `showcase.road.setRoute([{lat, lon}, …])`; the bends in it are then
     * anticipated as the car reaches them. `setStraight()` clears it.
     */
    road,
    /** The UK route simulator overlay. */
    mapPicker,
    /** The people standing around the car while it is parked. */
    get crew() {
      return crew;
    },
    /** Re-reads the Mii folder and rebuilds the cast. */
    refreshCast,
    /** The opening sequence, for replay and inspection. */
    get boot() {
      return boot;
    },
    /** The parked-camera orbit, for inspection. */
    get idleOrbit() {
      return idle;
    },
    /** The DOM overlay, for inspection. */
    hud,
    /**
     * Traffic signals and speed cameras. Supply your own with
     * `furniture.setItems([{type:'signal'|'camera', distance, lateral}, …])`
     * where distance is metres along the route and lateral is metres right of
     * the centreline — no OSM round-trip required.
     */
    get furniture() {
      return furniture;
    },
  };
}

// ── Page bootstrap ─────────────────────────────────────────────────────────
const container = document.getElementById('stage');
const canvas = document.getElementById('canvas');
const loader = document.getElementById('loader');
const loaderBar = document.getElementById('loaderBar');

const showcase = createShowcase({
  container,
  canvas,
  onProgress: (p) => {
    loaderBar.style.width = `${Math.round(p * 100)}%`;
  },
  onReady: () => {
    loaderBar.style.width = '100%';
    loader.classList.add('is-hidden');
    // Drop it from the tree once the fade has played out.
    setTimeout(() => loader.remove(), 700);
  },
});

/**
 * Exposed for scripting and inspection: `bmwShowcase.road.setRoute([...])`
 * feeds real navigation data, `bmwShowcase.mapPicker.open()` raises the UK
 * route simulator, and `bmwShowcase.dispose()` tears everything down.
 */
window.bmwShowcase = showcase;

// Release the context if the page is torn down (bfcache / SPA navigation).
window.addEventListener('pagehide', () => showcase.dispose(), { once: true });
