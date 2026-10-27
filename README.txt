REEL EDIT — video editor (desktop app or browser)
=================================================

Two ways to run it, same editor:
  * ReelEdit.exe (Windows 10/11): double-click it. No install. See "Desktop app" below.
  * ReelEdit.html: open it in Chrome or Edge (double-click it). No server needed.
Both work offline. Your media never leaves your machine.

Desktop app (ReelEdit.exe)
  A single 63 MB exe with nothing to install. It uses the Microsoft Edge WebView2 runtime,
  which Windows 10 and 11 already have. If it's missing, the app offers the download link.
  * Open files: drag them onto the window, onto ReelEdit.exe itself, or use "Open with".
    A .reel.json project opens the project, and media files are imported.
  * Exports and project saves open a normal Windows Save dialog.
  * It runs at full speed when minimised or in the background. There's no tab throttling, and
    the GPU is used for decoding, scaling and encoding.
  * Settings and autosave live in %LOCALAPPDATA%\ReelEdit, and log.txt there records start-up and errors.
  * ReelEdit.exe --devtools turns on the right-click Inspect menu for debugging.

Getting started
  1. Drop video, audio and image files anywhere on the window (or click + Import).
  2. Drag them from the Media bin onto the timeline, or select one and press E to append.
  3. Press Space to play. Press Ctrl+E to export an MP4.

Cutting and blending
  * Auto cross-fade (X, on by default): drag a clip so it overlaps its neighbour on the
    same track and the overlap becomes a transition, for both video and audio.
    Drop a clip inside a longer one and it is spliced in, with fades on both sides.
    Turn it off and drops overwrite instead (the parts that will be replaced show in red).
  * Hold Ctrl when you drop to insert. Later clips get pushed right.
  * Alt+drag duplicates a clip. Shift while dragging turns snapping off.
  * Drag a clip edge to trim it. Drag the edge into the neighbouring clip to cross-fade.
    Alt+drag a cut between two clips to roll it.
  * The dots on a clip's top corners are fade handles.
  * Q / W ripple-trim the clip under the playhead to the playhead.
  * Ctrl+T adds a transition at the nearest cut. It uses spare footage beyond the clip
    edges where there is some, and slides later clips left where there isn't.
  * 12 transition types: dissolve, dip to black or white, blur, zoom, whip pan, push,
    wipes and iris. Right-click a transition, or use the inspector.
  * Ripple mode (R): deletes and trims pull everything after them along.
  * Blade tool (B) cuts where you click. Shift+click cuts every track.
    Slip tool (Y) changes which part of the source a clip shows without moving it.

Beat editing
  * Select your music clip and click "♪ Beats". The app detects the tempo and drops
    markers on the beat, and edits snap to them.
  * Select some clips and choose "Cut to beat" (1/2/4/8 beats) in the inspector.
    The clips are laid out back to back on the beat grid.
  * You can also press M while the timeline plays to tap markers by hand.

Source viewer
  Double-click a bin item to open it in the Source viewer. Mark In and Out with I and O,
  then press , to insert, . to overwrite or E to append. You can also drag the picture
  straight onto the timeline.

Projects
  Ctrl+S saves a small .reel.json project file. Your media files stay where they are.
  When you reopen a project, drop the same files back in and they relink automatically
  by file name. The app also autosaves the timeline in the browser, and on the next
  launch it offers to restore your last session.

Proxies (heavy footage)
  Some clips are heavy to preview: 4K, 50/60 fps, or game/screen captures with a keyframe only every
  few seconds. When you import one, the app builds a light proxy in the background: 960 px, 30 fps,
  with a keyframe every half second. It also keeps the clip's sound as a WAV, and both live in RAM.
  The bin card shows "making proxy NN%", then a PROXY badge. A 2-minute 4K60 clip takes about 40–60 s.
  * While you play or scrub, the preview uses the proxy, so seeks take milliseconds instead of a second or more.
  * Scrub strip: every MP4/MOV video (proxied or not) also keeps small 224 px frames in RAM, up to
    every 0.1 s and at most about 135 MB per clip. While you drag the playhead, the preview shows the
    nearest strip frame at once, so the picture follows the mouse. The sharp frame replaces it as soon
    as the real seek lands.
  * When you stop, the full-quality original frame swaps in about a second later.
    The badge on the viewer shows PROXY or FULL QUALITY.
  * Export always renders from the original files at full quality (see Export below).
  * The Proxy button under the viewer (or P) turns proxies on and off. Right-click a bin item to make,
    cancel or discard a proxy by hand.
  * Proxies need MP4/MOV H.264 files and Chrome or Edge. They're rebuilt each session, because nothing
    is written to disk.

