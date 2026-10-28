function love.conf(t)
  t.window.title = "Asteroid Bob"
  -- 16:9 at 1920x1080, borderless fullscreen. That's this screen's full
  -- desktop size, and it gives trailer clips (P) an exact 2x scale-up to
  -- 4K. F11 switches to a normal window and back.
  t.window.width = 1920
  t.window.height = 1080
  t.window.fullscreen = true
  t.window.fullscreentype = "desktop"
  t.window.resizable = true  -- for when F11 drops back to a window
  t.console = true
end
