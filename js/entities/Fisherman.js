// js/entities/Fisherman.js
//
// A decorative NPC standing at a fixed spot (see main.js's own
// placement, mirroring RobotButler.js's role) — doesn't walk anywhere,
// no physics, no collision. Same "purely background flavor" role
// RobotButler.js and SpaceShelter.js already play, with the same
// Enter/gamepad-Circle interact -> dialogue-textbox pattern
// RobotButler.js established.
//
// Rig: four source images (img/Fisherman-Body.png, -Arms.png,
// -Head.png, -Line.png), authored and positioned with
// paperdoll-fisherman.html at bodyScale 0.1 — POSE below is that tool's
// own logged output, applied with the exact same attach-point formulas
// the tool mirrors from Player.js's drawLimb/drawFullBody. Unlike the
// astronaut rig, this one's head has its own independent x offset.
//
// No walk-cycle/aim/surface-orientation logic at all: he always stands
// upright and never changes pose except the idle arm/head sway below.

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import DialogueBox from '../ui/DialogueBox.js';
import InteractPrompt from '../ui/InteractPrompt.js';

const BODY_SCALE = 0.1;

// Logged directly from paperdoll-fisherman.html — body: y=0 (its own
// local origin sits at the image's exact vertical center).
//
// line (the fishing line + hook, img/Fisherman-Line.png) is NOT like
// the other limbs here: it's rigidly attached to the rod TIP, which is
// itself just a pixel inside the ARMS image — so as armAngle sways, the
// tip orbits the arm's own pivot (armsX/armsY), and the line has to
// orbit right along with it. lineOffsetX/Y is that orbit's own radius:
// the tip's position relative to the arm's pivot, in the ARM's own local
// (unrotated) pixel space — draw() below re-rotates it by the CURRENT
// armAngle every frame.
const POSE = {
  armsX: 95.59, armsY: -66.91, armsJointX: 349.32, armsJointY: 1071.05,
  headX: -73.28, headY: -237.01, headPivotFraction: 0.9,
  lineOffsetX: 1281 - 95.59, lineOffsetY: -1118 - (-66.91),
  lineJointX: 113, lineJointY: 26,
};

// Idle sway: arms and head rock a few degrees back and forth,
// independent speeds/phases so the two don't move in perfect lockstep.
const IDLE_ARM_AMPLITUDE = 5 * Math.PI / 180;
const IDLE_ARM_SPEED = 1.1;
const IDLE_HEAD_AMPLITUDE = 4 * Math.PI / 180;
const IDLE_HEAD_SPEED = 0.8;
const IDLE_HEAD_PHASE = Math.PI * 0.4;

const TOOLTIP_GAP_ABOVE_HEAD = 66;

// Same drawLimb formula Player.js's own rig uses: an (x,y) attach
// offset (in world units, unrotated), then the image's own
// (jointX,jointY) pixel lands at that attach point, then an independent
// angle on top for the idle sway.
function drawLimb(img, offsetX, offsetY, jointX, jointY, angle, scale, originPos) {
  if (!img) return;
  love.graphics.push();
  love.graphics.translate(originPos.x + offsetX * scale, originPos.y + offsetY * scale);
  love.graphics.rotate(angle);
  love.graphics.draw(img, -jointX * scale, -jointY * scale, 0, scale, scale);
  love.graphics.pop();
}

class Fisherman {
  // x: world position. groundY: the flat surface he stands on.
  static new(x, groundY) {
    return new Fisherman(x, groundY);
  }

  constructor(x, groundY) {
    const images = state.fishermanImages;
    let bodyW = 100, bodyH = 100;
    if (images && images.body) [bodyW, bodyH] = images.body.getDimensions();

    this.drawWidth = bodyW * BODY_SCALE;
    this.drawHeight = bodyH * BODY_SCALE;
    this.halfWidth = this.drawWidth / 2;
    this.halfHeight = this.drawHeight / 2;

    // How far main.js's own on-screen cull check (utils.isOnScreen)
    // needs to reach past his own compact body — the fishing line hangs
    // roughly lineImage height * BODY_SCALE world units below him.
    // +100 is just slack for the attach point's own offset and the idle
    // sway swinging the line a little off-vertical.
    const lineReach = (images && images.line) ? (images.line.getHeight() * BODY_SCALE) : 0;
    this.drawBoundRadius = this.halfHeight + lineReach + 100;

    // Body art's own local origin sits at its vertical CENTER, so the
    // true ground line is halfHeight below wherever this.pos ends up.
    this.pos = new Vector2(x, groundY - this.halfHeight);

    // Desynced start phase.
    this.idleTime = Math.random() * 100;

    // Interaction (Enter / gamepad Circle) and dialogue box, same
    // pattern/timing as RobotButler.js's own.
    this.interactRadius = 220;
    this.dialogueText = "I love fishing but they just ain't biting!";
    this.playerNearby = false;
    this.dialogueActive = false;
    this.dialogueTimer = 0;
    this.dialogueDurationTicks = 240; // ~4 seconds at 60fps-baseline
  }

