// js/interiors/Interior.js
import { state } from '../state.js';
import { Vector2 } from '../vector2.js';

export class Interior {
  constructor(planetoid) {
    this.planetoid = planetoid;
  }

  draw() {
    throw new Error('draw() must be implemented in subclass');
  }

  getPortalPosition() {
    throw new Error('getPortalPosition() must be implemented in subclass');
  }
}