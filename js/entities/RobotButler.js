// js/entities/RobotButler.js
//
// A decorative NPC beside the astronaut's shelter: paces back and forth
// along a fixed stretch of the sky dome's own flat deck, walking right
// to the far end of its patrol range, then back left to its own home
// point, forever. Purely background flavor, same role SpaceShelter.js
// itself plays — no collision, not a lock-on/pull target, doesn't
// appear in state.ooombas (that list's own patrol logic walks a
// TerrainShape's arc length; this one just walks a fixed X range on
// flat ground, which doesn't need any of that machinery).
//
// Sprite sheet (img/Robot2.png, loaded as state.robotTexture): 4000x1200,
// four 1000x1200 walking frames in a single row. The art faces LEFT by
// default — walking right mirrors it horizontally, same convention
// Ooomba.js's own sprite already uses.

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import DustPuff from '../effects/DustPuff.js';
import Script from '../systems/Script.js';
import CameraDirector from '../systems/CameraDirector.js';
import worldGen from '../setup/WorldGen.js';
import DialogueBox from '../ui/DialogueBox.js';
import InteractPrompt from '../ui/InteractPrompt.js';

const FRAME_COUNT = 4;

// 100ms per animation frame, expressed in 60fps-baseline ticks (see
// main.js's own frameNorm/timeScale comment) rather than raw
// milliseconds, so it advances correctly whether the game (and
// V.A.T.S.'s own slow-mo) is running at normal speed or not:
// 0.1s * 60 ticks/s = 6.
const FRAME_TICKS = 6;

// Odds of spawning a dust puff on any given 60fps-baseline tick while
// moving (see the continuous-trickle comment in update below).
const DUST_SPAWN_CHANCE = 0.3;

// Baked once, shared by every RobotButler instance.
let frameQuads = null;
let sheetFrameW = null, sheetFrameH = null;

function ensureFrameQuads(img) {
  if (frameQuads) return;
  const [fullW, fullH] = img.getDimensions();
  sheetFrameW = fullW / FRAME_COUNT;
  sheetFrameH = fullH;
  frameQuads = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    frameQuads[i] = love.graphics.newQuad(i * sheetFrameW, 0, sheetFrameW, sheetFrameH, fullW, fullH);
  }
}

// Keyed into state.scriptsCompleted — true once the one-time
// welcome/tour sequence below has played all the way through, so every
// interaction after that just gets startDialogue's plain "Hello again!".
const INTRO_SCRIPT_ID = 'robotButlerIntro';

// The one-time welcome/tour sequence (see Script.js/CameraDirector.js)
// played the FIRST time the player ever talks to him. Built lazily,
// since it reads state.skyDomePlanet/state.beams.
function buildIntroScript() {
  const dome = state.skyDomePlanet;
  const beam = state.beams && state.beams[0]; // homeBeam — sits just left of the shelter, on the dome's own deck
  const screenW = love.graphics.getWidth();

  const beats = [{ text: 'Welcome to a demo of Asteroid Bob!' }];

  if (dome) {
    // Zoomed out until the whole dome's width fits on screen, with a
    // little breathing room either side, centered on the dome itself.
    const fitZoom = screenW / (dome.halfWidth * 2 * 1.35);
    beats.push({
      text: "Right now you're standing in a domed playground",
      camera: [{ x: dome.pos.x, y: dome.domeAnchorY(), zoom: fitZoom, duration: 2.5 }],
    });

    // A slow pan across the deck — reading as a tour THROUGH the dome.
    // cameraLoop: keeps repeating for as long as this line is up; only
    // the player's own next Enter/Circle press stops it.
    const deckY = dome.trueSurfaceY();
    const panZoom = 1;
    beats.push({
      text: "It's a perfect place for showcasing Bob's abilities!",
      camera: [
        { x: dome.pos.x - dome.halfWidth * 0.6, y: deckY, zoom: panZoom, duration: 2.0 },
        { x: dome.pos.x - dome.halfWidth * 0.3, y: deckY - dome.halfWidth * 0.2, zoom: panZoom, duration: 2.5 },
        { x: dome.pos.x + dome.halfWidth * 0.3, y: deckY - dome.halfWidth * 0.2, zoom: 0.6, duration: 2.5 },
      ],
      cameraLoop: true,
    });
  } else {
    beats.push({ text: "Right now you're standing in a domed playground" });
    beats.push({ text: "It's a perfect place for showcasing Bob's abilities!" });
  }

  beats.push({
    text: 'Or you can teleport out of the dome and explore the galaxy.',
    camera: beam ? [{ x: beam.pos.x, y: beam.pos.y, zoom: 1.3, duration: 2.0 }] : null,
  });

  // A short tour — the sun, then a sweep across the asteroid belt
  // ring, then the water planets — all under one line of dialogue.
  // worldGen.streamFocus() follows state.camera, so panning the camera
  // out here is what makes that ring stream in ahead of arriving there.
  const tourWaypoints = [];

  const sun = state.sun;
  if (sun) {
    const sunZoom = screenW / (sun.radius * 2 * 1.5);
    tourWaypoints.push({ x: sun.pos.x, y: sun.pos.y, zoom: sunZoom, duration: 2.0 });
  }

  {
    const [sunX, sunY] = worldGen.sunPos();
    const [inner, outer] = worldGen.beltRadii();
    const midR = (inner + outer) / 2;
    const beltZoom = 0.5;
    tourWaypoints.push({ x: sunX + midR, y: sunY, zoom: beltZoom, duration: 5 });
    tourWaypoints.push({ x: sunX, y: sunY - midR, zoom: beltZoom, duration: 5 });
  }

  for (const waterPlanet of [state.waterPlanet, state.waterPlanet2]) {
    if (waterPlanet) {
      const waterZoom = screenW / (waterPlanet.radius * 2 * 1.6);
      tourWaypoints.push({ x: waterPlanet.pos.x, y: waterPlanet.pos.y, zoom: waterZoom * 0.5, duration: 5 });
    }
  }

  beats.push({
    text: "There's a fair amount of things you can see, even for this demo.",
    camera: tourWaypoints.length > 0 ? tourWaypoints : null,
    cameraLoop: true,
  });

  return beats;
}

