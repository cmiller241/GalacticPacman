-- lua/systems/water/Rendering.lua
--
-- Drawing the water and lava: the shaders, the pools on the level, the
-- layers on planetoids, dirt planets' water, droplets and splashes.
-- Part of the water system: see lua/systems/WaterSystem.lua.

local state = require("lua.state")
local Tuning = require("lua.systems.water.Tuning")
local CELL = Tuning.CELL
local OCEAN_SEGMENTS = Tuning.OCEAN_SEGMENTS
local OCEAN_MAX_SEGMENTS = Tuning.OCEAN_MAX_SEGMENTS
local SPLASH_SECONDS = Tuning.SPLASH_SECONDS
local WATERFALL_SPLASH_MIN_FALL = Tuning.WATERFALL_SPLASH_MIN_FALL
local LAVA_TUNING = Tuning.LAVA_TUNING
local COLOR_SHALLOW = Tuning.COLOR_SHALLOW
local COLOR_DEEP = Tuning.COLOR_DEEP
local DEEP_AT = Tuning.DEEP_AT
local ALPHA_SHALLOW = Tuning.ALPHA_SHALLOW
local ALPHA_DEEP = Tuning.ALPHA_DEEP
local COLOR_SURFACE = Tuning.COLOR_SURFACE
local SURFACE_LINE = Tuning.SURFACE_LINE
local SURFACE_FEATHER = Tuning.SURFACE_FEATHER
local STREAM_REACH_CELLS = Tuning.STREAM_REACH_CELLS
local LIP_THICKNESS = Tuning.LIP_THICKNESS
local SURFACE_SLICES = Tuning.SURFACE_SLICES
local SURFACE_GLOW = Tuning.SURFACE_GLOW
local COLOR_CAUSTIC = Tuning.COLOR_CAUSTIC
local CAUSTIC_SCALE = Tuning.CAUSTIC_SCALE
local CAUSTIC_GROW_FROM_DEPTH = Tuning.CAUSTIC_GROW_FROM_DEPTH
local CAUSTIC_GROW_POWER = Tuning.CAUSTIC_GROW_POWER
local CAUSTIC_MAX_GROWTH = Tuning.CAUSTIC_MAX_GROWTH
local SPHERE_COLOR_SHALLOW = Tuning.SPHERE_COLOR_SHALLOW
local SPHERE_COLOR_DEEP = Tuning.SPHERE_COLOR_DEEP
local SPHERE_COLOR_SHADE = Tuning.SPHERE_COLOR_SHADE
local SPHERE_SHADE_STRENGTH = Tuning.SPHERE_SHADE_STRENGTH
local SPHERE_COLOR_RIM = Tuning.SPHERE_COLOR_RIM
local SPHERE_RIM_STRENGTH = Tuning.SPHERE_RIM_STRENGTH
local SPHERE_COLOR_REFLECTED = Tuning.SPHERE_COLOR_REFLECTED
local SPHERE_REFLECTED_STRENGTH = Tuning.SPHERE_REFLECTED_STRENGTH
local CORE_OVERLAY_FROM_DEPTH = Tuning.CORE_OVERLAY_FROM_DEPTH
local CORE_OVERLAY_FULL_DEPTH = Tuning.CORE_OVERLAY_FULL_DEPTH
local CORE_OVERLAY_MAX = Tuning.CORE_OVERLAY_MAX
local CAUSTIC_BULGE = Tuning.CAUSTIC_BULGE
local CAUSTIC_SPEED = Tuning.CAUSTIC_SPEED
local CAUSTIC_STRENGTH = Tuning.CAUSTIC_STRENGTH
local COLOR_DROPLET = Tuning.COLOR_DROPLET
local Shared = require("lua.systems.water.Shared")
local shared = Shared.shared
local Ice = Shared.Ice
local Scratch = Shared.Scratch
local WATER = Shared.WATER
local LAVA = Shared.LAVA
local Oceans = require("lua.systems.water.Oceans")
local depthOf = Oceans.depthOf
local LevelGrid = require("lua.systems.water.LevelGrid")
local isSolid = LevelGrid.isSolid
local blocked = LevelGrid.blocked
local PlanetGrids = require("lua.systems.water.PlanetGrids")
local planetPoint = PlanetGrids.planetPoint
local planetColWidth = PlanetGrids.planetColWidth
local planetCol = PlanetGrids.planetCol
local planetSolid = PlanetGrids.planetSolid
local Effects = require("lua.systems.water.Effects")
local drawSteam = Effects.drawSteam
local Obsidian = require("lua.systems.water.Obsidian")
local getObsidianImage = Obsidian.getObsidianImage

-- Functions it adds to WaterSystem (copied on in WaterSystem.lua).
local WaterSystem = {}

local meshes, meshSizes = {}, {} -- the pools' mesh for each liquid (see drawPools)

