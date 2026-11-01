// The data types of mira-stage/1 (packages/shared/src/stage.ts): what a character, an asset, a scene and a mood are.
// Plain classes with public properties; JSON names are the camelCase of the property names (see StageJson). Unknown fields
// are ignored on purpose: the contract only ever grows by adding optional fields.
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace Mira.Stage
{
    public sealed class AssetLicense
    {
        public string Id { get; set; }
        public string Source { get; set; }
        public bool PersonalUse { get; set; }
        public bool CommercialUse { get; set; }
        public bool Redistribution { get; set; }
        /// <summary>Whether the author permits sexual or violent expression with this model (VRM flags it explicitly).</summary>
        public bool? AdultExpression { get; set; }
        public string Notes { get; set; }
    }

    public sealed class MorphParam
    {
        public string Id { get; set; }
        public string Group { get; set; }
        public string Label { get; set; }
        public double Min { get; set; }
        public double Max { get; set; }
        public double Default { get; set; }
        /// <summary>"scalar" or "color".</summary>
        public string Type { get; set; } = "scalar";
    }

    public sealed class StageAsset
    {
        public string Id { get; set; }
        /// <summary>character_base, hair, outfit, accessory, prop, environment, animation, pose or material.</summary>
        public string Kind { get; set; }
        public string Name { get; set; }
        public List<string> Tags { get; set; } = new List<string>();
        public List<string> RigFamilies { get; set; } = new List<string>();
        /// <summary>
        /// What the stage resolves in its own content pack, relative to it (for example "bases/vrm1/composed.vrm",
        /// "wardrobe/crisp-shirt", "environments/cerebral-void"). Never an absolute path or a URL; see docs/UNITY.md.
        /// </summary>
        public string Locator { get; set; }
        public string Thumbnail { get; set; }
        public List<string> Slots { get; set; } = new List<string>();
        public List<string> Hides { get; set; } = new List<string>();
        public List<MorphParam> Params { get; set; } = new List<MorphParam>();
        public string VariantOf { get; set; }
        public AssetLicense License { get; set; }
    }

    public sealed class VoiceProfile
    {
        public string Provider { get; set; }
        public string VoiceId { get; set; }
        public double Speed { get; set; } = 1;
        public double PitchSemitones { get; set; }
    }

    public sealed class MoodPoint
    {
        public double Valence { get; set; }
        public double Arousal { get; set; }
        public double Dominance { get; set; }
    }

    public sealed class PresenceStyle
    {
        public double Uprightness { get; set; }
        public double GestureEconomy { get; set; }
        public double GazeHold { get; set; }
        public double Pace { get; set; }
        public double Athleticism { get; set; }
        public MoodPoint Baseline { get; set; }
    }

    public sealed class OutfitPreset
    {
        public string Id { get; set; }
        public string Name { get; set; }
        /// <summary>Slot to asset id; null means nothing in that slot. Every slot of the contract is present.</summary>
        public Dictionary<string, string> Equipped { get; set; } = new Dictionary<string, string>();
        /// <summary>Material and colour overrides: asset id, then param id, then a number or a short string.</summary>
        public Dictionary<string, Dictionary<string, JToken>> Tweaks { get; set; } = new Dictionary<string, Dictionary<string, JToken>>();
    }

    public sealed class CharacterProfile
    {
        public string Id { get; set; }
        /// <summary>"assistant" or "user".</summary>
        public string Role { get; set; } = "assistant";
        public string Name { get; set; }
        public string BaseAssetId { get; set; }
        public string RigFamily { get; set; }
        /// <summary>Slider and colour values: param id to a number or a "#rrggbb" string.</summary>
        public Dictionary<string, JToken> Params { get; set; } = new Dictionary<string, JToken>();
        public Dictionary<string, string> Equipped { get; set; } = new Dictionary<string, string>();
        public List<OutfitPreset> Presets { get; set; } = new List<OutfitPreset>();
        public VoiceProfile Voice { get; set; }
        public PresenceStyle Presence { get; set; }
        public string PersonaId { get; set; }
        public string HomeAnchor { get; set; }
        public string CreatedAt { get; set; }
        public string UpdatedAt { get; set; }
    }

    /// <summary>Position (metres), rotation (a quaternion x, y, z, w) and scale, each as plain numbers.</summary>
    public sealed class StageTransform
    {
        public double[] Position { get; set; } = { 0, 0, 0 };
        public double[] Rotation { get; set; } = { 0, 0, 0, 1 };
        public double[] Scale { get; set; } = { 1, 1, 1 };
    }

    public sealed class StageAnchor
    {
        public string Id { get; set; }
        /// <summary>sit, stand, lean, lie, hold or look.</summary>
        public string Kind { get; set; }
        public StageTransform Local { get; set; }
    }

    public sealed class SceneObject
    {
        public string Id { get; set; }
        public string AssetId { get; set; }
        public StageTransform Transform { get; set; }
        public string ParentId { get; set; }
        /// <summary>static, furniture or interactable.</summary>
        public string Role { get; set; } = "static";
        public List<StageAnchor> Anchors { get; set; } = new List<StageAnchor>();
        public bool Visible { get; set; } = true;
    }

    public sealed class CameraShot
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public StageTransform Transform { get; set; }
        public double FovDeg { get; set; }
        /// <summary>none, head, face or body: look at the character instead of a fixed rotation.</summary>
        public string Follow { get; set; } = "none";
        public double DepthOfField { get; set; }
    }

    public sealed class FloorPool
    {
        public double Radius { get; set; } = 2.2;
        public double Intensity { get; set; } = 1;
        public string Color { get; set; } = "#cfe3ff";
    }

    /// <summary>The look of the empty "cerebral space": dark void, fog, one pool of light, dust, vignette.</summary>
    public sealed class Atmosphere
    {
        public string Ground { get; set; } = "void";
        public string FogColor { get; set; } = "#0a1a3a";
        public double FogDensity { get; set; } = 0.55;
        public bool Volumetrics { get; set; } = true;
        public double DustMotes { get; set; } = 0.35;
        public FloorPool FloorPool { get; set; } = new FloorPool();
        public double Vignette { get; set; } = 0.7;
        public double Bloom { get; set; } = 0.35;
    }

    public sealed class LightingPreset
    {
        public string Id { get; set; }
        public string Name { get; set; }
        /// <summary>"clock" (sun and moon from the real time) or "fixed" (the named look).</summary>
        public string Mode { get; set; }
        public string Look { get; set; }
        public Atmosphere Atmosphere { get; set; }
    }

    public sealed class StageScene
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public string EnvironmentAssetId { get; set; }
        public List<SceneObject> Objects { get; set; } = new List<SceneObject>();
        /// <summary>Data constructs, kept as raw JSON: a stage that declares none ignores them.</summary>
        public JArray Constructs { get; set; } = new JArray();
        public List<CameraShot> Cameras { get; set; } = new List<CameraShot>();
        public string ActiveCameraId { get; set; }
        public LightingPreset Lighting { get; set; }
        public string UpdatedAt { get; set; }
    }

    public sealed class Affect
    {
        public double Valence { get; set; }
        public double Arousal { get; set; }
        public double Dominance { get; set; }
        /// <summary>The closest discrete emotion: neutral, happy, sad, angry, relaxed, surprised, shy, thinking.</summary>
        public string Label { get; set; }
    }

    public sealed class GazeTarget
    {
        /// <summary>user, camera, object, point or away.</summary>
        public string Kind { get; set; }
        public string ObjectId { get; set; }
        public double[] Position { get; set; }
        /// <summary>left, right, up or down (kind "away").</summary>
        public string Direction { get; set; }
    }

    public sealed class EmotionPoint
    {
        public double TMs { get; set; }
        public string Emotion { get; set; }
        public double Intensity { get; set; }
    }

    public sealed class AudioSpec
    {
        public string Format { get; set; }
        public double SampleRate { get; set; }
        public int Channels { get; set; }
        public double? TotalMs { get; set; }
    }

    // ---------------------------------------------------------------------------------------------------- capabilities

    public sealed class FaceCapabilities
    {
        public bool Arkit52 { get; set; }
        public bool Visemes { get; set; }
        /// <summary>The stage computes the face from the audio itself (uLipSync, an Audio2Face plugin).</summary>
        public bool AudioToFaceOnStage { get; set; }
    }

    public sealed class RenderCapabilities
    {
        public bool StrandHair { get; set; }
        public bool ClothSim { get; set; }
        public bool RuntimeAssetLoading { get; set; }
        public bool EmbeddedStream { get; set; }
    }

    public sealed class TrackingCapabilities
    {
        public bool Face { get; set; }
        public bool Body { get; set; }
    }

    /// <summary>Declared in hello, so the backend adapts instead of assuming.</summary>
    public sealed class StageCapabilities
    {
        public string Engine { get; set; } = "unity";
        public string EngineVersion { get; set; } = "";
        public List<string> RigFamilies { get; set; } = new List<string> { "vrm1" };
        public FaceCapabilities Face { get; set; } = new FaceCapabilities { Arkit52 = true };
        public RenderCapabilities Render { get; set; } = new RenderCapabilities { RuntimeAssetLoading = true };
        public TrackingCapabilities Tracking { get; set; } = new TrackingCapabilities();
        public List<string> Constructs { get; set; } = new List<string>();
        public int MaxCharacters { get; set; } = 2;
    }
}