const TOOLTIP_GAP_ABOVE_HEAD = 26; // world units between his head and the pill's own bottom edge

class RobotButler {
  // homeX: the LEFT end of the patrol range (and the robot's starting
  // position). groundY: the deck surface it stands on.
  static new(homeX, groundY, options) {
    return new RobotButler(homeX, groundY, options);
  }

  constructor(homeX, groundY, options = {}) {
    const img = state.robotTexture;
    let sheetW, sheetH;
    if (img) [sheetW, sheetH] = img.getDimensions();
    else { sheetW = 4000; sheetH = 1200; }
    const frameW = sheetW / FRAME_COUNT, frameH = sheetH;

    // Draw size in world units: a flat default height, width derived
    // from the source frame's own aspect ratio (1000x1200, not square).
    this.drawHeight = options.drawHeight ?? 120;
    this.drawWidth = options.drawWidth ?? (this.drawHeight * frameW / frameH);
    this.halfWidth = this.drawWidth / 2;
    this.halfHeight = this.drawHeight / 2;

    this.homeX = homeX;
    this.groundY = groundY;
    this.patrolWidth = options.patrolWidth ?? 350; // how far right of homeX he walks before turning back
    this.speed = options.speed ?? 1.5;             // world units per 60fps-baseline tick

    // Starts walking right (direction = 1).
    this.direction = 1;

    // Center-bottom anchor: this.pos sits HALF the draw height above the
    // true ground line.
    this.pos = new Vector2(homeX, groundY - this.halfHeight);

    this.frameIndex = 0;
    this.frameTimer = 0;

    // Interaction (Enter / gamepad Circle). World-units radius, bigger
    // and more forgiving than his own visual silhouette.
    this.interactRadius = options.interactRadius ?? 220;
    // The ordinary one-line greeting — shown by startDialogue, which
    // only runs AFTER the one-time intro script has already played once.
    this.dialogueText = 'Hello again!';
    this.playerNearby = false;
    this.dialogueActive = false;
    // The in-progress intro Script instance, while it's playing.
    this.activeScript = null;
    // Paginated to fit the textbox (see DialogueBox.paginateForBox) — a
    // list of already-wrapped page strings, and which one (0-based) is
    // currently showing. Advancing past the last page closes the
    // dialogue or advances to the next beat — no time-based auto-dismiss.
    this.dialoguePages = null;
    this.dialoguePageIndex = 0;
  }

  isPlayerNear(player) {
    if (!player) return false;
    const dx = player.pos.x - this.pos.x, dy = player.pos.y - this.pos.y;
    return (dx * dx + dy * dy) <= this.interactRadius * this.interactRadius;
  }

  startDialogue() {
    this.dialogueActive = true;
    this.dialoguePageIndex = 0;
    this.dialoguePages = DialogueBox.paginateForBox(this.dialogueText);
  }

  // Advances to the next page, or — once already on the last one —
  // closes the dialogue.
  advanceDialoguePage() {
    if (!this.dialoguePages) return;
    if (this.dialoguePageIndex < this.dialoguePages.length - 1) {
      this.dialoguePageIndex++;
    } else {
      this.dialogueActive = false;
      this.dialoguePages = null;
      this.dialoguePageIndex = 0;
    }
  }

  // Shows one beat of this.activeScript: pages its text through the
  // same box/pagination machinery startDialogue uses, then kicks off
  // that beat's own camera move, if it has one.
  showScriptBeat(beat) {
    this.dialogueActive = true;
    this.dialoguePageIndex = 0;
    this.dialoguePages = DialogueBox.paginateForBox(beat.text);
    if (beat.camera) CameraDirector.run(beat.camera, { loop: beat.cameraLoop });
  }

