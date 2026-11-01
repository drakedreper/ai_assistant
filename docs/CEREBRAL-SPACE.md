# The cerebral space

Status: draft concept, 2026-10-31. Written from the user's brief and six reference screenshots. Nothing here is built in an engine yet. As of 2026-11-01 the backend half exists: the void preset, the six camera shots, the data constructs and the presence style are implemented in `packages/stage-core` and exercised by a headless simulator stage and the three.js draft room, not by a renderer that draws this look.

## The vision, in the user's words

"An empty cerebral space with a representation of myself and my second brain living in it. This space is then connected to the terminal and everything." The assistant should look "as real as" the AION 2 character creator, and carry "athletic and intelligence meeting in authority". The dashboards built so far are a draft; the long-term interface is this space.

## What the references show (observed)

- **The space:** an empty, dark navy void. Soft volumetric fog banks at knee height, one pool of cool white light on the floor under the character, sparse drifting dust motes, a heavy vignette. No furniture, no horizon. The character is lit as if on a stage, with a gentle rim light.
- **Camera:** four framings of the same character: wide full-body (small in the void), waist-up, face-and-shoulders close-up, and turntable views (front, three-quarter, profile, back). The environment stays the same and the camera does the work.
- **Render quality:** strand-level braided hair with highlights, detailed irises and eyelashes, skin with subsurface softness, dark lip colour, black leather outfit with metallic gold-trimmed gauntlets and high heels. It reads as an Unreal-class pipeline with DLSS (a DLSS counter is visible in the corner). The creator frames it with a placeholder "UI" glyph at the bottom.
- **Not a design target:** the reference face is very youthful and soft, and the figure is slight. The brief asks for athletic, intelligent and authoritative. So the references set the **rendering, lighting and framing benchmark**, not the character's proportions. The target character is a clearly adult, composed woman with an athletic frame.

## What the space contains

The space is the mind. Everything the app knows becomes a place or an object in it. The backend decides what appears; the stage draws it (`DataConstruct` in `packages/shared/src/stage.ts`).

| In the app today | In the cerebral space | Construct | Interaction |
|---|---|---|---|
| The user | A representation of the user: a second character (`role: "user"`), mirrored from the webcam or idle | character | Gaze contact with the assistant; stands or sits in the same space |
| The second brain | The assistant is its embodiment. Around her, notes hang as a 3D constellation: depth is the layer (core nearest, inbox far), brightness is importance, links are filaments | `knowledge_graph` | She reaches toward a note when she cites it; the user clicks one to open it |
| Strategies and decisions | Larger, steadier bodies in the constellation, visibly protected. Proposals pulse until reviewed | `knowledge_graph` | Approve or reject in place |
| Claude sessions and subagents | Small bodies orbiting their project; a blocked one flares | `session_orbit` | Click to open a session; she narrates "two are waiting" |
| Projects and tasks | Structures with their cards attached | `project_cluster` | Drag cards between states |
| Calendar and journal | A ribbon through time with today lit | `timeline_ribbon` | She walks the ribbon to prepare you for the next event |
| Terminal and Claude Code | An interactive terminal pane in the space, running the user's own `claude` | `terminal_pane` | Focus it and type; output streams from the daemon's PTY |
| Mail, money, world | Quiet streams and pulses at the edge, aggregates only | `mail_stream`, `finance_pulse` | Pull one closer to expand |

The void stays mostly empty on purpose. Things appear when they matter and recede when they do not.

## The character: athletic, intelligent, authoritative

This is expressed as parameters the backend uses every second (`PresenceStyle`, default `AUTHORITY_PRESENCE`):

- Upright, balanced stance with weight under her; controlled, athletic movement.
- **Economy of gesture:** few, deliberate gestures. Authority reads as stillness with purpose, not constant motion.
- Long, steady gaze with natural breaks; a measured pace of speech and movement.
- Baseline mood: slightly positive, low arousal, high dominance. The MoodEngine pulls toward it, so she stays composed under pressure and warms up in good moments.
- Wardrobe direction (the user chooses): tailored dark pieces with an athletic cut, structured outerwear, understated metal accents like the gauntlets in the reference. Wardrobe presets are context-aware (work, meeting, relax, night). Nothing revealing is a default.
- **Adult characters only.** The creator's parameter ranges are bounded to adult proportions and the catalog refuses assets that are not. The persona spec (docs/PERSONA.md) already requires honesty, no guilt-tripping and that affection never authorises an action.

## How the camera works

A "director" in the backend picks the shot from context, with slow blends: wide when idle or when data is the subject, medium while talking, close-up for emotional or important beats, profile when she is reviewing something with you, over-the-shoulder when she works in a construct. Shots are `CameraShot`s in the scene; the stage only blends between them.

## What the backend builds (Phase 2)

1. **Character service:** profiles (assistant and user), morph parameters, equipped slots, outfit presets, voice, presence style; SQLite-backed, restored on every start.
2. **Asset catalog:** manifests scanned from a folder, with licences, rig compatibility, slots and hidden body regions; refuses assets whose licence forbids the use.
3. **Wardrobe and outfit director:** the user picks; she may also suggest by context (time, weather, calendar, activity). Cosmetic changes are low-risk actions on the trust ladder.
4. **Scene service:** the cerebral void as a preset, user-placed objects, saved scene presets, camera shots, lighting and atmosphere.
5. **Construct feeds:** turn brain notes, sessions, tasks, calendar and the terminal into `scene.data` and `construct.terminal.write`; compute the 3D constellation layout on the backend.
6. **Mood engine and behaviour director:** affect that evolves with events and time; idle behaviour that never repeats mechanically (cooldowns, variation), attention to the user, gestures chosen to fit her presence style and the emotion; interruption budget for unprompted speech.
7. **Speech pipeline:** LLM text, sentence chunks, TTS, audio frames plus face frames (backend Audio2Face or engine-side lip sync), emotion timeline, barge-in.
8. **Persistent character memory:** relationship and episodic memory stored in the second brain's layers, so continuity (what happened, what she knows about you, how she felt) survives restarts. This is the same vault as Phase 2's brain work.
9. **Headless simulator stage + conformance tests:** a fake renderer that validates every command, checks clock sync and reports capabilities, so engine stages can be developed against a contract.
10. **The web room as the first (draft) stage**, so the backend can be exercised end to end before an engine stage exists.

## Engine stage (Phase 3, on the RTX 5070 Ti)

The first engine scene is the void: fog, floor pool, dust, vignette, one character, one knowledge-graph construct, one terminal pane. Measure frame time, VRAM, outfit swap time and lip-sync latency before building more. See ADR 0008 for the engine comparison; the references and the AION 2 bar point toward Unreal, to be confirmed after the spike.

## Open questions for the user

1. **The user's representation:** a stylised avatar that mirrors the webcam, an abstract presence (a silhouette or light form), or a full character you design? The contract supports all three.
2. **The second brain's body:** is the assistant herself the embodiment of the brain, or should the constellation also be a separate presence with its own character?
3. **Real face or designed face:** should the user's representation resemble the user? (Face capture of a real person raises its own privacy rules.)
4. **Engine installed on the PC:** is Unreal or Unity already installed, and which version?
