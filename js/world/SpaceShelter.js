// js/world/SpaceShelter.js
//
// A static background structure on the sky dome's own deck — the
// astronaut's home. No collision; the only "gameplay" role it plays is
// the game's opening beat: the player spawns behind its closed door
// (see main.js), the door slides open, the player's own draw order
// swaps to stand in front of it once fully open, then it closes behind
// them — see the intro state machine below.
//
// Scaled to match Ooomba's own world-per-source-pixel ratio (an 800x950
// source frame drawn at 90 world units tall), so the shelter reads as
// proportionate to the Ooombas in the same scene.

import love from '../love/index.js';
import state from '../state.js';

// 90 world units per 950 source pixels tall.
const WORLD_UNITS_PER_SOURCE_PIXEL = 90 / 950;

// The door (img/spaceshelter_door.png, 551x1873) is authored as ONE half
// only — this is where THAT unflipped image goes, in the base shelter
// image's own UNSCALED pixel space (top-left corner). The other half is
// the same image mirrored horizontally (see drawDoor).
const DOOR_LEFT_X = 3729;
const DOOR_TOP_Y = 1155;

// Opening-cutscene timing (see update). A beat closed, a slide open,
// a beat standing open (player revealed), a slide shut — then normal
// gameplay control.
const PHASE_HOLD_CLOSED = 'holdClosed';
const PHASE_OPENING = 'opening';
const PHASE_HOLD_OPEN = 'holdOpen';
const PHASE_CLOSING = 'closing';
const PHASE_DONE = 'done';

const HOLD_CLOSED_SECONDS = 0.6;
const OPEN_SECONDS = 1.6;
const HOLD_OPEN_SECONDS = 1.2;
const CLOSE_SECONDS = 1.6;

class SpaceShelter {
  // x, bottomY: world position of the shelter's own base (where it meets
  // the deck).
  static new(x, bottomY, options) {
    return new SpaceShelter(x, bottomY, options);
  }

  constructor(x, bottomY, options = {}) {
    this.pos = { x, y: bottomY };

    const img = state.spaceShelterTexture;
    let sourceW, sourceH;
    if (img) [sourceW, sourceH] = img.getDimensions();
    else { sourceW = 4880; sourceH = 3404; }
    this.sourceW = sourceW;
    this.sourceH = sourceH;

    const scale = options.scale ?? WORLD_UNITS_PER_SOURCE_PIXEL;
    this.drawWidth = sourceW * scale;
    this.drawHeight = sourceH * scale;
    this.scaleX = this.drawWidth / sourceW;
    this.scaleY = this.drawHeight / sourceH;

    // Opening-cutscene state. doorOpenFraction: 0 fully closed, 1 fully
    // open. playerInFront: false while the player should draw BEHIND the
    // door, flips true the instant the door reaches fully open and stays
    // true from then on. introDone: true once the whole sequence has
    // finished, which is what main.js gates normal player movement on.
    this.introPhase = PHASE_HOLD_CLOSED;
    this.introTimer = 0;
    this.doorOpenFraction = 0;
    this.playerInFront = false;
    this.introDone = false;
  }

  // World position [x, y] of the doorway's own ground-level center
  // (where the two door halves meet) — where main.js spawns the player
  // for the opening cutscene.
  getDoorwayPosition() {
    const doorImg = state.spaceShelterDoorTexture;
    const doorW = doorImg ? doorImg.getWidth() : 551;
    const centerPx = DOOR_LEFT_X + doorW;
    const x = this.pos.x + (centerPx - this.sourceW / 2) * this.scaleX;
    return [x, this.pos.y];
  }

