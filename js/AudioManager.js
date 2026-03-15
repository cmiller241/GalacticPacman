// js/AudioManager.js
import { state } from './state.js';
import { Vector2 } from './vector2.js'; // For position calculations in playBang

export class AudioManager {
  constructor() {
    this.eatDotIndex = 0; // Moved from state
    this.eatDotAudio0 = new Audio('sounds/eat_dot_0.wav');
    this.eatDotAudio1 = new Audio('sounds/eat_dot_1.wav');
    this.deathAudio = new Audio('sounds/death_0.wav');
    this.jumpAudio = new Audio('sounds/jump.wav');
    this.jumpSmallAudio = new Audio('sounds/jumpsmall.wav');
    this.bangLarge = new Audio('sounds/bangLarge.wav');
    this.bangMedium = new Audio('sounds/bangMedium.wav');
    this.bangSmall = new Audio('sounds/bangSmall.wav');

    // Set volumes and preload
    [this.eatDotAudio0, this.eatDotAudio1, this.deathAudio, this.jumpAudio, this.jumpSmallAudio, this.bangLarge, this.bangMedium, this.bangSmall].forEach(audio => {
      audio.volume = 0.5;
      audio.preload = 'auto';
      audio.load();
    });
  }

  playEatDot() {
    const source = this.eatDotIndex === 0 ? this.eatDotAudio0 : this.eatDotAudio1;
    this.eatDotIndex = 1 - this.eatDotIndex; // Toggle between 0 and 1
    const audio = source.cloneNode(true);
    audio.play().catch(e => console.log('Audio play failed:', e));
  }

  playDeath() {
    const audio = this.deathAudio.cloneNode(true);
    audio.play().catch(e => console.log('Audio play failed:', e));
  }

  playJump() {
    const audio = this.jumpAudio.cloneNode(true);
    audio.play().catch(e => console.log('Audio play failed:', e));
  }

  playJumpSmall() {
    const audio = this.jumpSmallAudio.cloneNode(true);
    audio.play().catch(e => console.log('Audio play failed:', e));
  }

  playBang(size, position) {
    let audioSource;
    if (size === 'large') audioSource = this.bangLarge;
    else if (size === 'medium') audioSource = this.bangMedium;
    else if (size === 'small') audioSource = this.bangSmall;
    else return;

    const dist = state.player.pos.subtract(position).length();
    let vol = 0.5 * Math.max(0, 1 - dist / 800); // Fade out over 800 units distance
    if (vol <= 0) return;

    const audio = audioSource.cloneNode(true);
    audio.volume = vol;
    audio.play().catch(e => console.log('Audio play failed:', e));
  }

  // Optional: Reset method if needed for game restarts (e.g., call from initGame)
  reset() {
    this.eatDotIndex = 0;
  }
}