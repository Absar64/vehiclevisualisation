/**
 * crew.js — the people, and what they do while the car is parked.
 *
 * Absar and an optional passenger stand around the car whenever it is
 * stationary, and fade out entirely the moment it moves: the driving view is
 * about telemetry, road geometry and the tunnel, and figures pinned to a car
 * doing 90 mph would be both wrong and a distraction.
 *
 * **One scene per idle.** A scene is picked at random each time the car settles
 * and holds for that whole idle — nothing rotates or shuffles underneath you.
 * The pool is filtered by who is actually present, which is how the two-hander
 * stays out of it when Absar is driving alone.
 *
 * A scene gives each person a mark, a pose and optionally a prop, plus a small
 * looping overlay. The overlay is what keeps a figure from reading as a
 * mannequin: a draw on a cigar, the recoil of a shutter, a head turning
 * mid-sentence.
 *
 * Marks are in the car's own frame, so they hold wherever it ended up:
 * +X is the car's nearside, +Z its nose.
 */

import * as THREE from 'three';
import { clamp } from './spring.js';
import { Avatar } from './avatar.js';
import { loadMiiHead } from './miiLibrary.js';

// ── Props ──────────────────────────────────────────────────────────────────

/**
 * Cigar smoke.
 *
 * Puffs rise from the tip, swell, drift and fade, then restart from the bottom.
 * Recycling a fixed pool means it runs for as long as the idle lasts without
 * allocating anything.
 */
class Smoke {
  constructor(count = 7) {
    this.group = new THREE.Group();
    this.geometry = new THREE.SphereGeometry(0.5, 8, 6);
    this.puffs = [];

    for (let i = 0; i < count; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xb9bfc8,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      // Staggered, so the column is already continuous on the first frame.
      this.puffs.push({ mesh, material, life: i / count, drift: (i % 3) - 1 });
    }
  }

  /**
   * @param {number} dt seconds
   * @param {number} opacity master crew fade
   * @param {THREE.Quaternion} [uprightFix] cancels the holder's rotation, so
   *   smoke rises in world up rather than along a raised arm
   */
  update(dt, opacity, uprightFix) {
    if (uprightFix) this.group.quaternion.copy(uprightFix);

    for (const puff of this.puffs) {
      puff.life += dt * 0.34;
      if (puff.life > 1) puff.life -= 1;

      const t = puff.life;
      puff.mesh.scale.setScalar(0.02 + t * 0.095);
      puff.mesh.position.set(
        puff.drift * t * 0.05 + Math.sin(t * 6 + puff.drift) * 0.012,
        t * 0.34,
        Math.cos(t * 5 + puff.drift) * 0.012
      );
      // In off the tip, away again at the top of the rise.
      puff.material.opacity = Math.sin(t * Math.PI) * 0.42 * opacity;
    }
  }

  dispose() {
    this.geometry.dispose();
    for (const puff of this.puffs) puff.material.dispose();
  }
}

function buildCigar(materials) {
  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.013, 0.1, 8), materials.cigar);
  body.rotation.z = Math.PI / 2;
  group.add(body);

  const ember = new THREE.Mesh(new THREE.SphereGeometry(0.013, 8, 6), materials.ember);
  ember.position.x = 0.052;
  group.add(ember);

  const smoke = new Smoke();
  smoke.group.position.x = 0.056;
  group.add(smoke.group);
  group.userData.smoke = smoke;

  return group;
}

function buildCamera(materials) {
  const group = new THREE.Group();

  group.add(new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.085, 0.06), materials.gear));

  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 0.045, 12), materials.gear);
  lens.rotation.x = Math.PI / 2;
  lens.position.z = 0.05;
  group.add(lens);

  // The flash is a bulb that blows out *and* a light that actually reaches the
  // car. A glowing quad on its own reads as a sticker; the point light is what
  // makes the paint answer back.
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.02, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 })
  );
  bulb.position.set(0.045, 0.055, 0.03);
  group.add(bulb);

  const light = new THREE.PointLight(0xdbe8ff, 0, 9, 2);
  light.position.copy(bulb.position);
  group.add(light);

  group.userData.flash = { bulb, light };
  return group;
}

function buildGun(materials) {
  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.052, 0.13), materials.gear);
  body.position.z = 0.03;
  group.add(body);

  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.1), materials.gear);
  barrel.position.z = 0.12;
  group.add(barrel);

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.095, 0.05), materials.grip);
  grip.position.set(0, -0.06, -0.01);
  grip.rotation.x = -0.22;
  group.add(grip);

  return group;
}

const PROPS = { cigar: buildCigar, camera: buildCamera, gun: buildGun };

