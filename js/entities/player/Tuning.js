// js/entities/player/Tuning.js
//
// Player timings used by more than one of Player.js's parts (the core and
// js/entities/player/Rendering.js). Everything used by only one part lives
// at the top of that part. (A port of lua/entities/player/Tuning.lua.)

const Tuning = {
  // Curl-into-a-ball transition: two authored keyframes (see
  // BALL_MORPH_FRAME_1/2 in Rendering.js) played in order on the way in,
  // reversed on the way out. this.isBall (and so his radius and ground
  // speed) only flips at the very end of either direction — see
  // Player.updateBallMorph. Baseline (60fps) ticks per keyframe blend.
  BALL_MORPH_SEGMENT_TICKS: 8,

  // Teleport (Beam.js's tryInteract): a transporter shimmer (see
  // js/effects/TransporterEffect.js and Player.getTransporterState). How
  // long he takes to dematerialize at the origin beam, and to
  // rematerialize at the destination. Baseline (60fps) ticks; 48 = 0.8s each.
  TELEPORT_OUT_TICKS: 48,
  TELEPORT_IN_TICKS: 48,
};

export default Tuning;
