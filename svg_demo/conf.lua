function love.conf(t)
  t.identity = "astronaut_svg_demo"
  t.window.title = "Astronaut — drawn from img/astronaut.svg"
  t.window.width = 1100
  t.window.height = 900
  t.window.resizable = true
  t.window.msaa = 8      -- smooth edges on the fills
  t.window.stencil = true -- (the fills are drawn with the stencil buffer — see svg.lua)
end
