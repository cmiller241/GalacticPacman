-- svg_demo/materials.lua
--
-- What each part of the drawing is made of, and how that's lit.
--
-- A material is a set of numbers for one shared shader (see SHADER
-- below) — the planetoids' own sun shading (lua/world/Planetoid.lua)
-- at its heart, with dials for everything that makes one surface look
-- different from another:
--
--   wrap            how far the light wraps round into the dark side
--                   (0: the planetoids' own falloff; higher: softer, no
--                   real dark side — fur, cloth)
--   spec*           the round highlight (strength, size, how far toward
--                   the light) — what makes a surface read as shiny
--   sheen*          a band of highlight round the lit side instead of a
--                   spot (strength, how far out, how wide) — hair's sheen
--   rim*            the reflected highlight along the far edge (strength,
--                   width as a fraction of the part's size, colour, and
--                   how much the texture breaks it up)
--   detail*         the surface texture: which kind (none, "strands",
--                   "rock", "weave"), how fine, and how much it changes
--                   the brightness — or a grayscale image instead (see
--                   detailImage)
--   bump            how much the texture's hills and dips catch the light
--   crevice         how much its low spots are shadowed
--   fringe          hair sticking out past the outline (how far, as a
--                   fraction of the part's size; 0 none) — so a furry
--                   part's edge isn't a clean line
--   tint            a colour the part's own colours are multiplied by
--
-- detailImage (optional): a grayscale image in svg_demo/ (e.g.
-- "textures/fur.png") used as the texture instead of the generated one
-- — light is high, dark is low; it repeats, detailScale times across a
-- part's radius-ish. If it isn't there, the generated texture's used.

local Materials = {}

local DETAIL_KINDS = { none = 0, strands = 1, rock = 2, weave = 3 }

Materials.PRESETS = {
  -- The planetoids' own look: smooth, shiny, a crisp cool rim.
  metal = {
    wrap = 0, specAlpha = 0.22, specSize = 0.55, specOffset = 0.48,
    sheen = 0, sheenRadius = 0.6, sheenWidth = 0.12,
    rimStrength = 0.35, rimWidth = 0.07, rimColor = { 0.72, 0.85, 1.0 }, rimBreakup = 0,
    detail = "none", detailScale = 1, detailStrength = 0, bump = 0, crevice = 0, fringe = 0,
    tint = { 1, 1, 1 },
  },
  -- Glossy, but softer: a broad highlight, a gentle rim.
  rubber = {
    wrap = 0.12, specAlpha = 0.3, specSize = 0.85, specOffset = 0.4,
    sheen = 0, sheenRadius = 0.6, sheenWidth = 0.12,
    rimStrength = 0.22, rimWidth = 0.1, rimColor = { 1, 1, 1 }, rimBreakup = 0,
    detail = "none", detailScale = 1, detailStrength = 0, bump = 0, crevice = 0, fringe = 0,
    tint = { 1, 1, 1 },
  },
  -- Hair: light wrapping softly round, fine strands running out through
  -- it, a broken-up sheen band instead of a shiny spot, a soft warm rim,
  -- and tufts sticking out past the outline.
  fur = {
    wrap = 0.55, specAlpha = 0, specSize = 0.55, specOffset = 0.48,
    sheen = 0.32, sheenRadius = 0.62, sheenWidth = 0.13,
    rimStrength = 0.55, rimWidth = 0.16, rimColor = { 1.0, 0.94, 0.84 }, rimBreakup = 0.85,
    detail = "strands", detailScale = 34, detailStrength = 0.38, bump = 0.1, crevice = 0.12, fringe = 0.1,
    tint = { 0.98, 0.95, 0.9 },
  },
  -- Stone: a harder falloff, no shine, lumpy, shadowed crevices.
  rock = {
    wrap = 0, specAlpha = 0, specSize = 0.55, specOffset = 0.48,
    sheen = 0, sheenRadius = 0.6, sheenWidth = 0.12,
    rimStrength = 0.1, rimWidth = 0.05, rimColor = { 1, 0.95, 0.9 }, rimBreakup = 0.6,
    detail = "rock", detailScale = 5, detailStrength = 0.4, bump = 1.3, crevice = 0.45, fringe = 0,
    tint = { 0.8, 0.77, 0.72 },
  },
  -- Cloth / velvet: soft, no shine, brighter at its edges, a faint weave.
  cloth = {
    wrap = 0.35, specAlpha = 0, specSize = 0.55, specOffset = 0.48,
    sheen = 0, sheenRadius = 0.6, sheenWidth = 0.12,
    rimStrength = 0.45, rimWidth = 0.14, rimColor = { 1, 1, 1 }, rimBreakup = 0.15,
    detail = "weave", detailScale = 70, detailStrength = 0.06, bump = 0, crevice = 0, fringe = 0,
    tint = { 1, 1, 1 },
  },
  -- Glass (the visor, the eyes): a sharp bright highlight.
  glass = {
    wrap = 0, specAlpha = 0.35, specSize = 0.35, specOffset = 0.5,
    sheen = 0, sheenRadius = 0.6, sheenWidth = 0.12,
    rimStrength = 0.3, rimWidth = 0.06, rimColor = { 0.72, 0.85, 1.0 }, rimBreakup = 0,
    detail = "none", detailScale = 1, detailStrength = 0, bump = 0, crevice = 0, fringe = 0,
    tint = { 1, 1, 1 },
  },
}

-- What M cycles the suit through (and Shift+number a single part).
Materials.CYCLE = { "fur", "metal", "rubber", "rock", "cloth" }

----------------------------------------------------------------------
-- Defaults: what everything's made of to begin with
----------------------------------------------------------------------

-- The suit — every part, unless it's given its own below.
Materials.DEFAULT = "fur"

-- Single parts, by their label (lower case), e.g. ["right boot"] = "rubber".
Materials.PARTS = {}

-- Single shapes, by a word in their own label: anything whose label has
-- one of these in it is made of that, whatever its part is.
Materials.SHAPES = {
  { match = "visor", material = "glass" },
  { match = "eye", material = "glass" },
  { match = "iris", material = "glass" },
  { match = "glare", material = "glass" },
  { match = "blaster", material = "metal" },
}

-- The material for a shape (by its label) in a part made of partMaterial.
function Materials.forShape(label, partMaterial)
  if label then
    local l = label:lower()
    for _, rule in ipairs(Materials.SHAPES) do
      if l:find(rule.match, 1, true) then return rule.material end
    end
  end
  return partMaterial
end

----------------------------------------------------------------------
-- The shader
----------------------------------------------------------------------

local SHADER = [[
  extern vec2 lightDir;      // toward the light, in the part's own (turned) frame
  extern vec2 lightScreen;   // toward the light, on screen
  extern vec2 center;        // the part's middle, in pixels
  extern vec2 radii;         // half its width and height, in pixels
  extern float angle;        // how far it's turned
  extern vec2 canvasSize;
  extern float intensity;    // 0: flat colours .. 1: the full look

  extern float overallDarken;
  extern float wrap;
  extern float specAlpha;
  extern float specSize;
  extern float specOffset;
  extern float sheen;
  extern float sheenRadius;
  extern float sheenWidth;
  extern float rimStrength;
  extern float rimWidthPx;
  extern vec3 rimColor;
  extern float rimBreakup;
  extern int detailKind;     // 0 none, 1 strands, 2 rock, 3 weave
  extern float detailScale;
  extern float detailStrength;
  extern float bump;
  extern float crevice;
  extern float fringePx;
  extern vec3 tint;
  extern Image detailTex;
  extern float useDetailTex;

  // Value noise and a few octaves of it.
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
                   mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
                   mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float fbm(vec3 x) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * vnoise(x); x *= 2.03; a *= 0.5; }
    return s / 0.9375;
  }

  // The surface texture at s (the part's own frame, ~1 at its edge):
  // 0 low .. 1 high.
  float detail(vec2 s) {
    if (useDetailTex > 0.5) return Texel(detailTex, s * detailScale * 0.05).r;
    if (detailKind == 1) {
      // Hair: strands hanging mostly downward, fanning out toward the
      // bottom, with slow curls through them (a gentle warp) — noise
      // that's fine across the strands and long along them — gathered
      // into clumps by a coarser layer over the top.
      float curl = (fbm(vec3(s * 1.7, 5.0)) - 0.5) * 0.35;
      float across = s.x * (1.0 - 0.3 * clamp(s.y, -1.0, 1.0)) + curl;
      float along = s.y;
      float strands = fbm(vec3(across * detailScale, along * detailScale * 0.07, 0.0));
      float clumps = fbm(vec3(across * detailScale * 0.18, along * 1.2, 2.0));
      return clamp(0.5 + (strands - 0.5) * 1.3 + (clumps - 0.5) * 0.6, 0.0, 1.0);
    } else if (detailKind == 2) {
      // Rock: lumps, with sharper ridges and cracks among them.
      float n = fbm(vec3(s * detailScale, 3.7));
      float ridge = 1.0 - abs(vnoise(vec3(s * detailScale * 2.3, 9.1)) * 2.0 - 1.0);
      return clamp(n * 0.75 + ridge * 0.25, 0.0, 1.0);
    } else if (detailKind == 3) {
      // A weave: two sets of threads across each other.
      vec2 w = s * detailScale;
      return 0.5 + 0.25 * (sin(w.x * 3.0) * (0.5 + 0.5 * sin(w.y * 0.5)) + sin(w.y * 3.0) * (0.5 + 0.5 * sin(w.x * 0.5)));
    }
    return 0.5;
  }

  vec2 turn(vec2 p, float a) {
    float c = cos(a), s = sin(a);
    return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  }

  vec4 effect(vec4 color, Image tex, vec2 uv, vec2 screen) {
    vec4 texel = Texel(tex, uv) * color;
    vec2 pix = uv * canvasSize;
    vec2 p = turn(pix - center, -angle);
    vec2 q = p / radii;
    float rmin = min(radii.x, radii.y);
    vec2 s = p / rmin;

    // Hair sticking out past the outline: looking in toward the part's
    // middle from here, how near its edge is — within reach (which
    // varies round it, in tufts), this pixel's covered by hair from it,
    // thinning out toward the tips and broken into strands.
    if (fringePx > 0.0 && texel.a < 0.999) {
      vec2 inward = normalize(center - pix);
      vec2 outDir = -inward;
      float tuft = fbm(vec3(turn(outDir, -angle) * 7.0, 1.3));
      float reach = fringePx * (0.25 + 0.95 * tuft);
      float edge = -1.0;
      vec4 src = vec4(0.0);
      for (int i = 1; i <= 6; i++) {
        float d = reach * float(i) / 6.0;
        vec4 smp = Texel(tex, uv + inward * d / canvasSize);
        if (smp.a > 0.5) { edge = d; src = smp; break; }
      }
      if (edge > 0.0) {
        // (Fine hairs pointing out from the edge — their own pattern,
        // round the part rather than down it.)
        vec2 od = turn(outDir, -angle);
        float strand = fbm(vec3(od * 55.0, edge / max(reach, 1.0) * 1.5));
        float a = 1.0 - edge / reach;
        a = a * a * smoothstep(0.35, 0.65, strand) * (1.0 - texel.a);
        texel += vec4(src.rgb / max(src.a, 0.001), 1.0) * a;
      }
    }
    if (texel.a <= 0.0) return vec4(0.0);

    // The surface texture, and which way its slopes face.
    float h = detail(s);
    float e = 0.6 / max(detailScale, 1.0);
    vec2 grad = vec2(detail(s + vec2(e, 0.0)) - detail(s - vec2(e, 0.0)),
                     detail(s + vec2(0.0, e)) - detail(s - vec2(0.0, e))) / (2.0 * e);

    // The planetoids' lit-side gradient, wrapped further round by `wrap`.
    float lit = clamp(1.0 - length(q - lightDir * 0.5) / 1.6, 0.0, 1.0);
    lit = (lit + wrap) / (1.0 + wrap);
    float shade = lit * (1.0 - overallDarken);
    // Slopes facing the light catch it, those facing away don't...
    shade *= clamp(1.0 - bump * dot(grad, lightDir) * 0.15, 0.35, 1.8);
    // ...low spots are shadowed...
    shade *= 1.0 - crevice * (1.0 - h);
    // ...and the texture itself lightens and darkens it.
    shade *= mix(1.0, 0.55 + 0.9 * h, detailStrength);

    // The round highlight, and the sheen band.
    float spot = clamp(1.0 - length(q - lightDir * specOffset) / specSize, 0.0, 1.0);
    spot = spot * spot * specAlpha;
    float r = length(q);
    float bd = (r - sheenRadius) / max(sheenWidth, 0.001);
    float band = exp(-bd * bd);
    band *= clamp(dot(q / max(r, 0.001), lightDir) * 1.5, 0.0, 1.0) * sheen * (0.4 + 1.2 * h);

    vec3 base = texel.rgb * tint;
    vec3 shaded = base * shade + vec3(1.0, 0.98, 0.92) * (spot + band) * texel.a;
    vec3 rgb = mix(texel.rgb, shaded, intensity);

    // The reflected highlight along the far edge (see main.lua's notes).
    vec2 away = -lightScreen * rimWidthPx / canvasSize;
    float inside = (Texel(tex, uv + away * 0.5).a + Texel(tex, uv + away).a + Texel(tex, uv + away * 1.5).a) / 3.0;
    float rim = (1.0 - inside) * rimStrength * mix(1.0, h * 1.8, rimBreakup);
    rgb += rimColor * rim * texel.a;

    return vec4(rgb, texel.a);
  }
]]

