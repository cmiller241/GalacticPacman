# Scripting NPC events & dialogue in LÖVE

A practical guide for this project: how to make an NPC (a robot, say)
ask the player for something, react differently once they have it, and
generally support "talk to X, do a thing, talk to X again and it's
different" without the code turning into a pile of booleans and timers.

Nothing described here exists in the codebase yet — there's no
interact key, no dialogue box, no quest state. This is a proposed
design, sized for "a handful of NPCs with short quests," not a full
dialogue-tree engine.

## The core problem

Three things make this harder than it sounds in a real-time game loop:

1. **Memory** — the game needs to remember what's already happened
   ("I already asked for the widget," "player picked it up") across
   many separate frames and interactions.
2. **Branching** — what the NPC says next depends on that memory, not
   just on "which NPC is this."
3. **Sequencing without blocking** — `love.update(dt)` runs once per
   frame, forever. You can't write `say("Hello"); wait(2); say("Bye")`
   directly in it — that would freeze the whole game for 2 seconds
   (nothing else would update or draw). Anything that needs to happen
   *over time* — a line, then a pause, then another line, then the NPC
   walks somewhere — has to be spread across many frames some other
   way.

Three building blocks solve these respectively: **quest flags**,
**dialogue as data**, and **coroutines**. Combined, they cover the
"robot NPC" scenario cleanly.

## 1. Quest flags — the memory

Keep quest/world progress as plain flags in `state`, not as fields on
the NPC entity itself. Add a sub-table, same pattern as everything
else already living in `lua/state.lua`:

```lua
-- lua/state.lua
state.quests = {}
```

Then just set booleans/strings on it as things happen:

```lua
state.quests.robotAskedForWidget = true
state.quests.hasWidget = true
state.quests.robotQuestDone = true
```

**Why on `state`, not on the NPC instance:** this game already streams
and culls world content by cell (see `lua/setup/WorldGen.lua`) — an
NPC that lives in a non-permanent cell can be destroyed and later
recreated as the player wanders back. If "has the player already heard
the robot's first line" lived only on that NPC instance, it would be
forgotten the moment the cell unloads. `state` is the one thing in this
codebase guaranteed to persist for the life of the session (see
`lua/state.lua`'s own header comment about why it's a singleton), so
that's where progress belongs. The NPC instance should only ever *read*
these flags, never be the source of truth for them.

**Prefer named flags over a single numeric "stage" counter.** A stage
counter (`state.quests.robotStage = 2`) forces every quest into one
rigid line. Named flags compose — you can have `hasWidget`,
`talkedToRobotOnce`, and a completely unrelated `openedVault` all
sitting side by side, checked independently, without one quest's logic
having to know about another's. Reach for a small per-NPC state
machine (see the "heavier alternative" section below) only once a
single NPC's own back-and-forth gets complex enough that a flat list of
flags stops being readable.

## 2. Dialogue as data — the branching

Don't bury dialogue strings inside `if`/`elseif` chains mixed with game
logic. Give each NPC a small **ordered list of `{condition, lines}`
entries** — first one whose condition passes wins. This reads almost
like a spec of the NPC's behavior, and adding a new stage later is just
inserting one more table entry.

```lua
-- lua/entities/world/RobotNPC.lua (sketch)
local state = require("lua.state")

local RobotNPC = {}
RobotNPC.__index = RobotNPC

function RobotNPC.new(x, y)
  local self = setmetatable({}, RobotNPC)
  self.pos = { x = x, y = y }
  self.radius = 24
  return self
end

-- Order matters: first matching condition wins. Put more specific /
-- later-game states above earlier ones.
local DIALOGUE = {
  {
    condition = function() return state.quests.robotQuestDone end,
    lines = { "Thanks again for that widget." },
  },
  {
    condition = function() return state.quests.hasWidget end,
    lines = { "You got it! Nice work.", "Here, take this as thanks." },
    onSay = function()
      state.quests.robotQuestDone = true
      -- give the player something, play an effect, etc.
    end,
  },
  {
    condition = function() return state.quests.robotAskedForWidget end,
    lines = { "Still looking for that widget?" },
  },
  {
    -- Fallback — always matches, so it must be last.
    condition = function() return true end,
    lines = { "Hey! Could you grab me a widget?" },
    onSay = function()
      state.quests.robotAskedForWidget = true
    end,
  },
}

function RobotNPC:interact()
  for _, entry in ipairs(DIALOGUE) do
    if entry.condition() then
      if entry.onSay then entry.onSay() end
      return entry.lines
    end
  end
end

return RobotNPC
```

A dialogue UI just needs to display whatever `lines` table
`:interact()` hands back, one line at a time (see the coroutine
section for showing multiple lines with pauses/typing).

This "priority list of conditions" style is enough for a handful of
NPCs with short quests. If one NPC's dialogue starts branching a lot
(multiple parallel sub-quests, lines that depend on several flags in
combination), an explicit state machine — `self.dialogueState = "idle"`
with a table mapping state → `{lines, next = "asked"}` — keeps things
more organized than a long condition list. Both are the same idea
(pick the right line given the current state); the state machine just
makes the *transitions* explicit instead of inferring them from flag
combinations.

## 3. Coroutines — sequencing without blocking

For anything that needs to happen *over several frames* — multiple
lines with pauses between them, an NPC walking somewhere, a "quest
complete" fanfare — write it as a **coroutine** that reads top-to-bottom
like ordinary blocking code, and drive it a little bit each frame from
`love.update`. This is the standard trick for scripted sequences inside
a real-time loop; it's the reason Lua coroutines exist as a language
feature at all.

A small reusable driver:

```lua
-- lua/systems/Sequence.lua
local state = require("lua.state")

local Sequence = {}
Sequence.__index = Sequence

-- fn receives one argument: a `yield` table with helper methods that
-- internally call coroutine.yield(). Write the sequence as if it were
-- synchronous — the driver below resumes it a bit each frame.
function Sequence.new(fn)
  local self = setmetatable({}, Sequence)
  self.co = coroutine.create(fn)
  self.waitTime = 0
  self.done = false
  return self
end

local yieldApi = {
  wait = function(seconds) coroutine.yield("wait", seconds) end,
}

function Sequence:update(dt)
  if self.done then return end

  if self.waitTime > 0 then
    self.waitTime = self.waitTime - dt * (state.timeScale or 1)
    return
  end

  local ok, cmd, arg = coroutine.resume(self.co, yieldApi)
  if not ok then
    error(cmd) -- surfaces the real error instead of swallowing it
  end
  if coroutine.status(self.co) == "dead" then
    self.done = true
    return
  end
  if cmd == "wait" then
    self.waitTime = arg
  end
end

function Sequence:isDone()
  return self.done
end

return Sequence
```

Using it for the robot's "quest complete" moment:

```lua
local Sequence = require("lua.systems.Sequence")

local function robotThanksSequence(robot, dialogueBox)
  return Sequence.new(function(yield)
    dialogueBox:show("You got it! Nice work.")
    yield.wait(1.4)
    dialogueBox:show("Here, take this as thanks.")
    yield.wait(1.4)
    dialogueBox:hide()
    robot.bobbing = true -- a little idle animation flag the draw() reads
  end)
end
```

Then in `main.lua`'s `love.update(dt)`, alongside the other per-frame
updates already there (asteroids, coins, fire bars, ...):

```lua
if state.activeSequence then
  state.activeSequence:update(dt)
  if state.activeSequence:isDone() then
    state.activeSequence = nil
  end
end
```

Only one sequence needs to run at a time for a single-player game like
this (the player can only be talking to one NPC at once), so a single
`state.activeSequence` slot is enough — no need for a list/manager
unless multiple things need to animate independently at once.

**Keep this out of the DIALOGUE table's `condition`/`onSay` functions
directly returning a `Sequence`** — have `:interact()` (or the input
handler that calls it) decide whether to just show a single line
immediately, or kick off a `Sequence` for anything multi-step. Simple
one-liners don't need the coroutine machinery at all; save it for
things that genuinely span multiple frames.

## Wiring it together

1. **Interact key.** `lua/setup/InputHandlers.lua` already handles
   jump/pull-target/restart on specific keys inside
   `love.keypressed` — add an "interact" key (`e`, or reuse `Enter` if
   it's not already claimed by restart logic in that spot) the same
   way: check proximity to nearby NPCs (a simple distance check against
   `state.player.pos`, same style as the radius checks already used in
   `CollisionSystem.lua`), and if one's close enough, call
   `npc:interact()`.

2. **Dialogue box.** Doesn't need to be fancy at first — a
   `love.graphics.rectangle` + `love.graphics.printf` near the bottom
   of the screen showing the current line, dismissed on the next
   interact/key press, is enough to start. It can live as its own
   small module (`lua/ui/DialogueBox.lua`, alongside the existing
   `lua/ui/MiniMap.lua`) once it needs more than that.

3. **NPC entity.** Give it its own file under `lua/entities/world/`
   (matching where `Goomba.js`/`SpaceGhost.js` live in the JS source),
   holding its own `DIALOGUE` table, position, sprite, and an
   `:interact()` method — same shape as `RobotNPC.lua` above.

4. **Quest state.** `state.quests = {}` in `lua/state.lua`, flags set
   from `onSay` callbacks or wherever the actual trigger happens (e.g.
   a pickup's collision handler sets `state.quests.hasWidget = true`
   the same way `CollisionSystem:handleCoinCollisions` currently
   increments `state.score`).

## Gotchas specific to this codebase

- **Respect `state.timeScale`.** VATS slow-motion scales basically
  every timer in this game (`FireBar`, `Sun`, `Coin`, ...) via
  `dt * (state.timeScale or 1)`. The `Sequence` driver above already
  does this for `wait()` — keep doing it in anything else
  time-based you add, so dialogue doesn't run at the wrong speed while
  VATS is active.
- **Never block a frame.** No `while` loops waiting for something
  inside `love.update`/`love.draw`. If it takes more than one frame,
  it goes through a coroutine (or a plain per-frame counter) — not a
  blocking wait.
- **Quest state lives in `state`, not on the NPC.** Covered above, but
  worth repeating: it's the difference between a quest flag surviving
  cell streaming/regeneration and silently resetting.
- **Keep dialogue text as data.** Plain tables of strings + condition
  functions, not string literals scattered through control flow. Cheap
  now, and it's the natural seam if this ever grows into loading
  dialogue from an external file instead of hardcoding it in Lua.

## When to reach for something heavier

If this grows into many NPCs with real branching conversations
(player-facing dialogue *choices*, not just "the NPC says a different
line depending on flags"), the flag-list approach above will start to
strain. At that point it's worth looking at how dedicated dialogue
tools like **Yarn Spinner** or **ink** structure a conversation (nodes
with an id, body text, and named choices linking to other node ids) for
inspiration — not necessarily adopting either tool wholesale, but
borrowing the "dialogue as a small graph of nodes" data shape once a
flat condition list stops being enough. For the one-or-two-NPC scope
this game is at right now, that would be over-engineering — the
flags + condition-list + coroutine combination above should comfortably
cover it.