// ── Scenes ─────────────────────────────────────────────────────────────────

/**
 * `pair: true` means the scene needs two people and is left out of the pool
 * otherwise. Everything else works alone, and a second person joins in.
 *
 * A mark says *what it is looking at* — `car`, or the other person — and the
 * heading is derived from that. Writing headings by hand is how two of these
 * scenes ended up facing a full 180° the wrong way: an angle in radians gives
 * no clue which way it points, whereas "look at the car" cannot be wrong.
 *
 * Marks sit beside the car's nearside, on a radius of about 2.9–3.2 m. That
 * radius is the whole trick to staging them, and it is bounded on both sides:
 *
 *  - **Inside 2.3 m** is the car. A 3-series is 1.83 m wide, so anything nearer
 *    the centreline than about 0.95 m stands in the bodywork.
 *  - **Outside about 3.3 m** is the camera. The idle orbit runs at a ground
 *    radius of roughly 5.7 m, so a mark at 4–5 m passes within a metre of the
 *    lens as the orbit comes round — the earlier photo marks cleared it by
 *    0.40 m, which is to say the camera flew through somebody's head.
 *
 * At ~3 m the worst case is a 2.6 m foreground pass, which frames a whole
 * figure rather than filling the screen with a shoulder, and for the rest of
 * the lap they read as people stood at the car rather than in front of it.
 */
export const SCENES = {
  cigar: {
    label: 'smoking a cigar',
    roles: [
      { mark: { x: 2.55, z: 1.55, look: 'out' }, prop: 'cigar', hand: 'right', pose: 'smoke', propOffset: [0, 0, 0] },
      { mark: { x: 2.95, z: 0.35, look: 'out' }, prop: 'cigar', hand: 'right', pose: 'smoke', propOffset: [0, 0, 0] },
    ],
  },
  photo: {
    label: 'photographing the car',
    roles: [
      // Stood off the front wing and aimed squarely back at the car.
      { mark: { x: 2.35, z: 2.05, look: 'car' }, prop: 'camera', hand: 'right', pose: 'photo', propRotation: [1.55, 0, 0] },
      { mark: { x: 3.0, z: 0.95, look: 'car' }, prop: 'camera', hand: 'right', pose: 'photo', propRotation: [1.55, 0, 0] },
    ],
  },
  talking: {
    label: 'talking, facing away from the car',
    roles: [
      // Backs to the car, looking out at the city.
      { mark: { x: 2.5, z: 1.4, look: 'out' }, pose: 'talk' },
      { mark: { x: 2.95, z: 0.3, look: 'out' }, pose: 'listen' },
    ],
  },
  standoff: {
    label: 'pointing a gun at the passenger',
    pair: true,
    roles: [
      { mark: { x: 2.4, z: 1.9, look: 'other' }, prop: 'gun', hand: 'right', pose: 'aim', propRotation: [1.62, 0, 0] },
      { mark: { x: 3.05, z: 0.5, look: 'other' }, pose: 'handsUp' },
    ],
  },
};

/**
 * Heading that points a mark at whatever it is supposed to be looking at.
 *
 * Avatars face +Z at rotation.y = 0, so a heading of θ faces (sin θ, cos θ) —
 * which is exactly atan2(dx, dz) toward the target.
 */
function headingFor(mark, other) {
  let tx = 0;
  let tz = 0;
  if (mark.look === 'other' && other) {
    tx = other.x;
    tz = other.z;
  } else if (mark.look === 'out') {
    // Away from the car: the target is the mark pushed further out.
    tx = mark.x * 2;
    tz = mark.z * 2;
  }
  return Math.atan2(tx - mark.x, tz - mark.z);
}

// Scratch for the per-frame prop aim below.
const _qHand = new THREE.Quaternion();
const _qTorso = new THREE.Quaternion();
const _qTilt = new THREE.Quaternion();
const _axisX = new THREE.Vector3(1, 0, 0);
/** Props are modelled lying along +X; this turns that into the body's +Z. */
const _propForward = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.PI / 2, 0));

/**
 * Points a held prop along the character's own forward axis, every frame.
 *
 * `propRotation` cancels a *fixed* arm angle, which is all a camera or a gun
 * needs because those arms are held still. The cigar arm is not still: it
 * swings through about 75° between the hip and the mouth, so no constant
 * rotation can keep the cigar level at both ends of the draw — set it right at
 * the mouth and it is sideways at the hip. Re-deriving the orientation from
 * the hand each frame is what actually holds a cigar the way a hand holds one.
 */