-- The pool shader. Each vertex carries, in its texture coordinates, how
-- far below its pool's surface it is (u, world units) and whether it's
-- part of a falling stream (v = 1); the shader also gets each pixel's
-- world position, so the caustics and streaks stay put in the world as
-- the camera moves.
local waterShader = nil
local function getWaterShader()
  if waterShader then return waterShader end
  waterShader = love.graphics.newShader([[
    varying vec2 worldPos;

    #ifdef VERTEX
    vec4 position(mat4 transform_projection, vec4 vertex_position) {
      worldPos = vertex_position.xy;
      return transform_projection * vertex_position;
    }
    #endif

    #ifdef PIXEL
    extern number time;
    extern vec3 colorShallow;
    extern vec3 colorDeep;
    extern number deepAt;
    extern number alphaShallow;
    extern number alphaDeep;
    extern vec3 colorSurface;
    extern number surfaceLine;
    extern number surfaceFeather;
    extern number surfaceGlow;
    extern vec3 colorCaustic;
    extern number causticScale;
    extern number causticSpeed;
    extern number causticStrength;
    extern vec2 bulgeCenter;      // a planetoid's water layer: its planetoid's center...
    extern number bulgeRadius;    // ...and the water's outer radius...
    extern number causticBulge;   // ...and how much its caustics bulge like a globe's (0 for pools)
    extern number sphereShading;  // 1: lit as a sphere by the sun (a planetoid's water), 0: the depth gradient (pools)
    extern vec2 sunDir;           // unit vector from the planetoid toward the sun
    extern vec3 sphereShallow;
    extern vec3 sphereDeep;
    extern vec3 sphereShade;
    extern number sphereShadeStrength;
    extern vec3 sphereRim;
    extern number sphereRimStrength;
    extern vec3 sphereReflected;
    extern number sphereReflectedStrength;

    // Pseudo-random 2D hash (no built-in noise in LOVE's shader dialect).
    vec2 hash2(vec2 p) {
      p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
      return fract(sin(p) * 43758.5453123);
    }

    // Voronoi: distance to the nearest and second-nearest scattered point
    // (one per grid cell, drifting with time). Where they're about equal
    // is a cell boundary — the bright thread of a caustic net.
    vec2 voronoi(vec2 p, float t) {
      vec2 ip = floor(p);
      vec2 fp = fract(p);
      float f1 = 8.0;
      float f2 = 8.0;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 neighbor = vec2(float(x), float(y));
          vec2 h = hash2(ip + neighbor);
          vec2 pt = neighbor + 0.5 + 0.4 * sin(t + 6.2831 * h) - fp;
          float d = length(pt);
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
        }
      }
      return vec2(f1, f2);
    }

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      float depth = uv.x;

      // A falling stream: bright streaks rushing down it.
      if (uv.y > 0.5) {
        float streak = 0.5 + 0.5 * sin(worldPos.y * 0.18 - time * 14.0 + worldPos.x * 0.9);
        vec3 c = mix(colorShallow, colorSurface, 0.3 + 0.45 * streak);
        return vec4(c, 0.55 + 0.3 * streak);
      }

      // Shallow to deep, more see-through near the top.
      float t = clamp(depth / deepAt, 0.0, 1.0);
      vec3 c = mix(colorShallow, colorDeep, t);
      float a = mix(alphaShallow, alphaDeep, t);

      // A planetoid's water, instead: shaded as a sphere lit by the sun
      // (as the water planets were) — each point's normal on a sphere
      // the size of the water bulging toward the viewer, bright facing
      // the sun and falling off into shade away from it, a little deeper
      // toward the middle, a bright rim along the sun side's edge, and a
      // dimmer reflected highlight along the edge furthest from the sun
      // (light bouncing back onto the dark side, the way a shaded ball
      // never goes flat black there).
      if (sphereShading > 0.0) {
        vec2 fromCenter = worldPos - bulgeCenter;
        float dist = length(fromCenter);
        float nxy = clamp(dist / bulgeRadius, 0.0, 1.0);
        vec2 inPlane = dist > 0.0001 ? fromCenter / dist : vec2(0.0);
        vec3 normal = vec3(inPlane * nxy, sqrt(max(0.0, 1.0 - nxy * nxy)));
        float facing = dot(normal, normalize(vec3(sunDir, 0.5)));
        float lightT = smoothstep(-0.3, 0.7, facing);
        vec3 s = mix(sphereShade, sphereShallow, mix(1.0 - sphereShadeStrength, 1.0, lightT));
        s = mix(sphereDeep, s, mix(0.55, 1.0, nxy));
        float rimT = smoothstep(0.6, 1.0, nxy) * clamp(facing, 0.0, 1.0);
        s = mix(s, sphereRim, rimT * sphereRimStrength);
        float reflectedT = smoothstep(0.65, 1.0, nxy) * (1.0 - lightT);
        s = mix(s, sphereReflected, reflectedT * sphereReflectedStrength);
        c = mix(c, s, sphereShading);
      }

      // The caustic net: gently warped so its threads wobble, strongest
      // near the surface and fading away with depth.
      // On a planetoid's water: sampled as if painted on a globe bulging
      // toward the viewer — distance from the center re-mapped from r to
      // radius * asin(r / radius), so the cells read bigger and rounder
      // in the middle and crowd together toward the rim. (The asin input
      // is held just shy of 1, where the cells would get infinitely
      // dense right on the silhouette.)
      vec2 cp = worldPos;
      if (causticBulge > 0.0) {
        vec2 fromCenter = worldPos - bulgeCenter;
        float dist = length(fromCenter);
        float onGlobe = bulgeRadius * asin(clamp(dist / bulgeRadius, 0.0, 0.98));
        if (dist > 0.0001) cp = bulgeCenter + fromCenter / dist * mix(dist, onGlobe, causticBulge);
      }
      vec2 p = cp / causticScale;
      p += 0.25 * vec2(sin(p.y * 1.7 + time * 0.9), cos(p.x * 1.3 - time * 0.7));
      vec2 v = voronoi(p, time * causticSpeed);
      float thread = 1.0 - smoothstep(0.0, 0.06, v.y - v.x);
      c += colorCaustic * thread * causticStrength * (1.0 - t * 0.85);

      // Above the surface (the feathered strip on top): the line fading
      // out to nothing, for a soft edge.
      if (depth < 0.0) {
        float fade = smoothstep(-surfaceFeather, 0.0, depth);
        return vec4(colorSurface, 0.85 * fade) * color;
      }

      // Along the surface: a bright band — solid through its top part,
      // then fading softly down into the water — and a wider soft glow
      // just under it.
      float line = 1.0 - smoothstep(surfaceLine * 0.3, surfaceLine, depth);
      float glow = 1.0 - smoothstep(0.0, surfaceGlow, depth);
      c += colorSurface * glow * 0.18;
      c = mix(c, colorSurface, line * 0.75);
      a = max(a, line * 0.85);

      return vec4(c, a) * color;
    }
    #endif
  ]])
  -- (The settings that never change: sent once here, not on every draw.
  -- The rest are set in useWaterShader, and changed for each water body
  -- in drawOceans.)
  waterShader:send("colorShallow", COLOR_SHALLOW)
  waterShader:send("colorDeep", COLOR_DEEP)
  waterShader:send("deepAt", DEEP_AT)
  waterShader:send("alphaShallow", ALPHA_SHALLOW)
  waterShader:send("alphaDeep", ALPHA_DEEP)
  waterShader:send("colorSurface", COLOR_SURFACE)
  waterShader:send("surfaceLine", SURFACE_LINE)
  waterShader:send("surfaceFeather", SURFACE_FEATHER)
  waterShader:send("surfaceGlow", SURFACE_GLOW)
  waterShader:send("colorCaustic", COLOR_CAUSTIC)
  waterShader:send("sphereShallow", SPHERE_COLOR_SHALLOW)
  waterShader:send("sphereDeep", SPHERE_COLOR_DEEP)
  waterShader:send("sphereShade", SPHERE_COLOR_SHADE)
  waterShader:send("sphereShadeStrength", SPHERE_SHADE_STRENGTH)
  waterShader:send("sphereRim", SPHERE_COLOR_RIM)
  waterShader:send("sphereRimStrength", SPHERE_RIM_STRENGTH)
  waterShader:send("sphereReflected", SPHERE_COLOR_REFLECTED)
  waterShader:send("sphereReflectedStrength", SPHERE_REFLECTED_STRENGTH)
  waterShader:send("causticSpeed", CAUSTIC_SPEED)
  waterShader:send("causticStrength", CAUSTIC_STRENGTH)
  return waterShader
end

-- The water on the level, as one mesh drawn through the pool shader
-- above: a block per resting wet cell (from its rippling top surface
-- down, or full height deep in a pool), and a narrow stream down the
-- middle of each cell where water is falling.
local useWaterShader, useLavaShader

-- The vertices built in Scratch (see Scratch.vert) drawn through
-- `liquid`'s shader (the water's or the lava's), in the mesh kept for `slot`.
local function drawLiquidMesh(slot, liquid)
  local count = Scratch.vertCount
  local m = meshes[slot]
  if not m or meshSizes[slot] < count then
    meshSizes[slot] = math.max(count, (meshSizes[slot] or 0) * 2, 600)
    m = love.graphics.newMesh(meshSizes[slot], "triangles", "stream")
    meshes[slot] = m
  end
  m:setVertices(Scratch.verts, 1, count)
  m:setDrawRange(1, count)
  if liquid == LAVA then useLavaShader() else useWaterShader() end
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.draw(m)
  love.graphics.setShader()