Export
  The default "Frame-accurate" engine decodes every source frame exactly and encodes an MP4
  (H.264 video, AAC audio). It runs faster than real time. On an RTX 3070 Ti, 20 s of 4K60 footage
  exports to 1080p30 in about 8 s (2.4× real time). It never drops a frame, the sound stays locked
  to the picture, and you can switch to another tab while it works.
  * Plain stretches of a single full-frame clip (no effects, fades or titles) go straight from the
    GPU decoder to the encoder at about 75–85 fps. Transitions, titles and effects are composited at
    about 25–30 fps. The colours match the source exactly in both cases.
  * MP4/MOV (H.264) sources are decoded with the browser's hardware decoder. Other formats
    (WebM, rotated phone clips) fall back to a slower exact-seek path.
  * Clip speed changes are rendered with the pitch shifted. The live preview keeps the pitch.
  * "Real-time capture (legacy)" is still in the dialog. It records the preview as it plays, so the tab
    must stay visible. It can render from proxies for heavy clips.

Notes
  * Long, high-resolution footage plays best with the preview set to ½ (bottom-right of the viewer).
    The preview setting doesn't affect export.
  * The waveforms and beat detection decode audio in the browser. Files over 600 MB skip that step.
  * If the picture lags or stutters, press Shift+D (or the ≋ button under the viewer) to show the
    playback sync readout: render times, drift and dropped frames per clip. The preview drops to ½
    size automatically when your machine can't keep up at full size.
  * Press ? in the app for the full list of shortcuts.

Separating sound from video
  Right-click a video in the bin:
  * Separate audio → new audio file: saves the sound as "<name> (audio).wav", adds it to the bin, and
    from then on the video comes into the timeline muted (any of its clips already there are muted too).
  * Use picture only / Use with its sound again: the same muting without making a file.
  * Save audio as WAV…: just saves the sound.
  Right-click an audio or video clip → Normalise (or the Normalise button in the inspector) sets its
  volume so its loudest moment peaks at −1 dB.

Version and updates
  The version shows next to the logo (hover it for the build number and date), in the ? panel and in the
  exe's window title. A few seconds after start-up, and every 6 hours after that, the app reads a small
  update feed. If a newer build exists, a green "Update available" badge appears in the top bar, and
  clicking it shows the release notes. "Check for updates" in the ? panel checks on demand. Offline, the
  check fails silently.
  * ReelEdit.exe updates itself: click Update and it downloads in the background while you work, checks
    the download's checksum and swaps in the new exe. Then "Restart now" (or just open it next time).
    Keep the exe in a folder you can write to (Desktop, Documents, Downloads). If the update can't be
    installed, it opens the download page instead.
  * ReelEdit.html shows a Download link: get the new zip and open the new ReelEdit.html.
  * version.json holds the version, the build number (a whole number that goes up by 1 every release,
    which is what the update check compares), the date and the release notes.
  * To release: bump version, build and date in version.json and write the notes, commit, then run
    node release.js
    It builds the exe and zip, tags and pushes, creates the GitHub release with the zip attached, and
    updates the feed (with the zip's address and checksum, for the exe's self-update). The zip goes on
    the "releases" repo in version.json (default "repo"), which must be public for the exe to download
    it. Use node release.js --dry to only build and zip.

Source code: src/ (core.js, proxy.js, export.js, timeline.js, ui.js, shell.html). To rebuild ReelEdit.html, run: node src/build.js
Desktop shell: desktop/ (.NET 8 WinForms + WebView2, with the web app embedded). To rebuild the exe, run:
  dotnet publish desktop -c Release -o dist