  update(dt) {
    if (this.introPhase === PHASE_DONE) return;

    this.introTimer += dt;

    if (this.introPhase === PHASE_HOLD_CLOSED) {
      this.doorOpenFraction = 0;
      if (this.introTimer >= HOLD_CLOSED_SECONDS) {
        this.introPhase = PHASE_OPENING;
        this.introTimer = 0;
      }
    } else if (this.introPhase === PHASE_OPENING) {
      const t = Math.min(1, this.introTimer / OPEN_SECONDS);
      this.doorOpenFraction = 0.5 - 0.5 * Math.cos(t * Math.PI); // eased 0 -> 1
      if (t >= 1) {
        this.introPhase = PHASE_HOLD_OPEN;
        this.introTimer = 0;
        this.doorOpenFraction = 1;
        this.playerInFront = true;
      }
    } else if (this.introPhase === PHASE_HOLD_OPEN) {
      this.doorOpenFraction = 1;
      if (this.introTimer >= HOLD_OPEN_SECONDS) {
        this.introPhase = PHASE_CLOSING;
        this.introTimer = 0;
      }
    } else if (this.introPhase === PHASE_CLOSING) {
      const t = Math.min(1, this.introTimer / CLOSE_SECONDS);
      this.doorOpenFraction = 1 - (0.5 - 0.5 * Math.cos(t * Math.PI)); // eased 1 -> 0
      if (t >= 1) {
        this.introPhase = PHASE_DONE;
        this.doorOpenFraction = 0;
        this.introDone = true;
      }
    }
  }

  // Maps a point in the base shelter image's own unscaled pixel space
  // into world coordinates. Returns [x, y].
  imagePointToWorld(px, py) {
    return [
      this.pos.x + (px - this.sourceW / 2) * this.scaleX,
      this.pos.y + (py - this.sourceH) * this.scaleY,
    ];
  }

  // The shelter's own body — no door. Called separately from drawDoor
  // so the player can be interleaved between the two.
  drawBody() {
    const img = state.spaceShelterTexture;
    if (!img) return;

    love.graphics.setColor(1, 1, 1, 1);
    // Origin at the bottom-center of the source image, so this.pos is
    // exactly where the shelter's base meets the deck.
    love.graphics.draw(img, this.pos.x, this.pos.y, 0, this.scaleX, this.scaleY, this.sourceW / 2, this.sourceH);
  }

  // Draws both door halves, each slid from its closed position by
  // doorOpenFraction of its own width (left half to the left, right half
  // mirrored to the right), clipped to the doorway's own frame with a
  // stencil — so each half reads as sliding INTO a pocket in the
  // structure rather than floating off past its edge.
  drawDoor() {
    const doorImg = state.spaceShelterDoorTexture;
    if (!doorImg) return;

    const [doorW, doorH] = doorImg.getDimensions();
    const centerPy = DOOR_TOP_Y + doorH / 2;
    const offsetPx = this.doorOpenFraction * doorW;

    const [frameLeftX, frameTopY] = this.imagePointToWorld(DOOR_LEFT_X, DOOR_TOP_Y);
    const [frameRightX, frameBottomY] = this.imagePointToWorld(DOOR_LEFT_X + doorW * 2, DOOR_TOP_Y + doorH);

    love.graphics.stencil(() => {
      love.graphics.rectangle('fill', frameLeftX, frameTopY, frameRightX - frameLeftX, frameBottomY - frameTopY);
    }, 'replace', 1);
    love.graphics.setStencilTest('greater', 0);

    love.graphics.setColor(1, 1, 1, 1);

    // Left half: the source image as-is, slid toward the frame's left edge.
    const leftCenterPx = DOOR_LEFT_X + doorW / 2 - offsetPx;
    const [leftX, leftY] = this.imagePointToWorld(leftCenterPx, centerPy);
    love.graphics.draw(doorImg, leftX, leftY, 0, this.scaleX, this.scaleY, doorW / 2, doorH / 2);

    // Right half: the SAME source image, mirrored, slid toward the right edge.
    const rightCenterPx = DOOR_LEFT_X + doorW + doorW / 2 + offsetPx;
    const [rightX, rightY] = this.imagePointToWorld(rightCenterPx, centerPy);
    love.graphics.draw(doorImg, rightX, rightY, 0, -this.scaleX, this.scaleY, doorW / 2, doorH / 2);

    love.graphics.setStencilTest();
  }
}

export default SpaceShelter;