function aimPropForward(avatar, prop, tilt = 0) {
  avatar.group.updateMatrixWorld(true);
  prop.parent.getWorldQuaternion(_qHand);
  avatar.torso.getWorldQuaternion(_qTorso);
  prop.quaternion.copy(_qHand).invert().multiply(_qTorso);
  if (tilt) prop.quaternion.multiply(_qTilt.setFromAxisAngle(_axisX, tilt));
  prop.quaternion.multiply(_propForward);
}

/**
 * Poses.
 *
 * Arms are two segments with a hinge between, so a raise is a shoulder swing
 * and an elbow fold agreeing with each other. The angles for the cigar draw
 * were not written by hand — they are a two-bone IK solution for putting the
 * hand at the mouth with the elbow clear of the chest, which is a thing worth
 * solving rather than guessing at.
 */
const POSES = {
  smoke: {
    base: {
      armL: [0.05, 0, 0.12],
      // Held a little further off the body than the other poses: the resting
      // arm otherwise grazes the torso, and this is the one pose where an arm
      // sits still at the side long enough for anyone to notice.
      armR: [0.2, 0, -0.24],
      legL: [0.02, 0, 0.05],
      legR: [-0.02, 0, -0.05],
    },
    animate(avatar, t, prop) {
      // A long draw: up to the mouth, hold, down, then the head tips back.
      const cycle = (t % 11) / 11;
      const raise =
        cycle < 0.16 ? cycle / 0.16 : cycle < 0.3 ? 1 : cycle < 0.46 ? 1 - (cycle - 0.3) / 0.16 : 0;
      const eased = raise * raise * (3 - 2 * raise);

      // Solved, not guessed: this is the two-bone IK answer for the hand at the
      // corner of the mouth — (-0.09, 0.55, 0.26) in torso space, just under
      // the nose — with the elbow hanging forward and a little below the
      // shoulder so neither bone crosses the chest. Reaching the mouth is
      // mostly the *elbow's* job; the shoulder only lifts the arm to meet it.
      const arm = avatar.arms.right;
      arm.shoulder.rotation.x = 0.2 - eased * 1.507;
      arm.shoulder.rotation.y = eased * 0.139;
      // The z swing also bows outward mid-travel. Interpolating it straight
      // takes the upper arm through the ribs on the way past; a hand goes out
      // and around on its way to the face, which both clears the chest and is
      // what the movement actually looks like.
      arm.shoulder.rotation.z = -0.24 + eased * 0.342 - Math.sin(Math.PI * eased) * 0.18;
      arm.elbow.rotation.x = -eased * 1.55;

      // The cigar points the way the character faces, wherever the arm is.
      if (prop) aimPropForward(avatar, prop, -0.12);

      avatar.head.rotation.x = cycle > 0.46 && cycle < 0.62 ? -0.26 : -0.02;
      avatar.torso.rotation.y = Math.sin(t * 0.55) * 0.07;
    },
  },

  photo: {
    base: {
      // Both arms forward and angled *inward*, so the hands meet in front of
      // the face and the camera sits between them rather than off on one side.
      armL: [-1.55, 0, -0.26],
      armR: [-1.55, 0, 0.26],
      head: [-0.04, 0, 0],
      legL: [0.03, 0, 0.05],
      legR: [-0.02, 0, -0.05],
    },
    animate(avatar, t, prop) {
      const frame = Math.sin(t * 0.6) * 0.08;
      // A shutter every few seconds: a spike, a recoil, the flash with it.
      const shot = clamp(Math.max(0, Math.sin(t * 0.72) - 0.992) * 125, 0, 1);
      avatar.arms.left.shoulder.rotation.x = -1.55 + frame - shot * 0.06;
      avatar.arms.right.shoulder.rotation.x = -1.55 + frame - shot * 0.06;
      avatar.torso.rotation.y = Math.sin(t * 0.42) * 0.12;
      avatar.head.rotation.x = -0.05 - shot * 0.04;

      const flash = prop?.userData?.flash;
      if (flash) {
        flash.bulb.material.opacity = shot;
        flash.light.intensity = shot * 26;
      }
    },
  },

  talk: {
    base: {
      armL: [0.08, 0, 0.14],
      armR: [0.1, 0, -0.2],
      legL: [0.02, 0, 0.06],
      legR: [-0.02, 0, -0.04],
    },
    animate(avatar, t) {
      const beat = Math.sin(t * 1.9) * 0.5 + Math.sin(t * 3.2 + 1.1) * 0.2;
      avatar.head.rotation.y = -0.3 + beat * 0.26;
      avatar.head.rotation.x = Math.sin(t * 2.4) * 0.05;
      avatar.arms.right.shoulder.rotation.x = 0.1 - Math.abs(Math.sin(t * 2.1)) * 0.8;
      avatar.arms.right.shoulder.rotation.z = -0.2 - Math.abs(Math.sin(t * 2.1)) * 0.3;
      avatar.torso.rotation.y = Math.sin(t * 1.05) * 0.06;
    },
  },

  listen: {
    base: {
      armL: [0.06, 0, 0.13],
      armR: [0.06, 0, -0.13],
      legL: [0.02, 0, 0.05],
      legR: [-0.02, 0, -0.05],
    },
    animate(avatar, t) {
      avatar.head.rotation.y = 0.34 + Math.sin(t * 0.8) * 0.1;
      avatar.head.rotation.x = Math.max(0, Math.sin(t * 1.4)) ** 3 * 0.16; // the odd nod
      avatar.torso.rotation.y = Math.sin(t * 0.7) * 0.04;
    },
  },

  aim: {
    base: {
      // Straight out at shoulder height: the whole limb rotated, not a
      // shoulder and an elbow negotiating.
      armR: [-1.62, 0, -0.16],
      armL: [0.1, 0, 0.2],
      head: [0, -0.12, 0],
      legL: [0.04, 0, 0.07],
      legR: [-0.06, 0, -0.05],
    },
    animate(avatar, t) {
      // Held steady, with the drift of an arm out too long.
      avatar.arms.right.shoulder.rotation.x = -1.62 + Math.sin(t * 0.9) * 0.035;
      avatar.arms.right.shoulder.rotation.z = -0.16 + Math.sin(t * 0.7) * 0.02;
      avatar.head.rotation.y = -0.12 + Math.sin(t * 0.5) * 0.03;
      avatar.torso.rotation.y = Math.sin(t * 0.45) * 0.03;
    },
  },

  handsUp: {
    base: {
      armL: [-2.5, 0, 0.5],
      armR: [-2.5, 0, -0.5],
      head: [0.06, 0, 0],
      legL: [0.02, 0, 0.08],
      legR: [-0.02, 0, -0.08],
    },
    animate(avatar, t) {
      avatar.arms.left.shoulder.rotation.x = -2.5 + Math.sin(t * 1.6) * 0.06;
      avatar.arms.right.shoulder.rotation.x = -2.5 + Math.sin(t * 1.6 + 0.8) * 0.06;
      avatar.torso.rotation.x = 0.04 + Math.sin(t * 1.1) * 0.02;
      avatar.head.rotation.y = Math.sin(t * 0.9) * 0.08;
    },
  },
};