  // Called from InputHandlers.js (Enter) and GamePadInput.js (Circle).
  // While a conversation is already showing, the SAME button advances/
  // closes it instead of re-checking distance.
  tryInteract(player) {
    if (this.dialogueActive) {
      if (this.activeScript) {
        // Still mid-beat (more wrapped pages left on THIS line) — just
        // turn the page. Only once the beat's own pages are exhausted
        // does the press advance the SCRIPT itself.
        if (this.dialoguePageIndex < this.dialoguePages.length - 1) {
          this.dialoguePageIndex++;
          return;
        }
        const nextBeat = this.activeScript.advance();
        if (nextBeat) {
          this.showScriptBeat(nextBeat);
        } else {
          this.dialogueActive = false;
          this.dialoguePages = null;
          this.dialoguePageIndex = 0;
          this.activeScript = null;
          state.scriptsCompleted[INTRO_SCRIPT_ID] = true;
          CameraDirector.release();
        }
        return;
      }
      this.advanceDialoguePage();
      return;
    }

    if (!this.isPlayerNear(player)) return;

    if (!state.scriptsCompleted[INTRO_SCRIPT_ID]) {
      this.activeScript = Script.new(buildIntroScript());
      this.showScriptBeat(this.activeScript.start());
      return;
    }

    this.startDialogue();
  }

  update() {
    const timeScale = state.timeScale ?? 1;
    let ds = 0;

    // Patrol/animation/dust are all skipped outright while talking to
    // the player, matching the player's own movement lock.
    if (!this.dialogueActive) {
      ds = this.direction * this.speed * timeScale;

      const minX = this.homeX, maxX = this.homeX + this.patrolWidth;
      let desiredX = this.pos.x + ds;
      if (desiredX > maxX) {
        desiredX = maxX;
        this.direction = -1;
      } else if (desiredX < minX) {
        desiredX = minX;
        this.direction = 1;
      }
      this.pos.x = desiredX;

      // Walk-cycle animation frame: fixed 100ms cadence regardless of speed.
      this.frameTimer += timeScale;
      if (this.frameTimer >= FRAME_TICKS) {
        this.frameTimer -= FRAME_TICKS;
        this.frameIndex = (this.frameIndex + 1) % FRAME_COUNT;
      }

      // Dust: a steady per-frame trickle — this robot has no legs
      // planting on a walk cycle, so there's no discrete footfall to time
      // dust against. Rolling the dice every tick he's moving gives
      // continuous dust that scales naturally with speed/timeScale.
      if (ds !== 0 && Math.random() < DUST_SPAWN_CHANCE * timeScale) {
        const downDir = new Vector2(0, 1);
        const feetPos = new Vector2(this.pos.x, this.groundY);
        const sideDir = new Vector2(1, 0);
        DustPuff.spawn(feetPos, downDir, sideDir, 1 + Math.floor(Math.random() * 2), 2.5, 0.2, 0.6);
      }
    }

    this.playerNearby = this.isPlayerNear(state.player);
    // Safety net only: the player's own movement is frozen for the
    // entire conversation, but if he somehow ends up out of range
    // anyway, don't leave the conversation stuck open forever.
    if (this.dialogueActive && !this.playerNearby) {
      this.dialogueActive = false;
      this.dialoguePages = null;
      this.dialoguePageIndex = 0;
      if (this.activeScript) {
        this.activeScript = null;
        CameraDirector.release();
      }
    }
  }

  draw() {
    const img = state.robotTexture;
    if (!img) return;
    ensureFrameQuads(img);

    const quad = frameQuads[this.frameIndex];

    // Sprite faces LEFT by default — moving right needs a horizontal
    // flip, via a negative scaleX with a centered origin.
    let scaleX = this.drawWidth / sheetFrameW;
    if (this.direction > 0) scaleX = -scaleX;
    const scaleY = this.drawHeight / sheetFrameH;

    love.graphics.setColor(1, 1, 1, 1);
    love.graphics.draw(img, quad, this.pos.x, this.pos.y, 0, scaleX, scaleY, sheetFrameW / 2, sheetFrameH / 2);
  }

  // World-space "you can interact with him" hint. Only shown while he's
  // in range, not already mid-conversation, and not while curled into a
  // ball (a ball can't interact with him at all).
  drawTooltip() {
    if (!this.playerNearby || this.dialogueActive) return;
    if (state.player && state.player.isBall) return;

    InteractPrompt.draw(this.pos.x, this.pos.y - this.halfHeight - TOOLTIP_GAP_ABOVE_HEAD);
  }

  // Screen-space dialogue box — call AFTER the camera transform is
  // popped (see main.js's love.draw). Rendering itself is shared — see
  // js/ui/DialogueBox.js.
  drawDialogue() {
    if (!this.dialogueActive) return;
    const pageText = (this.dialoguePages && this.dialoguePages[this.dialoguePageIndex]) ?? this.dialogueText;
    const hasMore = !!this.dialoguePages && this.dialoguePageIndex < this.dialoguePages.length - 1;
    DialogueBox.draw(pageText, hasMore);
  }
}

export default RobotButler;
