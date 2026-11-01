// A stage with no renderer: the C# twin of the simulator stage in packages/stage-core. It accepts what a stage must accept,
// refuses what it cannot (unsupported rig, missing asset), keeps the state a renderer would draw, and plays speech
// virtually: speak.started on the first audio frame, speak.ended when all of it has arrived (interrupted when cancelled).
// Used by the tests and by a headless smoke run in the Unity project; a real stage derives from StageHandlerBase instead.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Mira.Stage
{
    public sealed class HeadlessUtterance
    {
        public string Id { get; set; }
        public uint Hash { get; set; }
        public string Text { get; set; }
        public string Emotion { get; set; }
        public string FaceSource { get; set; }
        public double? TotalMs { get; set; }
        public double ReceivedMs { get; set; }
        public int AudioFrames { get; set; }
        public int FaceFrames { get; set; }
        public bool Started { get; set; }
        public bool Ended { get; set; }
        public bool Interrupted { get; set; }
    }

    public sealed class HeadlessStageHandler : StageHandlerBase
    {
        private readonly object _gate = new object();
        private readonly List<string> _commandTypes = new List<string>();
        private readonly Dictionary<string, CharacterProfile> _characters = new Dictionary<string, CharacterProfile>();
        private readonly Dictionary<string, StageAsset> _loaded = new Dictionary<string, StageAsset>();
        private readonly Dictionary<string, HeadlessUtterance> _utterances = new Dictionary<string, HeadlessUtterance>();
        private readonly HashSet<string> _supportedRigs;
        private int _connects;
        private int _disconnects;

        public HeadlessStageHandler(params string[] supportedRigFamilies)
        {
            _supportedRigs = new HashSet<string>(supportedRigFamilies.Length > 0 ? supportedRigFamilies : new[] { "vrm1" });
        }

        public string AssistantId { get; private set; }
        public StageScene Scene { get; private set; }
        public string ActiveCameraId { get; private set; }
        public LightingPreset Lighting { get; private set; }
        public Affect Affect { get; private set; }
        public string Posture { get; private set; }
        public string IdleProfile { get; private set; }
        public string LastGesture { get; private set; }
        public GazeTarget Gaze { get; private set; }
        public int Connects { get { lock (_gate) return _connects; } }
        public int Disconnects { get { lock (_gate) return _disconnects; } }

        public IReadOnlyList<string> CommandTypes { get { lock (_gate) return _commandTypes.ToList(); } }
        public IReadOnlyDictionary<string, CharacterProfile> Characters { get { lock (_gate) return new Dictionary<string, CharacterProfile>(_characters); } }
        public IReadOnlyList<HeadlessUtterance> Utterances { get { lock (_gate) return _utterances.Values.ToList(); } }
        public bool IsLoaded(string assetId) { lock (_gate) return _loaded.ContainsKey(assetId); }

        public override void OnConnected(IStageSink sink)
        {
            base.OnConnected(sink);
            lock (_gate) _connects++;
        }

        public override void OnDisconnected(string reason)
        {
            base.OnDisconnected(reason);
            lock (_gate) _disconnects++;
        }

        private Task<CommandResult> Ok(StageCommand c)
        {
            lock (_gate) _commandTypes.Add(c.Type);
            return Task.FromResult(CommandResult.Done);
        }

        private Task<CommandResult> No(StageCommand c, string reason)
        {
            lock (_gate) _commandTypes.Add(c.Type);
            return Task.FromResult(CommandResult.Fail(reason));
        }

        /// <summary>Make assets available (provided in the command or already loaded), telling the backend about each one.</summary>
        private string Load(IEnumerable<StageAsset> provided, IEnumerable<string> needed)
        {
            var byId = (provided ?? Enumerable.Empty<StageAsset>()).GroupBy(a => a.Id).ToDictionary(g => g.Key, g => g.First());
            var toLoad = new List<StageAsset>();
            lock (_gate)
            {
                foreach (var id in needed.Where(n => !string.IsNullOrEmpty(n)).Distinct())
                {
                    if (_loaded.ContainsKey(id)) continue;
                    if (!byId.TryGetValue(id, out var asset)) return "asset \"" + id + "\" was not provided and is not loaded";
                    toLoad.Add(asset);
                }
                foreach (var a in toLoad) _loaded[a.Id] = a;
            }
            foreach (var a in toLoad) Sink?.AssetLoaded(a.Id, 0);
            return null;
        }

        protected override Task<CommandResult> OnCharacterLoad(CharacterLoad c, CancellationToken ct)
        {
            var ch = c.Character;
            if (!_supportedRigs.Contains(ch.RigFamily ?? string.Empty)) return No(c, "rig family " + ch.RigFamily + " is not supported");
            var needed = new List<string> { ch.BaseAssetId };
            needed.AddRange(ch.Equipped.Values);
            var problem = Load(c.Assets, needed);
            if (problem != null) return No(c, problem);
            lock (_gate)
            {
                _characters[ch.Id] = ch;
                if (ch.Role == "assistant" || AssistantId == null) AssistantId = ch.Id;
            }
            return Ok(c);
        }

        protected override Task<CommandResult> OnCharacterParams(CharacterParams c, CancellationToken ct)
        {
            lock (_gate)
            {
                if (!_characters.TryGetValue(c.CharacterId, out var ch)) return No(c, "unknown character \"" + c.CharacterId + "\"");
                foreach (var kv in c.Params) ch.Params[kv.Key] = kv.Value;
            }
            return Ok(c);
        }

        protected override Task<CommandResult> OnCharacterEquip(CharacterEquip c, CancellationToken ct)
        {
            lock (_gate)
            {
                if (!_characters.ContainsKey(c.CharacterId)) return No(c, "unknown character \"" + c.CharacterId + "\"");
            }
            if (!string.IsNullOrEmpty(c.AssetId))
            {
                var problem = Load(c.Asset != null ? new[] { c.Asset } : null, new[] { c.AssetId });
                if (problem != null) return No(c, problem);
            }
            lock (_gate) _characters[c.CharacterId].Equipped[c.Slot] = c.AssetId;
            return Ok(c);
        }

        protected override Task<CommandResult> OnCharacterOutfit(CharacterOutfit c, CancellationToken ct)
        {
            lock (_gate)
            {
                if (!_characters.ContainsKey(c.CharacterId ?? AssistantId ?? string.Empty)) return No(c, "unknown character");
            }
            var problem = Load(c.Assets, c.Preset.Equipped.Values);
            if (problem != null) return No(c, problem);
            lock (_gate)
            {
                var ch = _characters[c.CharacterId ?? AssistantId];
                foreach (var kv in c.Preset.Equipped) ch.Equipped[kv.Key] = kv.Value;
            }
            return Ok(c);
        }

        protected override Task<CommandResult> OnSceneLoad(SceneLoad c, CancellationToken ct)
        {
            var problem = Load(c.Assets, new[] { c.Scene.EnvironmentAssetId });
            if (problem != null) return No(c, problem);
            lock (_gate)
            {
                Scene = c.Scene;
                ActiveCameraId = c.Scene.ActiveCameraId;
                Lighting = c.Scene.Lighting;
            }
            return Ok(c);
        }

        protected override Task<CommandResult> OnSceneCamera(SceneCamera c, CancellationToken ct)
        {
            lock (_gate)
            {
                if (Scene == null) return No(c, "no scene is loaded");
                if (!Scene.Cameras.Any(cam => cam.Id == c.CameraId)) return No(c, "unknown camera \"" + c.CameraId + "\"");
                ActiveCameraId = c.CameraId;
            }
            return Ok(c);
        }

        protected override Task<CommandResult> OnSceneLighting(SceneLighting c, CancellationToken ct)
        {
            lock (_gate)
            {
                if (Scene == null) return No(c, "no scene is loaded");
                Lighting = c.Lighting;
            }
            return Ok(c);
        }

        protected override Task<CommandResult> OnSpeak(PerformSpeak c, CancellationToken ct)
        {
            lock (_gate)
            {
                if (_utterances.TryGetValue(c.UtteranceId, out var existing) && !existing.Ended) return No(c, "utterance \"" + c.UtteranceId + "\" is already active");
                _utterances[c.UtteranceId] = new HeadlessUtterance
                {
                    Id = c.UtteranceId,
                    Hash = StageFrames.Fnv1a32(c.UtteranceId),
                    Text = c.Text,
                    Emotion = c.Emotion,
                    FaceSource = c.FaceSource,
                    TotalMs = c.Audio?.TotalMs,
                };
            }
            return Ok(c);
        }

        protected override Task<CommandResult> OnCancel(PerformCancel c, CancellationToken ct)
        {
            var ended = false;
            lock (_gate)
            {
                if (_utterances.TryGetValue(c.UtteranceId, out var u) && !u.Ended)
                {
                    u.Ended = true;
                    u.Interrupted = true;
                    ended = true;
                }
            }
            if (ended) Sink?.SpeakEnded(c.UtteranceId, true);
            return Ok(c);
        }

        protected override Task<CommandResult> OnAffect(PerformAffect c, CancellationToken ct)
        {
            lock (_gate) Affect = c.Affect;
            return Ok(c);
        }

        protected override Task<CommandResult> OnGesture(PerformGesture c, CancellationToken ct)
        {
            lock (_gate) LastGesture = c.Clip;
            return Ok(c);
        }

        protected override Task<CommandResult> OnGaze(PerformGaze c, CancellationToken ct)
        {
            lock (_gate) Gaze = c.Target;
            return Ok(c);
        }

        protected override Task<CommandResult> OnPosture(PerformPosture c, CancellationToken ct)
        {
            lock (_gate) Posture = c.Posture;
            return Ok(c);
        }

        protected override Task<CommandResult> OnIdle(PerformIdle c, CancellationToken ct)
        {
            lock (_gate) IdleProfile = c.Profile;
            return Ok(c);
        }

        public override void OnAudioFrame(AudioFrame frame)
        {
            string startedId = null, endedId = null;
            lock (_gate)
            {
                var u = _utterances.Values.FirstOrDefault(x => x.Hash == frame.UtteranceIdHash && !x.Ended);
                if (u == null) return;
                u.AudioFrames++;
                u.ReceivedMs += frame.DurationMs;
                if (!u.Started)
                {
                    u.Started = true;
                    startedId = u.Id;
                }
                if (u.TotalMs.HasValue && u.ReceivedMs + 1 >= u.TotalMs.Value)
                {
                    u.Ended = true;
                    endedId = u.Id;
                }
            }
            if (startedId != null) Sink?.SpeakStarted(startedId);
            if (endedId != null) Sink?.SpeakEnded(endedId, false);
        }

        public override void OnFaceFrames(FaceFrames frames)
        {
            lock (_gate)
            {
                var u = _utterances.Values.FirstOrDefault(x => x.Hash == frames.UtteranceIdHash && !x.Ended);
                if (u != null) u.FaceFrames += frames.Weights.Length;
            }
        }
    }
}
