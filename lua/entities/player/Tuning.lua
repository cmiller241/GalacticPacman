-- lua/entities/player/Tuning.lua
--
-- Player timings used by more than one of Player.lua's parts (the core
-- and lua/entities/player/Rendering.lua). Everything used by only one
-- part lives at the top of that part.

return {
  -- Curl-into-a-ball transition: two authored keyframes (see
  -- BALL_MORPH_FRAME_1/2 in Rendering.lua) played in order on the way in,
  -- reversed on the way out. self.isBall (and so his radius and ground
  -- speed) only flips at the very end of either direction — see
  -- Player:updateBallMorph — so he has humanoid physics throughout the
  -- curl-in and ball physics throughout the stand-up.
  -- Baseline (60fps) ticks per keyframe blend; a full transition is 2x
  -- this, ~0.27s.
  BALL_MORPH_SEGMENT_TICKS = 8,

  -- Teleport (Beam.lua's :tryInteract): a transporter shimmer (see
  -- lua/effects/TransporterEffect.lua and Player:getTransporterState).
  -- How long he takes to dematerialize at the origin beam, and to
  -- rematerialize at the destination. He's frozen for both.
  -- Baseline (60fps) ticks; 48 = 0.8s each.
  TELEPORT_OUT_TICKS = 48,
  TELEPORT_IN_TICKS = 48,
}
