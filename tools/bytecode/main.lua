-- tools/bytecode/main.lua
--
-- Build helper, not part of the game: run by tools/build-exe.sh as
--   lovec.exe tools/bytecode <srcRoot> <outRoot> <listFile>
-- Compiles every .lua path listed in <listFile> (one per line, relative
-- to <srcRoot>) to stripped LuaJIT bytecode at the same relative path
-- under <outRoot>. Running inside LÖVE itself guarantees the bytecode
-- matches the exact LuaJIT version the shipped love.exe will load.
-- Uses plain io (not love.filesystem) so it can read and write anywhere.

function love.load(args)
  local srcRoot, outRoot, listFile = args[1], args[2], args[3]
  local failed = false
  local count = 0

  for rel in io.lines(listFile) do
    if rel ~= "" then
      local fn, err = loadfile(srcRoot .. "/" .. rel)
      if not fn then
        io.stderr:write("COMPILE ERROR: " .. tostring(err) .. "\n")
        failed = true
      else
        -- strip = true drops debug info: line numbers, local names, source.
        local out = assert(io.open(outRoot .. "/" .. rel, "wb"))
        out:write(string.dump(fn, true))
        out:close()
        count = count + 1
      end
    end
  end

  print(("bytecode: compiled %d files"):format(count))
  love.event.quit(failed and 1 or 0)
end
