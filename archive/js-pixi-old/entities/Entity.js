// js/entities/Entity.js
import { state } from '../state.js';
import { Vector2 } from '../vector2.js';

export class Entity {
  constructor() {
    this.pos = new Vector2(0, 0);
    this.vel = new Vector2(0, 0);
    this.radius = 0;
    this.mass = 0;
  }

  update() {
    // Base update: to be overridden
  }

  draw() {
    // Base draw: to be overridden
  }
}