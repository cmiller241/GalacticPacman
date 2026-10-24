// js/world/Sign.js
//
// A ground-mounted signpost, drawn from img/sign.png. Placed on the
// ground the same way Lever/Crank are (see main.js's own spawn loop —
// the Tiled object's point is raycast straight down onto whatever
// TerrainShape surface sits below it). this.pos.x is the sign's own
// horizontal center.
//
// Reading it shows its own "message" Tiled custom property, split on
// "|" into however many separate messages the level designer wrote —
// each independently word-wrapped/paginated. Pressing Enter/Circle pages
// through the CURRENT message first, then moves on to the next message,
// then closes once every message has been shown.
//
// Dialogue box rendering/pagination is shared with every other NPC —
// see js/ui/DialogueBox.js.

import love from '../love/index.js';
import state from '../state.js';
import Vector2 from '../vector2.js';
import DialogueBox from '../ui/DialogueBox.js';
import InteractPrompt from '../ui/InteractPrompt.js';

// img/sign.png (state.signTexture) is 40x48 pixel art, drawn at the same
// 2x the terrain tiles use — bottom-center anchored on this.pos.
const SPRITE_SCALE = 2;
const SPRITE_WIDTH = 40;
const SPRITE_HEIGHT = 48;
const SIGN_HEIGHT = SPRITE_HEIGHT * SPRITE_SCALE;

const TOOLTIP_GAP_ABOVE = 26;
const TOOLTIP_PILL_HEIGHT = 30; // InteractPrompt.js's own pill is about this tall

// Splits the raw "message" property on "|", trimming whitespace around
// each, always returning at least one (possibly empty) entry.
function splitMessages(raw) {
  let messages = [];
  if (raw && raw !== '') {
    messages = String(raw).split('|').map((piece) => piece.trim());
  }
  if (messages.length === 0) messages = [''];
  return messages;
}

class Sign {
  // x, y: world position of the sign's own ground anchor. rawMessage: the
  // Tiled object's own "message" custom property, pipe-delimited.
  //
  // options (all optional):
  //   texture  the image to draw instead of img/sign.png — same 40x48
  //            size and 2x scale (e.g. img/sign-planet.png).
  //   up       unit Vector2 pointing the way the sign stands, away from
  //            the ground it's planted in. Straight up the screen by
  //            default; a sign planted round a planetoid passes the
  //            direction out from that planetoid's center.
  static new(x, y, rawMessage, options) {
    return new Sign(x, y, rawMessage, options);
  }

  constructor(x, y, rawMessage, options = {}) {
    this.pos = new Vector2(x, y);
    this.texture = options.texture;
    this.up = options.up ?? new Vector2(0, -1);

    this.messages = splitMessages(rawMessage);
    this.messageIndex = 0;

    this.interactRadius = 140;
    this.playerNearby = false;

    this.dialogueActive = false;
    this.dialoguePages = null;
    this.dialoguePageIndex = 0;
  }

  isPlayerNear(player) {
    if (!player) return false;
    const dx = player.pos.x - this.pos.x, dy = player.pos.y - this.pos.y;
    return (dx * dx + dy * dy) <= this.interactRadius * this.interactRadius;
  }

  // Paginates whichever message messageIndex points at and opens the
  // dialogue box on its first page.
  showCurrentMessage() {
    this.dialogueActive = true;
    this.dialoguePageIndex = 0;
    this.dialoguePages = DialogueBox.paginateForBox(this.messages[this.messageIndex]);
  }

  // Called from InputHandlers.js (Enter) and GamePadInput.js (Circle).
  tryInteract(player) {
    if (this.dialogueActive) {
      if (this.dialoguePageIndex < this.dialoguePages.length - 1) {
        this.dialoguePageIndex++;
        return;
      }
      if (this.messageIndex < this.messages.length - 1) {
        this.messageIndex++;
        this.showCurrentMessage();
      } else {
        this.dialogueActive = false;
        this.dialoguePages = null;
        this.dialoguePageIndex = 0;
        this.messageIndex = 0; // next read starts over from the first message
      }
      return;
    }

    if (!this.isPlayerNear(player)) return;
    this.showCurrentMessage();
  }

  update() {
    this.playerNearby = this.isPlayerNear(state.player);

    // Safety net only: don't leave the conversation stuck open forever
    // if he somehow ends up out of range.
    if (this.dialogueActive && !this.playerNearby) {
      this.dialogueActive = false;
      this.dialoguePages = null;
      this.dialoguePageIndex = 0;
      this.messageIndex = 0;
    }
  }

  draw() {
    love.graphics.setColor(1, 1, 1, 1);
    // Origin at the sprite's own bottom-center, so it lands exactly on
    // this.pos. Floored so the 2x pixels stay on whole world units.
    // Turned so its post points along this.up.
    const rotation = Math.atan2(this.up.y, this.up.x) + Math.PI / 2;
    love.graphics.draw(this.texture ?? state.signTexture, Math.floor(this.pos.x), Math.floor(this.pos.y), rotation,
      SPRITE_SCALE, SPRITE_SCALE, SPRITE_WIDTH / 2, SPRITE_HEIGHT);
  }

  // World-space "you can interact with this" hint. Not shown while
  // curled into a ball.
  drawTooltip() {
    if (!this.playerNearby || this.dialogueActive) return;
    if (state.player && state.player.isBall) return;

    // Just beyond the far end of the sign from the ground, whichever way
    // that is. The pill hangs ABOVE the y it's given, so for a sign
    // pointing down the screen it's nudged a pill's height further out.
    const reach = SIGN_HEIGHT + TOOLTIP_GAP_ABOVE;
    const pillHeightNudge = TOOLTIP_PILL_HEIGHT * (1 + this.up.y) / 2;
    InteractPrompt.draw(this.pos.x + this.up.x * reach, this.pos.y + this.up.y * reach + pillHeightNudge);
  }

  // Screen-space dialogue box — call AFTER the camera transform is
  // popped. hasMore is true whenever pressing on would advance to
  // another page OR another message.
  drawDialogue() {
    if (!this.dialogueActive) return;
    const pageText = (this.dialoguePages && this.dialoguePages[this.dialoguePageIndex]) ?? '';
    const hasMorePages = !!this.dialoguePages && this.dialoguePageIndex < this.dialoguePages.length - 1;
    const hasMoreMessages = this.messageIndex < this.messages.length - 1;
    DialogueBox.draw(pageText, hasMorePages || hasMoreMessages);
  }
}

export default Sign;
