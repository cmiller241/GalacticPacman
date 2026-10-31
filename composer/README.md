# Composer

A piano-roll music maker for AsteroidBob's hymn remixes. It runs in the browser with no install and no build step.

**Start:** double-click `composer/index.html` (Chrome or Edge works best). Press **Space** to hear the demo. The **Demo** button switches between eight remixes: *Amazing Grace* (space waltz), *Let All Exalt Jehovah's Goodness* (NAVARRE, driving hyperdrive), *A Mighty Fortress Is Our God* (boss battle), *Lead, Kindly Light* (ambient wrecked-station opening), *All Creatures of Our God and King* (pine-forest platform level), *Wake, Awake, for Night Is Flying* (frenetic drum & bass), *Wake, Awake 2* (militant battle march — the game's asteroid belt music) and *Rejoice, Ye Pure in Heart* (8-bit arcade shuffle).

## The basics

- **Rows are notes.** A higher row is a higher pitch, and a longer bar is held longer. Black-key rows are the sharps and flats (♯/♭).
- **Rows with a green tick** on the keyboard are in the song's key, so notes there sound "right". Change the key at the top.
- **Click** to place a note. **Drag** to make it longer, drag a note to move it, drag its right edge to resize it, and **right-click** to delete.
- **Each track is one instrument.** Add tracks for melody, chords, bass and drums. Notes from other tracks show faintly behind the current one.
- **Ruler (top strip):** click to set where playback starts (green marker). Drag to set the **loop region** (yellow).
- Press **?** in the app for all keyboard shortcuts.

## Turning a hymn into a space remix

1. Find a MIDI of the hymn (hymnary.org has many) and use **Import MIDI**, or drag the `.mid` onto the window.
2. Hymn MIDIs often have all four voices on one track. Click **Top line** to select the melody, then **Move → new track**. Do the same with **Bottom line** for the bass.
3. Give each track a sci-fi instrument (Theremin, Nebula Pad, Crystal Bell, Laser Bass…).
4. Add some space:
   - **Reverb** and **Echo** for depth.
   - Lower **Brightness** and add **Sweep** for a slow "wah".
   - Turn on the **Arpeggiator** on a chord track to turn held chords into runs of notes.
5. **Major → Minor** (with "Every track") makes a hymn dark and mysterious. Change the **Tempo** for energy.
6. Add a Drums track. Each row on a drum track is a different drum, and the names are on the keyboard.

## Saving

- **Save** writes a `.song.json` file. This is your editable copy, so keep these, for example in `composer/songs/`. All the demos are in `composer/songs/` as examples.
- Your work is also autosaved in the browser, and **Ctrl+Z** undoes.

## Getting music into the game

1. **Export audio** → choose **Loop region only** for background music. The reverb/echo tail is wrapped back to the start, so the file loops with no gap or click. Save the `.wav` into `composer/exports/`.
2. Convert it to game-sized files (needs ffmpeg, which is already installed):
   ```
   node composer/tools/convert-music.cjs
   ```
   That converts every WAV in `composer/exports/` into `sounds/music/<name>.ogg` and `.mp3`. You can also pass a single file path.
3. Play it in the game. The same Lua runs in LÖVE and the JS port:
   ```lua
   local music = love.audio.newSource('sounds/music/my-song-loop.ogg', 'stream')
   music:setLooping(true)
   music:play()
   ```
   For the JS port, also add the file to `js/assetList.js` so it gets preloaded.

**Use OGG, not MP3, for looping music.** MP3 adds a tiny silence at the start of the file, which makes an audible gap every time it loops.

## Good to know

- Each song has one tempo and one time signature. If a MIDI changes tempo partway through, only the first tempo is used.
- For the smoothest loops, make the loop length a whole number of bars, and use a filter **Sweep length** that divides evenly into it.
- Copyright: tunes and words published before 1931 are public domain in the US. Some English translations and some hymnal harmonizations are newer, so check before using one.
- Self-test (for development): open `index.html#selftest`.

## Files

| File | What it does |
|---|---|
| `js/music.js` | Note names, keys/scales, drum names |
| `js/song.js` | Song format, save/load, undo |
| `js/instruments.js` | The synthesized instruments |
| `js/engine.js` | Playback, effects, arpeggiator, offline render |
| `js/pianoroll.js` | The note grid editor |
| `js/midi.js` | MIDI file import |
| `js/wav.js` | WAV writer |
| `js/demo.js` | Amazing Grace demo |
| `js/app.js` | Toolbar, panels, shortcuts, files |
| `tools/convert-music.cjs` | WAV → OGG/MP3 via ffmpeg |