const SCENE_IDS = Object.keys(SCENES);

export class Crew {
  /** @param {THREE.Object3D} parent the drive rig, aligned with the car */
  constructor(parent) {
    this.group = new THREE.Group();
    parent.add(this.group);

    /** @type {{avatar:Avatar, pose:string|null, clock:number, prop:THREE.Object3D|null}[]} */
    this.members = [];
    this.opacity = 0;
    this.scene = null;

    this.propMaterials = {
      gear: new THREE.MeshStandardMaterial({ color: 0x14171d, roughness: 0.42, metalness: 0.35, transparent: true }),
      grip: new THREE.MeshStandardMaterial({ color: 0x2a2320, roughness: 0.7, metalness: 0.05, transparent: true }),
      cigar: new THREE.MeshStandardMaterial({ color: 0x6a4a2f, roughness: 0.85, metalness: 0, transparent: true }),
      ember: new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true }),
    };
    this.props = [];
    this._upright = new THREE.Quaternion();
  }

  /**
   * Rebuilds the crew from a list of Miis.
   *
   * Heads are fetched and cached by the library, so this is async — and it
   * guards against being overtaken: picking a passenger twice in quick
   * succession must not leave the loser's avatar in the scene.
   *
   * @param {{name:string, url:string}[]} miis one or two entries
   */
  async setCast(miis) {
    const token = Symbol('cast');
    this._castToken = token;

    const entries = miis.filter(Boolean);
    const loaded = await Promise.all(
      entries.map((mii) => loadMiiHead(mii.url).then((head) => ({ mii, head })).catch(() => null))
    );
    if (this._castToken !== token) return;

    this.clear();
    for (const entry of loaded) {
      if (!entry) continue;
      const avatar = new Avatar(entry.mii, entry.head);
      this.group.add(avatar.group);
      this.members.push({ avatar, pose: null, clock: Math.random() * 20, prop: null });
    }
    this.pickScene();
    this.setOpacity(this.opacity);
  }

  /** Names currently in the scene, driver first. */
  get names() {
    return this.members.map((m) => m.avatar.name);
  }

  /**
   * Chooses one scene at random and stages it.
   *
   * Called when the car settles, never on a timer: a scene holds for the whole
   * idle. Scenes needing two people are excluded when Absar is alone, which is
   * what keeps the two-hander from playing to an empty mark.
   */
  pickScene() {
    if (!this.members.length) return;

    const usable = SCENE_IDS.filter((id) => this.members.length >= 2 || !SCENES[id].pair);
    if (!usable.length) return;

    this.scene = usable[Math.floor(Math.random() * usable.length)];
    this._stage(SCENES[this.scene]);
  }

  _stage(scene) {
    this.members.forEach((member, index) => {
      const role = scene.roles[index] ?? scene.roles[scene.roles.length - 1];
      const pose = POSES[role.pose];

      member.pose = role.pose;
      member.clock = Math.random() * 20;

      // Whoever this person is meant to be looking at, if anyone.
      const otherRole = scene.roles[index === 0 ? 1 : 0];

      const { avatar } = member;
      avatar.restPose();
      avatar.setPose(pose.base);
      avatar.group.position.set(role.mark.x, 0, role.mark.z);
      avatar.group.rotation.y = headingFor(role.mark, otherRole?.mark);

      this._giveProp(member, role);
    });
  }

  _giveProp(member, role) {
    if (member.prop) {
      member.prop.userData?.smoke?.dispose();
      member.prop.removeFromParent();
      this.props = this.props.filter((p) => p !== member.prop);
      member.prop = null;
    }
    if (!role.prop) return;

    const prop = PROPS[role.prop](this.propMaterials);
    const hand = role.hand === 'left' ? member.avatar.arms.left.hand : member.avatar.arms.right.hand;
    hand.add(prop);
    // The default sits the prop just beyond the fingers. A cigar wants the
    // hand's own centre instead: it is modelled about its grip, so centring it
    // puts the lit end forward and the mouth end back where the lips are, and
    // an offset down the arm would drag it out of the mouth as the arm swings.
    const offset = role.propOffset ?? [0, -0.05, 0.02];
    prop.position.set(offset[0], offset[1], offset[2]);

    // A prop inherits the whole arm's rotation, so a camera or a gun held on a
    // raised arm ends up aimed at the sky. `propRotation` cancels that, leaving
    // the lens or the barrel pointing where the character is looking.
    if (role.propRotation) {
      prop.rotation.set(role.propRotation[0], role.propRotation[1], role.propRotation[2]);
    }

    member.prop = prop;
    this.props.push(prop);
  }

  /**
   * Middle of the group, in the rig's frame, lifted to head height.
   * The idle camera uses it when it breaks off to look at the people.
   *
   * @param {THREE.Vector3} out
   * @returns {THREE.Vector3|null} null when nobody is standing there
   */
  centroid(out) {
    if (!this.members.length) return null;
    out.set(0, 0, 0);
    for (const member of this.members) out.add(member.avatar.group.position);
    out.divideScalar(this.members.length);
    out.y = 1.05;
    return out;
  }

  /** Master fade. Driving hides them completely. */
  setOpacity(value) {
    this.opacity = clamp(value, 0, 1);
    this.group.visible = this.opacity > 0.01;
    for (const member of this.members) member.avatar.setOpacity(this.opacity);
    for (const material of Object.values(this.propMaterials)) material.opacity = this.opacity;

    // A flash or an ember left burning behind a faded-out crew would hang in
    // the air on its own, so the emissive parts are cleared with them.
    if (this.opacity <= 0.01) {
      for (const prop of this.props) {
        const flash = prop.userData?.flash;
        if (!flash) continue;
        flash.light.intensity = 0;
        flash.bulb.material.opacity = 0;
      }
    }
  }

  /** @param {number} dt seconds */
  update(dt) {
    if (!this.group.visible) return;

    for (const member of this.members) {
      member.clock += dt;
      POSES[member.pose]?.animate(member.avatar, member.clock, member.prop);

      const smoke = member.prop?.userData?.smoke;
      if (smoke) {
        member.prop.getWorldQuaternion(this._upright).invert();
        smoke.update(dt, this.opacity, this._upright);
      }
    }
  }

  clear() {
    for (const member of this.members) {
      member.prop?.userData?.smoke?.dispose();
      member.avatar.dispose();
    }
    this.members.length = 0;
    this.props.length = 0;
  }

  dispose() {
    this.clear();
    this.group.removeFromParent();
    for (const material of Object.values(this.propMaterials)) material.dispose();
  }
}
