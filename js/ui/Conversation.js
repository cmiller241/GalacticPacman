// js/ui/Conversation.js
//
// A conversation in the textbox that can ask the player to choose.
// It's a list of beats, each one of:
//
//   { text: '...' }
//       a line of text (paged if it's too long for the box); the
//       interact button moves on
//
//   { choice: 'Should he read it?', options: [
//       { label: 'Read it', beats: [ ...what follows... ] },
//       { label: "Don't read it" },   // (no beats: the talk ends)
//   ] }
//       a question with options side by side; Left/Right (or Up/Down)
//       moves the cursor and the interact button picks one, which
//       carries on with that option's own beats
//
// The owner (js/interiors/ShipInterior.js's Bible, for one) starts it,
// passes on the interact button (.press) and the arrows (.move), and
// draws it with the HUD (.draw). The box itself is js/ui/DialogueBox.js.

import DialogueBox from './DialogueBox.js';

export default class Conversation {
  constructor(beats) {
    this.beats = beats;
    this.queue = null;   // the beats being gone through now
    this.index = -1;
    this.pages = null;   // the current text beat, paged to fit the box
    this.page = 0;
    this.selected = 0;   // the option the cursor's on (choice beats)
    this.active = false;
  }

  isActive() {
    return this.active;
  }

  // The beat showing now (null once it's over).
  current() {
    return this.active ? this.queue[this.index] ?? null : null;
  }

  // Moves on to the next beat in the queue, or ends it after the last.
  nextBeat() {
    this.index++;
    const beat = this.queue[this.index];
    if (!beat) {
      this.stop();
      return;
    }
    this.page = 0;
    this.selected = 0;
    this.pages = beat.text != null ? DialogueBox.paginateForBox(beat.text) : null;
  }

  start() {
    this.active = true;
    this.queue = this.beats;
    this.index = -1;
    this.nextBeat();
  }

  stop() {
    this.active = false;
    this.queue = null;
    this.pages = null;
    this.index = -1;
  }

  // The interact button: picks the option under the cursor, or turns the
  // page, or moves on to the next beat.
  press() {
    const beat = this.current();
    if (!beat) return;
    if (beat.choice) {
      const option = beat.options[this.selected];
      this.queue = option.beats ?? [];
      this.index = -1;
      this.nextBeat();
    } else if (this.page < this.pages.length - 1) {
      this.page++;
    } else {
      this.nextBeat();
    }
  }

  // An arrow (dir -1 or 1): moves the cursor, wrapping round, while a
  // question is up.
  move(dir) {
    const beat = this.current();
    if (!beat?.choice) return;
    const n = beat.options.length;
    this.selected = (((this.selected + dir) % n) + n) % n;
  }

  // Screen-space, with the HUD (see WorldObjects.drawDialogues).
  draw() {
    const beat = this.current();
    if (!beat) return;
    if (beat.choice) {
      DialogueBox.drawChoice(beat.choice, beat.options.map((o) => o.label), this.selected);
    } else {
      const hasMore = this.page < this.pages.length - 1 || this.index < this.queue.length - 1;
      DialogueBox.draw(this.pages[this.page], hasMore);
    }
  }
}
