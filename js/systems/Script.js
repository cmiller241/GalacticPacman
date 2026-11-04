// js/systems/Script.js
//
// A small, generic "beat sequence" for scripted NPC conversations: each
// beat is one line of dialogue, optionally paired with a camera action
// (see CameraDirector.js). Shape of one beat:
//   { text: "...", camera: [ {x, y, zoom, duration}, ... ] }
// This object only tracks WHICH beat is current (index is 0-based; -1
// before start).

class Script {
  static new(beats) {
    return new Script(beats);
  }

  constructor(beats) {
    this.beats = beats ?? [];
    this.index = -1;
    this.active = false;
  }

  // Starts the script and returns the first beat (undefined if none).
  start() {
    this.index = 0;
    this.active = this.beats.length > 0;
    return this.beats[this.index];
  }

  currentBeat() {
    return this.beats[this.index];
  }

  // Advances to the next beat and returns it — or null once past the
  // last one, at which point the script stops being active.
  advance() {
    if (!this.active) return null;
    if (this.index >= this.beats.length - 1) {
      this.active = false;
      return null;
    }
    this.index += 1;
    return this.beats[this.index];
  }

  isActive() {
    return this.active;
  }
}

export default Script;