end

-- (liquid: WATER or LAVA — the lava's drawn the same way, through its
-- own shader, its surface moving less.)
local function drawPools(liquid)
  local cam = state.camera
  if not cam then return end
  local vx0, vy0 = cam.x - CELL, cam.y - CELL
  local vx1, vy1 = cam.x + (state.visibleWidth or 0) + CELL, cam.y + (state.visibleHeight or 0) + CELL
  local cols, water = shared.grid.cols, shared.grid[liquid.key]
  local rippleScale = liquid == LAVA and LAVA_TUNING.RIPPLE or 1
  Scratch.resetVerts()
  if liquid == WATER then shared.waterfallLandings = {} end

  -- depth0/depth1: how far below the surface its top/bottom edges are
  -- (0 at the surface); stream: 1 for a falling stream.
  local function quad(x0, yTop0, x1, yTop1, yBottom0, yBottom1, depthTop, depthBottom, stream)
    Scratch.quad(x0, yTop0, x1, yTop1, x1, yBottom1, x0, yBottom0, depthTop, depthBottom, stream)
  end
  -- Two overlapping waves, so the surface moves less mechanically.
  local function ripple(x)
    return (math.sin(shared.age * 2.2 + x * 0.045) * 1.3 + math.sin(shared.age * 3.7 - x * 0.11) * 0.6) * rippleScale
  end

  -- The water resting in each column, drawn as one stack: everything in
  -- it from its floor up, packed down — so a surface sloping gently
  -- across the rows (water still flowing along, its edge a run of part-
  -- full cells on top of full ones) is drawn at its real, smooth height
  -- instead of stepping row to row, with no stray streams in it. A stack
  -- takes in at most two part-full cells over its full ones, each holding
  -- less than the one under it; anything above that is still falling
  -- (a waterfall pouring into a pool, say), drawn as a stream.
  -- stackSurface[i]: the stack's surface, for every cell in it;
  -- stackTotal[i]: how many cells' worth it holds; stackFloor[i]: its
  -- bottom cell, which draws the whole stack (in one piece, so its
  -- surface can sit at any height without being cut off at a cell edge).
  local stackSurface, stackTotal, stackFloor = {}, {}, {}
  local capped, capDepth = {}, {} -- (by a stack's floor cell: see below)
  for i in pairs(water) do
    local r = math.floor((i - 1) / cols)
    local c = (i - 1) - r * cols
    if blocked(c, r, 0, 1) then -- the bottom of a stack
      local members, total, partials, below = {}, 0, 0, math.huge
      local j, jr = i, r
      while jr >= 0 and water[j] do
        local w = math.min(1, water[j])
        if w < 0.99 then
          if partials == 2 or w >= below then break end
          partials = partials + 1
        end
        members[#members + 1] = j
        total = total + w
        below = w
        j, jr = j - cols, jr - 1
      end
      local surface = shared.grid.y0 + (r + 1) * CELL - math.max(2, total * CELL)
      for _, m in ipairs(members) do
        stackSurface[m] = surface
        stackTotal[m] = total
        stackFloor[m] = i
      end
      -- Full right up to something solid over it (under an ice block,
      -- say): it has no surface of its own — see capDepth below.
      local topRow = r - #members + 1
      if total >= #members - 0.01 and topRow > 0 and isSolid(c, topRow - 1) then capped[i] = topRow end
    end
  end
  -- A capped stack's depth below the open water's surface beside it (the
  -- nearest column either side that isn't capped, reaching up past its
  -- top), so it's shaded on down from there instead of starting fresh
  -- under the cap. Its top's flat against the cap: no ripple, no
  -- surface line.
  for i, topRow in pairs(capped) do
    local r = math.floor((i - 1) / cols)
    local c = (i - 1) - r * cols
    for d = 1, 8 do
      local found
      for side = -1, 1, 2 do -- (c - d, then c + d)
        local nc = c + side * d
        local n = r * cols + nc + 1
        if nc >= 0 and nc < cols and stackFloor[n] and not capped[stackFloor[n]] and stackSurface[n] < stackSurface[i] then
          found = stackSurface[n]
          break
        end
      end
      if found then
        capDepth[i] = stackSurface[i] - found
        break
      end
    end
  end

  -- Not part of a stack: still falling.
  local function isFalling(i)
    return not stackSurface[i]
  end

  -- Slopes (see WaterSystem.init): the floor's actual height at x under a
  -- cell on one, and how thick a sheet of water running down it is.
  local slope = shared.grid.slope
  local function slopeY(line, x)
    x = math.max(line.xMin, math.min(line.xMax, x))
    return line.ay + (x - line.ax) * line.k
  end
  local function sheetThickness(w)
    return math.max(3, math.min(1, w) * CELL)
  end
  -- The water in the next cell along the slope (beside, a row up or a row
  -- down), if any — so neighboring bits of the sheet meet at one thickness.
  local function slopeNeighbor(c, r, dc)
    local nc = c + dc
    if nc < 0 or nc >= cols then return nil end
    for dr = -1, 1 do
      local nr = r + dr
      if nr >= 0 and nr < shared.grid.rows then
        local j = nr * cols + nc + 1
        if slope[j] and stackTotal[j] then return stackTotal[j] end
      end
    end
    return nil
  end
  -- The surface of the pool a resting cell belongs to.
  local function surfaceY(i)
    return stackSurface[i]
  end

  for i, w in pairs(water) do
    local r = math.floor((i - 1) / cols)
    local c = (i - 1) - r * cols
    local x0 = shared.grid.x0 + c * CELL
    local yTopCell = shared.grid.y0 + r * CELL
    -- (A stack's other cells are drawn along with its floor cell, which
    -- reaches up to the stack's surface.)
    local drawn = not stackFloor[i] or stackFloor[i] == i
    local reachTop = stackSurface[i] and math.min(yTopCell, stackSurface[i] - CELL) or yTopCell
    if drawn and x0 < vx1 and x0 + CELL > vx0 and reachTop < vy1 and yTopCell + CELL > vy0 then
      local x1 = x0 + CELL
      local bottom = yTopCell + CELL
      -- A little water just settling onto a pool: landed (or got pushed
      -- up) into the cell above the surface, with nothing falling above
      -- it — it merges into the pool next step. Drawn as a stream it would
      -- flash as a stray one-cell line sticking up out of the surface, so
      -- it isn't drawn at all. (A real waterfall always has more falling
      -- water above, so it still reaches down to the pool.)
      local settling = isFalling(i, c, r)
        and not water[i - cols] and not water[i - 2 * cols]
        and water[i + cols] and not isFalling(i + cols, c, r + 1)
      -- Stepping down a slope: water running off one of its stair-steps
      -- onto the next, a cell or two down. The sheet drawn along the slope
      -- already covers it, so it isn't drawn as a little waterfall. (A real
      -- waterfall onto a slope has more falling water above.)
      local stepping = isFalling(i, c, r) and not water[i - 2 * cols]
        and (slope[i + cols] or slope[i + 2 * cols])
      if settling or stepping then
        -- (nothing)
      elseif isFalling(i, c, r) then
        -- Falling (open space below, not yet resting on anything): a
        -- narrow, unbroken stream down the middle of the column — wider
        -- the more water is falling. A light trickle falls as separate
        -- little parcels (wet, dry, wet down the column); reaching over a
        -- dry cell right below closes those gaps into one stream.
        local half = CELL * math.min(1, 0.25 + w * 2.5) / 2
        local mid = x0 + CELL / 2
        -- Down through any dry space below (between parcels of a trickle,
        -- or the last stretch to the ground) until it meets the ground, a
        -- pool's surface, or more falling water — so it always reaches.
        local streamBottom = bottom
        local j, jr, gap = i + cols, r + 1, 0
        while gap < STREAM_REACH_CELLS and jr < shared.grid.rows and not water[j] and not blocked(c, jr - 1, 0, 1) do
          j, jr, gap = j + cols, jr + 1, gap + 1
          streamBottom = streamBottom + CELL
        end
        if water[j] and jr < shared.grid.rows and not isFalling(j, c, jr) then
          streamBottom = math.max(streamBottom, surfaceY(j, jr)) -- into the pool's surface
        end

        -- Pouring over an edge: resting water right beside it (the sheet
        -- on top of a ledge it's spilling off). The stream starts at that
        -- water's surface, and a short lip of water runs from the ledge's
        -- edge over to the stream — so the pour is one piece with the
        -- water it comes from, not a separate stream beside it.
        local streamTop = yTopCell
        local function sourceSurface(dc)
          local nc = c + dc
          if nc < 0 or nc >= cols then return nil end
          local n = i + dc
          if water[n] and not isFalling(n, nc, r) then return surfaceY(n, r) end
          if r > 0 and water[n - cols] and not isFalling(n - cols, nc, r - 1) then
            return surfaceY(n - cols, r - 1)
          end
          return nil
        end
        local srcLeft, srcRight = sourceSurface(-1), sourceSurface(1)
        local src, side = srcLeft, -1
        if srcRight and (not srcLeft or srcRight < srcLeft) then src, side = srcRight, 1 end
        if src then
          streamTop = src -- (not its cell's top, which can stick up above a thin sheet)
          local edgeX = side < 0 and x0 or x1
          local lipTop = src + ripple(edgeX)
          if side < 0 then
            quad(edgeX, lipTop, mid, src + 2, lipTop + LIP_THICKNESS, src + 2 + LIP_THICKNESS, 0, 0, 1)
          else
            quad(mid, src + 2, edgeX, lipTop, src + 2 + LIP_THICKNESS, lipTop + LIP_THICKNESS, 0, 0, 1)
          end
        end
        quad(mid - half, streamTop, mid + half, streamTop, streamBottom, streamBottom, 0, 0, 1)

        -- The bottom of a waterfall, landing on the ground or a pool: it
        -- splashes there (see WaterSystem.update), if it's fallen far
        -- enough — up the column through the rest of the falling water.
        if blocked(c, jr - 1, 0, 1) or (water[j] and not isFalling(j)) then
          local fallTop, k = streamTop, i - cols
          for _ = 1, 32 do
            if not (water[k] and isFalling(k)) then break end
            fallTop, k = fallTop - CELL, k - cols
          end
          if liquid == WATER and streamBottom - fallTop >= WATERFALL_SPLASH_MIN_FALL then
            shared.waterfallLandings[#shared.waterfallLandings + 1] = { x = mid, y = streamBottom, half = half, flow = math.min(1, w * 4) }
          end
        end
      else
        local surface = surfaceY(i, r)
        local line = slope[i]
        -- Where its bottom is at x: the cell's bottom, or on a slope, the
        -- slope itself (down into the stair-step under the cell).
        local function bottomAt(x)
          return line and math.max(bottom, slopeY(line, x)) or bottom
        end
        if line and stackTotal[i] < 0.99 then
          -- A thin sheet on a slope: lying along it, at a thickness easing
          -- into the next bits of the sheet up and down the slope.
          local t = sheetThickness(stackTotal[i])
          local wl, wr = slopeNeighbor(c, r, -1), slopeNeighbor(c, r, 1)
          local tl = (t + (wl and sheetThickness(wl) or t * 0.5)) / 2
          local tr = (t + (wr and sheetThickness(wr) or t * 0.5)) / 2
          local function thicknessAt(f)
            if f < 0.5 then return tl + (t - tl) * f * 2 end
            return t + (tr - t) * (f - 0.5) * 2
          end
          for s = 0, SURFACE_SLICES - 1 do
            local fa, fb = s / SURFACE_SLICES, (s + 1) / SURFACE_SLICES
            local xa, xb = x0 + CELL * fa, x0 + CELL * fb
            local ba, bb = slopeY(line, xa), slopeY(line, xb)
            local tha, thb = thicknessAt(fa), thicknessAt(fb)
            local ta = ba - tha + ripple(xa) * 0.3
            local tb = bb - thb + ripple(xb) * 0.3
            quad(xa, ta, xb, tb, ba, bb, 0, (tha + thb) / 2, 0)
            quad(xa, ta - SURFACE_FEATHER, xb, tb - SURFACE_FEATHER, ta, tb, -SURFACE_FEATHER, 0, 0)
          end
        else
          -- The stack: from its rippling surface down to its floor, in thin
          -- slices whose height eases toward the neighboring columns'
          -- water line (so the surface curves smoothly instead of stepping
          -- column to column).
          -- The neighbor's water line: the stack in the column beside this
          -- one, found by its cell beside this one or — where the surface
          -- slopes across a row boundary — the one beside and below or
          -- above it. Nothing there: stay level.
          local function neighborSurface(dc)
            local nc = c + dc
            if nc < 0 or nc >= cols then return surface end
            local j = i + dc
            local s = surfaceY(j) or surfaceY(j + cols) or surfaceY(j - cols)
            if not s or math.abs(s - surface) > CELL * 1.5 then return surface end
            -- (Nor toward a capped neighbor's — or, capped, any — "surface":
            -- see capDepth.)
            local nf = stackFloor[j] or stackFloor[j + cols] or stackFloor[j - cols]
            if (nf and capped[nf]) or capped[stackFloor[i]] then return surface end
            return s
          end
          local left, right = neighborSurface(-1), neighborSurface(1)
          local cap = capped[stackFloor[i]] and (capDepth[stackFloor[i]] or 0)
          local rippleHere = cap and function() return 0 end or ripple
          local function heightAt(f) -- f: 0..1 across the cell
            local h
            if f < 0.5 then
              local k = 0.5 + f -- from the left neighbor's middle (0) to this one's (1)
              h = left + (surface - left) * (0.5 - 0.5 * math.cos(math.pi * k))
            else
              local k = f - 0.5
              h = surface + (right - surface) * (0.5 - 0.5 * math.cos(math.pi * k))
            end
            return h
          end
          for s = 0, SURFACE_SLICES - 1 do
            local fa, fb = s / SURFACE_SLICES, (s + 1) / SURFACE_SLICES
            local xa, xb = x0 + CELL * fa, x0 + CELL * fb
            local ha, hb = heightAt(fa), heightAt(fb)
            local ta = math.min(ha + rippleHere(xa), bottom - 1)
            local tb = math.min(hb + rippleHere(xb), bottom - 1)
            local ba, bb = bottomAt(xa), bottomAt(xb)
            local d0 = cap or 0
            quad(xa, ta, xb, tb, ba, bb, d0, d0 + (ba + bb) / 2 - (ha + hb) / 2, 0)
            -- A thin strip just above the surface (negative depth) that the
            -- shader fades out, so the top edge is soft rather than a hard
            -- pixel line. (Not under a cap: there's no surface there.)
            if not cap then
              quad(xa, ta - SURFACE_FEATHER, xb, tb - SURFACE_FEATHER, ta, tb, -SURFACE_FEATHER, 0, 0)
            end
          end
        end
      end
    end
  end

  if Scratch.vertCount == 0 then return end
  drawLiquidMesh(liquid.key, liquid)
end

-- Turns on the water shader with every setting from the tunables above
-- (shared by the pools and the planets' water layers).
-- (The settings that never change are sent once, in getWaterShader. These
-- are the ones drawOceans changes for each water body, put back for the
-- pools.)
do
local POOL_BULGE_CENTER, POOL_SUN_DIR = { 0, 0 }, { 1, 0 } -- (in this do-block: see LAVA_TUNING on the 200-local limit)
useWaterShader = function()
  local shader = getWaterShader()
  shader:send("time", shared.age)
  shader:send("causticScale", CAUSTIC_SCALE)
  shader:send("bulgeCenter", POOL_BULGE_CENTER)
  shader:send("bulgeRadius", 1)
  shader:send("causticBulge", 0) -- (flat, for the pools — see drawOceans)
  shader:send("sphereShading", 0) -- (likewise)
  shader:send("sunDir", POOL_SUN_DIR)
  love.graphics.setShader(shader)
end
end

-- The lava's shader: the same shapes as the water's (each vertex's
-- texture coordinates carry how far below the surface it is, and whether
-- it's a falling stream), filled with Lava.lua's churning plasma —
-- hottest along the surface, darker and crustier deeper down, solid
-- rather than see-through, and pouring down a falling stream.
local getLavaShader
do
local lavaShader = nil -- (kept inside this do-block: see LAVA_TUNING on the 200-local limit)
getLavaShader = function()
  if lavaShader then return lavaShader end
  lavaShader = love.graphics.newShader([[
    varying vec2 worldPos;

    #ifdef VERTEX
    vec4 position(mat4 transform_projection, vec4 vertex_position) {
      worldPos = vertex_position.xy;
      return transform_projection * vertex_position;
    }
    #endif

    #ifdef PIXEL
    extern number time;
    extern vec3 colorDeep;
    extern vec3 colorMid;
    extern vec3 colorHot;
    extern number glowBand;
    extern number plasmaScale;
    extern number detailScale;
    extern number evolveSpeed;
    extern number scrollSpeed;
    extern number pourSpeed;
    extern number surfaceFeather;

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float valueNoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
    float fbm(vec2 p) {
      float value = 0.0;
      float amp = 0.5;
      for (int i = 0; i < 4; i++) {
        value += amp * valueNoise(p);
        p *= 2.02;
        amp *= 0.55;
      }
      return value;
    }

    vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
      float depth = uv.x;
      bool falling = uv.y > 0.5;
      // (Falling, the pattern pours down the stream instead of churning in place.)
      vec2 gp = worldPos * plasmaScale + (falling ? vec2(0.0, -time * pourSpeed)
                                                  : vec2(time * scrollSpeed, -time * evolveSpeed));
      float grain = fbm(gp);
      float speck = fbm(gp * detailScale + 5.2);
      float v = clamp(grain * 0.7 + speck * 0.3, 0.0, 1.0);
      float glowBias = falling ? 0.5 : clamp(1.0 - depth / glowBand, 0.0, 1.0);
      v = clamp(v * 0.55 + glowBias * 0.6, 0.0, 1.0);
      vec3 c = mix(colorDeep, colorMid, smoothstep(0.25, 0.55, v));
      c = mix(c, colorHot, smoothstep(0.6, 0.9, v));
      // (The strip over the surface fades out, for a soft edge.)
      float a = depth < 0.0 ? smoothstep(-surfaceFeather, 0.0, depth) : 1.0;
      return vec4(c, a) * color;
    }
    #endif
  ]])
  -- (The settings that never change: sent once here, not on every draw.)
  lavaShader:send("colorDeep", LAVA_TUNING.COLOR_DEEP)
  lavaShader:send("colorMid", LAVA_TUNING.COLOR_MID)
  lavaShader:send("colorHot", LAVA_TUNING.COLOR_HOT)
  lavaShader:send("glowBand", LAVA_TUNING.GLOW_BAND)
  lavaShader:send("plasmaScale", LAVA_TUNING.PLASMA_SCALE)
  lavaShader:send("detailScale", LAVA_TUNING.PLASMA_DETAIL)
  lavaShader:send("evolveSpeed", LAVA_TUNING.EVOLVE_SPEED)
  lavaShader:send("scrollSpeed", LAVA_TUNING.SCROLL_SPEED)
  lavaShader:send("pourSpeed", LAVA_TUNING.POUR_SPEED)
  lavaShader:send("surfaceFeather", SURFACE_FEATHER)
  return lavaShader
end
end

useLavaShader = function()
  local shader = getLavaShader()
  shader:send("time", shared.age) -- (the rest never change: sent once, in getLavaShader)
  love.graphics.setShader(shader)
end

-- How big the caustic net's cells are in a layer of water this deep:
-- CAUSTIC_SCALE for a sprayed layer (up to CAUSTIC_GROW_FROM_DEPTH deep),
-- growing for deeper ones — a water planet's are several times bigger.
local function causticScaleFor(depth)
  local grow = math.max(1, depth / CAUSTIC_GROW_FROM_DEPTH) ^ CAUSTIC_GROW_POWER
  return CAUSTIC_SCALE * math.min(CAUSTIC_MAX_GROWTH, grow)
end

-- Round planetoid p's own surface, as points (each with its outward
-- normal and how far round it is, for the ripple) close enough together
-- for the water's surface `depth` out from it to curve smoothly — a
-- circle's, or a rounded rectangle's edges and corners (its corners'
-- share more of them, since the water's surface round a corner is
-- longer than the corner itself).
local function outlineOf(p, depth)
  local points = {}
  if p.isRoundedRect then
    local cr, along = p.cornerRadius, 0
    local function add(lx, ly, nx, ny)
      local w = p:localPointToWorld(lx, ly)
      local n = p:localDirToWorld(nx, ny)
      points[#points + 1] = { x = w.x, y = w.y, nx = n.x, ny = n.y, s = along }
    end
    for _, seg in ipairs(p._segments) do
      if seg.type == "edge" then
        local steps = math.max(1, math.ceil(seg.length / 10))
        for k = 0, steps - 1 do
          local t = seg.length * k / steps
          add(seg.start.x + seg.dir.x * t, seg.start.y + seg.dir.y * t, seg.normal.x, seg.normal.y)
          along = along + seg.length / steps
        end
      else
        local arc = (cr + depth) * math.pi / 2
        local steps = math.max(2, math.ceil(arc / 10))
        for k = 0, steps - 1 do
          local a = seg.startAngle + (math.pi / 2) * k / steps
          local c, s = math.cos(a), math.sin(a)
          add(seg.center.x + c * cr, seg.center.y + s * cr, c, s)
          along = along + arc / steps
        end
      end
      if #points > OCEAN_MAX_SEGMENTS then break end
    end
  else
    local R, outer = p.radius, p.radius + depth
    -- Enough for the ripple round a big one too (a water planet's is
    -- thousands of units round).
    local n = math.max(OCEAN_SEGMENTS, math.min(OCEAN_MAX_SEGMENTS, math.floor(2 * math.pi * outer / 10)))
    for k = 0, n - 1 do
      local a = k / n * math.pi * 2
      local c, s = math.cos(a), math.sin(a)
      points[#points + 1] = { x = p.pos.x + c * R, y = p.pos.y + s * R, nx = c, ny = s, s = a * outer }
    end
  end
  return points
end

-- The water layers round planetoids (see addToOcean), through the same
-- shader as the pools: a band from the planetoid's surface out to the
-- water's rippling surface (depth measured in from there), plus a thin
-- feathered strip just outside it for a soft edge. Each drawn on its own,
-- with caustics sized for how deep it is (see causticScaleFor); a round
-- one's lit as a sphere, with caustics bulging like a globe's.
local oceanMesh, oceanMeshSize = nil, 0
local function drawOceans()
  local cam = state.camera
  if not cam or not next(shared.oceans) then return end
  local vx0, vy0 = cam.x, cam.y
  local vx1, vy1 = cam.x + (state.visibleWidth or 0), cam.y + (state.visibleHeight or 0)
  local shaderOn = false
  for p, o in pairs(shared.oceans) do
    local depth = depthOf(p, o.volume)
    local reach = p.radius + depth + SURFACE_FEATHER + 6
    if p.pos.x + reach > vx0 and p.pos.x - reach < vx1 and p.pos.y + reach > vy0 and p.pos.y - reach < vy1 then
      Scratch.resetVerts()
      local function vert(x, y, d, alpha) Scratch.vert(x, y, d, 0, alpha or 1) end
      local cx, cy = p.pos.x, p.pos.y
      local outline = outlineOf(p, depth)
      local n = #outline
      local function top(q)
        local rip = math.sin(shared.age * 2.2 + q.s * 0.045) * 1.3 + math.sin(shared.age * 3.7 - q.s * 0.11) * 0.6
        local h = math.max(1, depth + rip)
        return q.x + q.nx * h, q.y + q.ny * h, q.x + q.nx * (h + SURFACE_FEATHER), q.y + q.ny * (h + SURFACE_FEATHER)
      end
      for k = 1, n do
        local a, b = outline[k], outline[k % n + 1]
        local ax, ay, afx, afy = top(a)
        local bx, by, bfx, bfy = top(b)
        -- Body: planetoid surface (deepest) out to the water's surface.
        vert(a.x, a.y, depth); vert(b.x, b.y, depth); vert(bx, by, 0)
        vert(a.x, a.y, depth); vert(bx, by, 0); vert(ax, ay, 0)
        -- Feathered edge just outside the surface.
        vert(ax, ay, 0); vert(bx, by, 0); vert(bfx, bfy, -SURFACE_FEATHER)
        vert(ax, ay, 0); vert(bfx, bfy, -SURFACE_FEATHER); vert(afx, afy, -SURFACE_FEATHER)
      end

      -- Over the planetoid itself: the water seen through to it, faded by
      -- how deep the water is — not at all under a sliver, more and more
      -- (color, caustics and all) as it deepens (see CORE_OVERLAY_*).
      local overlay = math.min(1, math.max(0, (depth - CORE_OVERLAY_FROM_DEPTH)
        / (CORE_OVERLAY_FULL_DEPTH - CORE_OVERLAY_FROM_DEPTH))) * CORE_OVERLAY_MAX
      if overlay > 0 then
        for k = 1, n do
          local a, b = outline[k], outline[k % n + 1]
          vert(cx, cy, depth, overlay); vert(a.x, a.y, depth, overlay); vert(b.x, b.y, depth, overlay)
        end
      end

      local count = Scratch.vertCount
      if not oceanMesh or oceanMeshSize < count then
        oceanMeshSize = math.max(count, oceanMeshSize * 2, 600)
        oceanMesh = love.graphics.newMesh(oceanMeshSize, "triangles", "stream")
      end
      oceanMesh:setVertices(Scratch.verts, 1, count)
      oceanMesh:setDrawRange(1, count)
      if not shaderOn then
        useWaterShader()
        love.graphics.setColor(1, 1, 1, 1)
        shaderOn = true
      end
      local shader = getWaterShader()
      shader:send("causticScale", causticScaleFor(depth))
      if p.isRoundedRect then
        -- (Not a sphere: the plain depth gradient, flat caustics.)
        shader:send("causticBulge", 0)
        shader:send("sphereShading", 0)
      else
        shader:send("bulgeCenter", { cx, cy })
        shader:send("bulgeRadius", p.radius + depth)
        shader:send("causticBulge", CAUSTIC_BULGE)
        -- Lit as a sphere by the sun (the same "sun at the exact center
        -- of the scene" convention the planetoids' own shading uses).
        local sdx, sdy = (state.sceneWidth or 0) / 2 - cx, (state.sceneHeight or 0) / 2 - cy
        local sd = math.sqrt(sdx * sdx + sdy * sdy)
        if sd < 1 then sdx, sdy, sd = 1, 0, 1 end
        shader:send("sphereShading", 1)
        shader:send("sunDir", { sdx / sd, sdy / sd })
      end
      love.graphics.draw(oceanMesh)
    end
  end
  if shaderOn then love.graphics.setShader() end
end

-- In world space (inside the camera transform). Drawn after Bob, so
-- he looks like he's in the water when he's swimming.
-- A dirt planet's water (see "Water on a dirt planet"), through the same
-- shader and the same way as the pools (see drawPools — the same rules,
-- on the planet's grid: "down" toward its center, or down the flat
-- layout's rows; a column's height measured up from there):
--   - each column's resting water drawn as one stack from its floor up,
--     taking in up to two part-full cells over its full ones, at its real
--     height, so a pool's edge or a gently sloping surface doesn't step
--     row to row or throw up stray streams;
--   - a little water just settling onto a pool, or spilling a cell or
--     two down a step onto water below, not drawn at all (it's part of
--     the pool by next step; drawn as a stream it'd stick up out of the
--     surface as a one-cell spike);
--   - the surface in thin slices easing toward the columns either side
--     and rippling, so it curves rather than stepping column to column;
--   - and falling water as a narrow stream down the middle of its column,
--     reaching down through any dry gap to whatever it's falling onto.
-- Only what's on screen. (Positions are in columns, f — c + 0.5 is
-- column c's middle — and heights, h: see planetPoint.)
-- (liquid: WATER or LAVA, as drawPools.)
local function drawPlanetWater(g, liquid)
  local cam = state.camera
  if not cam then return end
  local margin = CELL * 4
  local vx0, vy0 = cam.x - margin, cam.y - margin
  local vx1, vy1 = cam.x + (state.visibleWidth or 0) + margin, cam.y + (state.visibleHeight or 0) + margin
  local px, py = g.planet.pos.x, g.planet.pos.y
  local cols, water, rows = g.cols, g[liquid.key], g.rows
  local rippleScale = liquid == LAVA and LAVA_TUNING.RIPPLE or 1
  Scratch.resetVerts()

  -- How high row r's bottom edge is.
  local function cellBottom(r) return g.top - (r + 1) * CELL end
  -- A strip from column position f0 to f1: hTop0/hTop1 the height of its
  -- top edge at each end, hBottom0/hBottom1 its bottom's; depthTop/
  -- depthBottom how far below the surface those edges are; stream 1 for
  -- falling water.
  local function quad(f0, hTop0, f1, hTop1, hBottom0, hBottom1, depthTop, depthBottom, stream)
    local x1, y1 = planetPoint(g, f0, hTop0)
    local x2, y2 = planetPoint(g, f1, hTop1)
    local x3, y3 = planetPoint(g, f1, hBottom1)
    local x4, y4 = planetPoint(g, f0, hBottom0)
    Scratch.quad(px + x1, py + y1, px + x2, py + y2, px + x3, py + y3, px + x4, py + y4,
      depthTop, depthBottom, stream)
  end
  -- Where the ground under resting water in cell row r really is, at
  -- column position f: on the flat layout, its square cells don't follow
  -- the planet's curved ground, so found between the middles of the cell
  -- and the one under it (round the planet, the cell's own bottom).
  local planet = g.planet
  local function floorAt(f, r)
    local bottom = cellBottom(r)
    if not g.flat then return bottom end
    local lo, hi = bottom - CELL * 0.5, bottom + CELL * 0.5
    if planet:solidAtLocal(planetPoint(g, f, hi)) then return hi end
    if not planet:solidAtLocal(planetPoint(g, f, lo)) then return lo end
    for _ = 1, 5 do
      local mid = (lo + hi) / 2
      if planet:solidAtLocal(planetPoint(g, f, mid)) then lo = mid else hi = mid end
    end
    return (lo + hi) / 2
  end
  -- (The same two waves as the pools', by distance along the surface.)
  local function ripple(f, h)
    local s = g.flat and f * CELL or (g.a0 + f * g.dA) * h
    return (math.sin(shared.age * 2.2 + s * 0.045) * 1.3 + math.sin(shared.age * 3.7 - s * 0.11) * 0.6) * rippleScale
  end

  -- The stacks (see drawPools): stackSurface[i] its surface's height,
  -- for every cell in it; stackFloor[i] its bottom cell, which draws it.
  local stackSurface, stackFloor = {}, {}
  local capped, capDepth = {}, {} -- (by a stack's floor cell: see drawPools')
  for i in pairs(water) do
    local r = math.floor((i - 1) / cols)
    local c = (i - 1) - r * cols
    if planetSolid(g, c, r + 1) then
      local members, total, partials, below = {}, 0, 0, math.huge
      local j, jr = i, r
      while jr >= 0 and water[j] do
        local w = math.min(1, water[j])
        if w < 0.99 then
          if partials == 2 or w >= below then break end
          partials = partials + 1
        end
        members[#members + 1] = j
        total = total + w
        below = w
        j, jr = j - cols, jr - 1
      end
      local surface = cellBottom(r) + math.max(2, total * CELL)
      for _, m in ipairs(members) do
        stackSurface[m] = surface
        stackFloor[m] = i
      end
      -- (Full up to something solid over it — an ice tile, say: see drawPools'.)
      local topRow = r - #members + 1
      if total >= #members - 0.01 and topRow > 0 and planetSolid(g, c, topRow - 1) then capped[i] = topRow end
    end
  end
  for i in pairs(capped) do
    local r = math.floor((i - 1) / cols)
    local c = (i - 1) - r * cols
    for d = 1, 8 do
      local found
      for side = -1, 1, 2 do -- (c - d, then c + d)
        local nc = planetCol(g, c + side * d)
        local n = nc and r * cols + nc + 1
        if n and stackFloor[n] and not capped[stackFloor[n]] and stackSurface[n] > stackSurface[i] then
          found = stackSurface[n]
          break
        end
      end
      if found then
        capDepth[i] = found - stackSurface[i]
        break
      end
    end
  end
  local function isFalling(i) return not stackSurface[i] end
  -- The resting water's surface in column c at about row r: that cell's
  -- stack, or the one just above or below it.
  local function surfaceNear(c, r)
    local cc = planetCol(g, c)
    if not cc then return nil end
    for step = 0, 2 do -- (r, then r + 1, then r - 1)
      local rr = (step == 0 and r) or (step == 1 and r + 1) or r - 1
      if rr >= 0 and rr < rows then
        local s = stackSurface[rr * cols + cc + 1]
        if s then return s end
      end
    end
    return nil
  end

  for i, w in pairs(water) do
    local r = math.floor((i - 1) / cols)
    local c = (i - 1) - r * cols
    local drawn = not stackFloor[i] or stackFloor[i] == i
    local fm = c + 0.5
    local rMid = g.top - (r + 0.5) * CELL
    local x, y = planetPoint(g, fm, rMid)
    x, y = px + x, py + y
    if drawn and x > vx0 and x < vx1 and y > vy0 and y < vy1 then
      local f0, f1 = c, c + 1
      local rTop, rBottom = g.top - r * CELL, cellBottom(r)

      -- Settling onto a pool, or stepping a cell or two down onto water
      -- below: not drawn (see above). A real waterfall always has more
      -- falling water above it, so it still is.
      local quiet = false
      if isFalling(i) and not water[i - 2 * cols] then
        local b1, b2 = i + cols, i + 2 * cols
        if (water[b1] and not isFalling(b1)) or (not water[b1] and water[b2] and not isFalling(b2)) then
          quiet = not water[i - cols] or not isFalling(i - cols)
        end
      end

      if quiet then
        -- (nothing)
      elseif isFalling(i) then
        local half = CELL * math.min(1, 0.25 + w * 2.5) / 2 / planetColWidth(g, rMid)
        local streamBottom = rBottom
        local j, jr, gap = i + cols, r + 1, 0
        while gap < STREAM_REACH_CELLS and jr < rows and not water[j] and not planetSolid(g, c, jr) do
          j, jr, gap = j + cols, jr + 1, gap + 1
          streamBottom = streamBottom - CELL
        end
        if water[j] and not isFalling(j) then streamBottom = math.min(streamBottom, stackSurface[j]) end

        -- Pouring over an edge (see drawPools): resting water right beside
        -- it, the sheet on the ledge it's spilling off. The stream starts
        -- at that water's surface, and a short lip of water runs from the
        -- ledge's edge over to the stream, so the pour is one piece with
        -- the water it comes from instead of a separate stream beside it.
        local streamTop = rTop
        local function sourceSurface(dc)
          local nc = planetCol(g, c + dc)
          if not nc then return nil end
          local n = r * cols + nc + 1
          if water[n] and not isFalling(n) then return stackSurface[n] end
          if r > 0 and water[n - cols] and not isFalling(n - cols) then return stackSurface[n - cols] end
          return nil
        end
        local srcBefore, srcAfter = sourceSurface(-1), sourceSurface(1)
        local src, side = srcBefore, -1
        if srcAfter and (not srcBefore or srcAfter > srcBefore) then src, side = srcAfter, 1 end
        if src then
          streamTop = src
          local edgeF = side < 0 and f0 or f1
          local lipTop = src + ripple(edgeF, src)
          if side < 0 then
            quad(edgeF, lipTop, fm, src - 2, lipTop - LIP_THICKNESS, src - 2 - LIP_THICKNESS, 0, 0, 1)
          else
            quad(fm, src - 2, edgeF, lipTop, src - 2 - LIP_THICKNESS, lipTop - LIP_THICKNESS, 0, 0, 1)
          end
        end
        quad(fm - half, streamTop, fm + half, streamTop, streamBottom, streamBottom, 0, 0, 1)
      else
        local surface = stackSurface[i]
        local cap = capped[stackFloor[i]] and (capDepth[stackFloor[i]] or 0)
        local function neighborSurface(dc)
          local s = surfaceNear(c + dc, r)
          if not s or math.abs(s - surface) > CELL * 1.5 or cap then return surface end
          return s
        end
        local left, right = neighborSurface(-1), neighborSurface(1)
        local function heightAt(f) -- f: 0..1 across the cell
          if f < 0.5 then
            local k = 0.5 + f
            return left + (surface - left) * (0.5 - 0.5 * math.cos(math.pi * k))
          end
          local k = f - 0.5
          return surface + (right - surface) * (0.5 - 0.5 * math.cos(math.pi * k))
        end
        -- (Its bottom on the ground under it: see floorAt.)
        local floorRow = math.floor((stackFloor[i] - 1) / cols)
        local fl = {}
        for s = 0, SURFACE_SLICES do
          fl[s] = (floorRow == r) and floorAt(c + s / SURFACE_SLICES, r) or rBottom
        end
        for s = 0, SURFACE_SLICES - 1 do
          local fa, fb = s / SURFACE_SLICES, (s + 1) / SURFACE_SLICES
          local ba, bb = fl[s], fl[s + 1]
          local ha, hb = heightAt(fa), heightAt(fb)
          local ta = math.max(ha + (cap and 0 or ripple(c + fa, surface)), ba + 1)
          local tb = math.max(hb + (cap and 0 or ripple(c + fb, surface)), bb + 1)
          local d0 = cap or 0
          quad(c + fa, ta, c + fb, tb, ba, bb, d0, d0 + (ha + hb) / 2 - (ba + bb) / 2, 0)
          -- (A strip over the top, for the surface's soft edge — not under a cap.)
          if not cap then
            quad(c + fa, ta + SURFACE_FEATHER, c + fb, tb + SURFACE_FEATHER, ta, tb, -SURFACE_FEATHER, 0, 0)
          end
        end
      end
    end
  end
  if Scratch.vertCount == 0 then return end
  drawLiquidMesh("planet-" .. liquid.key, liquid)
end

-- The obsidian blocks on the level (see "Lava meeting water"). (A dirt
-- planet's are part of its own picture.)
local function drawLevelObsidian()
  local image = nil
  for _, e in ipairs(shared.obsidians) do
    if e.kind == "level" then
      image = image or getObsidianImage()
      love.graphics.setColor(1, 1, 1, 1)
      love.graphics.draw(image, e.x0, e.y0, 0, e.size / image:getWidth(), e.size / image:getHeight())
    end
  end
end

local function drawLavaEmbers()
  for _, e in ipairs(shared.lavaEmbers) do
    local a = math.max(0, e.life)
    love.graphics.setColor(1, 0.35 + 0.5 * a, 0.05 + 0.25 * a, a)
    love.graphics.circle("fill", e.x, e.y, e.radius)
  end
end

function WaterSystem.draw()
  drawLevelObsidian()
  if shared.grid then drawPools(WATER) end
  for _, g in pairs(shared.planetGrids) do drawPlanetWater(g, WATER) end
  -- The ice blocks, in the water (see "Ice").
  Ice.drawLevel()
  -- The lava, over the water (and, like it, over Bob: he's in it).
  if shared.grid and next(shared.grid.lava) then drawPools(LAVA) end
  for _, g in pairs(shared.planetGrids) do
    if next(g.lava) then drawPlanetWater(g, LAVA) end
  end
  drawLavaEmbers()

  love.graphics.setLineWidth(2.5)
  for _, d in ipairs(shared.droplets) do
    local speed = math.sqrt(d.vx * d.vx + d.vy * d.vy)
    local tail = math.min(10, speed * 0.8) / math.max(speed, 0.001)
    -- (A lava droplet — out of a portal: see drainIntoPortals — hot,
    -- trailing darker; bigger, as lava's jets are thicker.)
    local head = d.lava and LAVA_TUNING.COLOR_HOT or COLOR_DROPLET
    local trail = d.lava and LAVA_TUNING.COLOR_MID or COLOR_DROPLET
    love.graphics.setColor(trail[1], trail[2], trail[3], d.lava and 0.9 or COLOR_DROPLET[4] * 0.6)
    love.graphics.line(d.x - d.vx * tail, d.y - d.vy * tail, d.x, d.y)
    love.graphics.setColor(head[1], head[2], head[3], d.lava and 1 or COLOR_DROPLET[4])
    love.graphics.circle("fill", d.x, d.y, d.lava and 3 or 2.2)
  end
  love.graphics.setLineWidth(1)
  for _, s in ipairs(shared.splashes) do
    local c = s.lava and LAVA_TUNING.COLOR_HOT or COLOR_DROPLET
    love.graphics.setColor(c[1], c[2], c[3], s.life / SPLASH_SECONDS)
    love.graphics.circle("fill", s.x, s.y, s.size)
  end
  love.graphics.setColor(1, 1, 1, 1)
end

-- The planetoids' water layers (see addToOcean), and steam over all the
-- water. Drawn later than WaterSystem.draw — after the fish as well as
-- Bob (see main.lua), so both read as under the water.
function WaterSystem.drawOceans()
  drawOceans()
  drawSteam()
end

return {
  api = WaterSystem,
}