local shader = nil
function Materials.getShader()
  if not shader then shader = love.graphics.newShader(SHADER) end
  return shader
end

-- Each material's detail image, if it has one (loaded once).
local images = {}
local blank = nil
local function detailImageFor(m)
  if not m.detailImage then return nil end
  if images[m.detailImage] == nil then
    if love.filesystem.getInfo(m.detailImage) then
      local img = love.graphics.newImage(m.detailImage)
      img:setWrap("repeat", "repeat")
      img:setFilter("linear", "linear")
      images[m.detailImage] = img
    else
      images[m.detailImage] = false
    end
  end
  return images[m.detailImage] or nil
end

-- Sends material `name` to the shader. tune: the demo's live
-- multipliers ({ intensity, rimStrength, rimWidth }). rmin: the part's
-- smaller radius on screen, in pixels.
function Materials.send(name, tune, rmin)
  local m = Materials.PRESETS[name] or Materials.PRESETS.metal
  local sh = Materials.getShader()
  local function send(k, v) if sh:hasUniform(k) then sh:send(k, v) end end
  send("intensity", tune.intensity)
  send("overallDarken", 0.08)
  for _, k in ipairs({ "wrap", "specAlpha", "specSize", "specOffset", "sheen", "sheenRadius", "sheenWidth",
      "rimColor", "rimBreakup", "detailScale", "detailStrength", "bump", "crevice", "tint" }) do
    send(k, m[k])
  end
  send("rimStrength", m.rimStrength * tune.rimStrength)
  send("rimWidthPx", m.rimWidth * tune.rimWidth * rmin)
  send("fringePx", m.fringe * rmin)
  send("detailKind", DETAIL_KINDS[m.detail] or 0)
  local img = detailImageFor(m)
  if not blank then blank = love.graphics.newImage(love.image.newImageData(1, 1)) end
  send("detailTex", img or blank)
  send("useDetailTex", img and 1 or 0)
end

return Materials