  isPlayerNear(player) {
    if (!player) return false;
    const dx = player.pos.x - this.pos.x, dy = player.pos.y - this.pos.y;
    return (dx * dx + dy * dy) <= this.interactRadius * this.interactRadius;
  }

  // Called from InputHandlers.js (Enter) and GamePadInput.js (Circle).
  // A press while the dialogue is ALREADY active closes it immediately
  // (state.dialogueActive freezes the player while it's up, so it must
  // be dismissable on purpose).
  tryInteract(player) {
    if (this.dialogueActive) {
      this.dialogueActive = false;
      return;
    }
    if (!this.isPlayerNear(player)) return;
    this.dialogueActive = true;
    this.dialogueTimer = this.dialogueDurationTicks;
  }

  update() {
    const timeScale = state.timeScale ?? 1;
    this.idleTime += timeScale / 60;

    this.playerNearby = this.isPlayerNear(state.player);
    if (this.dialogueActive) {
      // Walking out of range dismisses it immediately.
      if (!this.playerNearby) {
        this.dialogueActive = false;
      } else {
        this.dialogueTimer -= timeScale;
        if (this.dialogueTimer <= 0) this.dialogueActive = false;
      }
    }
  }

  draw() {
    const images = state.fishermanImages;
    if (!images) return;

    const scale = BODY_SCALE;
    const originPos = this.pos;

    const armAngle = Math.sin(this.idleTime * IDLE_ARM_SPEED) * IDLE_ARM_AMPLITUDE;
    const headAngle = Math.sin(this.idleTime * IDLE_HEAD_SPEED + IDLE_HEAD_PHASE) * IDLE_HEAD_AMPLITUDE;

    // Draw order (back to front): body, arms, head, line.
    if (images.body) {
      const [w, h] = images.body.getDimensions();
      love.graphics.push();
      love.graphics.translate(originPos.x, originPos.y);
      love.graphics.draw(images.body, -w * scale / 2, -h * scale / 2, 0, scale, scale);
      love.graphics.pop();
    }

    drawLimb(images.arms, POSE.armsX, POSE.armsY, POSE.armsJointX, POSE.armsJointY, armAngle, scale, originPos);

    if (images.head) {
      const [w, h] = images.head.getDimensions();
      const pivotY = h * scale * POSE.headPivotFraction;
      love.graphics.push();
      love.graphics.translate(originPos.x + POSE.headX * scale, originPos.y + POSE.headY * scale);
      love.graphics.rotate(headAngle);
      love.graphics.draw(images.head, -w * scale / 2, -pivotY, 0, scale, scale);
      love.graphics.pop();
    }

    // Can't use drawLimb here — the line's own attach point (the rod
    // tip) orbits the ARM's pivot as armAngle sways. Rotating that fixed
    // local offset by the CURRENT armAngle and adding it to the arm's
    // own (unrotated) pivot point gives the tip's true current position.
    if (images.line) {
      const armsAttachX = originPos.x + POSE.armsX * scale;
      const armsAttachY = originPos.y + POSE.armsY * scale;
      const cosA = Math.cos(armAngle), sinA = Math.sin(armAngle);
      const lineAttachX = armsAttachX + (POSE.lineOffsetX * cosA - POSE.lineOffsetY * sinA) * scale;
      const lineAttachY = armsAttachY + (POSE.lineOffsetX * sinA + POSE.lineOffsetY * cosA) * scale;
      love.graphics.push();
      love.graphics.translate(lineAttachX, lineAttachY);
      love.graphics.rotate(armAngle);
      love.graphics.draw(images.line, -POSE.lineJointX * scale, -POSE.lineJointY * scale, 0, scale, scale);
      love.graphics.pop();
    }
  }

  // Not shown while curled into a ball (Player.js's own isBall) — a
  // ball can't interact with him at all.
  drawTooltip() {
    if (!this.playerNearby || this.dialogueActive) return;
    if (state.player && state.player.isBall) return;

    InteractPrompt.draw(this.pos.x, this.pos.y - this.halfHeight - TOOLTIP_GAP_ABOVE_HEAD);
  }

  // Screen-space dialogue box — call AFTER the camera transform is
  // popped (see main.js's love.draw).
  drawDialogue() {
    if (!this.dialogueActive) return;
    DialogueBox.draw(this.dialogueText, false);
  }
}

export default Fisherman;
