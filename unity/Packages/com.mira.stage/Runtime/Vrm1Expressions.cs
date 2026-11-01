// Face frames and moods to VRM 1.0 expressions. The daemon sends 52 ARKit blendshape weights per 30 fps frame (and a mood
// as an Affect with a discrete label); a VRM 1.0 model exposes expression PRESETS (happy, angry, sad, relaxed, surprised,
// aa, ih, ou, ee, oh, blink, blinkLeft, blinkRight, lookUp, lookDown, lookLeft, lookRight, neutral) and, when it was
// exported with "Perfect Sync", 52 custom expressions named after the ARKit shapes. This file is only the arithmetic: weights
// in, weights out, no engine type, so it is tested outside Unity. The Unity layer feeds the result to
// Vrm10Instance.Runtime.Expression (SetWeight) and lets the runtime apply the models own override rules (overrideMouth etc.).
//
// THE RULES BELOW ARE A STARTING POINT, NOT A TUNED RESULT: they are plain, symmetric and bounded, and they have never been
// looked at on a rendered face. Tune the factors against a real model in Unity. In particular the direction of
// lookLeft/lookRight is a convention to confirm on screen (swap the two channels in Compute if the eyes go the wrong way).
using System;
using System.Collections.Generic;

namespace Mira.Stage
{
    /// <summary>One model's mapping from a 52-weight ARKit face frame to the expressions that model actually has.</summary>
    public sealed class ExpressionMap
    {
        // The channels computed from a frame in preset mode, in this order; a model gets only the ones it has.
        internal const int Happy = 0, Angry = 1, Sad = 2, Surprised = 3, Aa = 4, Ih = 5, Ou = 6, Ee = 7, Oh = 8;
        internal const int Blink = 9, BlinkLeft = 10, BlinkRight = 11, LookUp = 12, LookDown = 13, LookLeft = 14, LookRight = 15;
        internal const int ChannelCount = 16;
        internal static readonly string[] ChannelNames =
        {
            "happy", "angry", "sad", "surprised", "aa", "ih", "ou", "ee", "oh", "blink", "blinkLeft", "blinkRight", "lookUp", "lookDown", "lookLeft", "lookRight",
        };

        private readonly string[] _driven;
        /// <summary>Per driven expression: its channel (preset mode) or its ARKit index (Perfect Sync).</summary>
        private readonly int[] _source;
        private readonly float[] _channels = new float[ChannelCount];

        internal ExpressionMap(string[] driven, int[] source, bool perfectSync)
        {
            _driven = driven;
            _source = source;
            PerfectSync = perfectSync;
        }

        /// <summary>The model's own names of the expressions this map writes, in the order of the output array of Apply.</summary>
        public IReadOnlyList<string> Driven => _driven;

        /// <summary>True when the model has (nearly) all 52 ARKit shapes as expressions and they are driven one to one.</summary>
        public bool PerfectSync { get; }

        /// <summary>
        /// Fill output (at least Driven.Count long) with the weight of each driven expression for one ARKit frame (52 floats).
        /// Every weight is finite and in 0..1 whatever the input holds (a NaN or an infinite input counts as 0). Not
        /// thread-safe (it reuses one scratch array, so that a 30 fps caller allocates nothing); call it from one thread.
        /// </summary>
        public void Apply(float[] arkit52, float[] output)
        {
            if (arkit52 == null || arkit52.Length != StageProtocol.ArkitCount) throw new ArgumentException("a face frame holds exactly " + StageProtocol.ArkitCount + " weights", nameof(arkit52));
            if (output == null || output.Length < _driven.Length) throw new ArgumentException("output must hold at least " + _driven.Length + " weights", nameof(output));
            if (PerfectSync)
            {
                for (var i = 0; i < _source.Length; i++) output[i] = Clamp01(arkit52[_source[i]]);
                return;
            }
            Compute(arkit52, _channels);
            for (var i = 0; i < _source.Length; i++) output[i] = _channels[_source[i]];
        }

        internal static float Clamp01(float x) => float.IsNaN(x) || float.IsInfinity(x) ? 0f : x < 0f ? 0f : x > 1f ? 1f : x;

        private static class Ix
        {
            public static readonly int BrowDownLeft = Index("browDownLeft"), BrowDownRight = Index("browDownRight"), BrowInnerUp = Index("browInnerUp");
            public static readonly int BrowOuterUpLeft = Index("browOuterUpLeft"), BrowOuterUpRight = Index("browOuterUpRight");
            public static readonly int CheekSquintLeft = Index("cheekSquintLeft"), CheekSquintRight = Index("cheekSquintRight");
            public static readonly int EyeBlinkLeft = Index("eyeBlinkLeft"), EyeBlinkRight = Index("eyeBlinkRight");
            public static readonly int EyeWideLeft = Index("eyeWideLeft"), EyeWideRight = Index("eyeWideRight");
            public static readonly int EyeLookUpLeft = Index("eyeLookUpLeft"), EyeLookUpRight = Index("eyeLookUpRight");
            public static readonly int EyeLookDownLeft = Index("eyeLookDownLeft"), EyeLookDownRight = Index("eyeLookDownRight");
            public static readonly int EyeLookInLeft = Index("eyeLookInLeft"), EyeLookInRight = Index("eyeLookInRight");
            public static readonly int EyeLookOutLeft = Index("eyeLookOutLeft"), EyeLookOutRight = Index("eyeLookOutRight");
            public static readonly int JawOpen = Index("jawOpen");
            public static readonly int MouthFunnel = Index("mouthFunnel"), MouthPucker = Index("mouthPucker");
            public static readonly int MouthSmileLeft = Index("mouthSmileLeft"), MouthSmileRight = Index("mouthSmileRight");
            public static readonly int MouthFrownLeft = Index("mouthFrownLeft"), MouthFrownRight = Index("mouthFrownRight");
            public static readonly int MouthStretchLeft = Index("mouthStretchLeft"), MouthStretchRight = Index("mouthStretchRight");
            public static readonly int NoseSneerLeft = Index("noseSneerLeft"), NoseSneerRight = Index("noseSneerRight");

            private static int Index(string name)
            {
                var i = Array.IndexOf(StageProtocol.Arkit52, name);
                if (i < 0) throw new InvalidOperationException("ARKit blendshape \"" + name + "\" is not in StageProtocol.Arkit52");
                return i;
            }
        }

        private static float Avg(float[] a, int left, int right) => (Clamp01(a[left]) + Clamp01(a[right])) * 0.5f;

        /// <summary>All the preset channels from one frame (the model keeps only the ones it has).</summary>
        private static void Compute(float[] a, float[] c)
        {
            var jaw = Clamp01(a[Ix.JawOpen]);
            var funnel = Clamp01(a[Ix.MouthFunnel]);
            var pucker = Clamp01(a[Ix.MouthPucker]);
            var stretch = Avg(a, Ix.MouthStretchLeft, Ix.MouthStretchRight);
            var smile = Avg(a, Ix.MouthSmileLeft, Ix.MouthSmileRight);
            var frown = Avg(a, Ix.MouthFrownLeft, Ix.MouthFrownRight);
            var browDown = Avg(a, Ix.BrowDownLeft, Ix.BrowDownRight);
            var browUp = Math.Max(Clamp01(a[Ix.BrowInnerUp]), Avg(a, Ix.BrowOuterUpLeft, Ix.BrowOuterUpRight));
            var sneer = Avg(a, Ix.NoseSneerLeft, Ix.NoseSneerRight);
            var cheek = Avg(a, Ix.CheekSquintLeft, Ix.CheekSquintRight);
            var wide = Avg(a, Ix.EyeWideLeft, Ix.EyeWideRight);

            // the face expressions, from the shapes that carry them
            c[Happy] = Clamp01(smile * 1.5f + cheek * 0.3f);
            c[Sad] = Clamp01(frown * 1.4f + Clamp01(a[Ix.BrowInnerUp]) * 0.5f);
            c[Angry] = Clamp01(browDown * 0.9f + sneer * 0.5f);
            c[Surprised] = Clamp01(wide * 0.8f + browUp * 0.4f);

            // the five vowels. ARKit has no vowels: the jaw is "aa", rounded lips are "ou" (closed) and "oh" (open), spread
            // lips are "ee", and a little of both is "ih". They are normalised so that together they never exceed 1: a model
            // that overrides the mouth would otherwise get five full mouths at once.
            float aa = jaw, ou = pucker, oh = funnel, ee = stretch, ih = 0.6f * Math.Min(stretch, jaw);
            var sum = aa + ih + ou + ee + oh;
            if (sum > 1f)
            {
                var k = 1f / sum;
                aa *= k;
                ih *= k;
                ou *= k;
                ee *= k;
                oh *= k;
            }
            c[Aa] = aa;
            c[Ih] = ih;
            c[Ou] = ou;
            c[Ee] = ee;
            c[Oh] = oh;

            var left = Clamp01(a[Ix.EyeBlinkLeft]);
            var right = Clamp01(a[Ix.EyeBlinkRight]);
            c[BlinkLeft] = left;
            c[BlinkRight] = right;
            c[Blink] = (left + right) * 0.5f;

            // gaze as expressions (only for models whose lookAt is expression based; bone based gaze is the Unity layer's job).
            // "Left" is the avatar's left eye looking outward and its right eye looking inward. UNVERIFIED on screen.
            c[LookUp] = Avg(a, Ix.EyeLookUpLeft, Ix.EyeLookUpRight);
            c[LookDown] = Avg(a, Ix.EyeLookDownLeft, Ix.EyeLookDownRight);
            c[LookLeft] = (Clamp01(a[Ix.EyeLookOutLeft]) + Clamp01(a[Ix.EyeLookInRight])) * 0.5f;
            c[LookRight] = (Clamp01(a[Ix.EyeLookOutRight]) + Clamp01(a[Ix.EyeLookInLeft])) * 0.5f;
        }
    }

    public static class Vrm1Expressions
    {
        /// <summary>The expression presets of VRM 1.0 (VRMC_vrm: expressions.preset).</summary>
        public static readonly string[] Presets =
        {
            "happy", "angry", "sad", "relaxed", "surprised", "aa", "ih", "ou", "ee", "oh",
            "blink", "blinkLeft", "blinkRight", "lookUp", "lookDown", "lookLeft", "lookRight", "neutral",
        };

        /// <summary>A model counts as Perfect Sync when it has at least this many of the 52 ARKit shapes as expressions.</summary>
        public const int PerfectSyncMinimum = 40;

        /// <summary>
        /// The map for one model, given the names of the expressions it has (presets and custom ones; compared without regard
        /// to case, since Perfect Sync exports usually spell them JawOpen where ARKit says jawOpen). Perfect Sync models are
        /// driven one to one with their own shapes; others get the presets they have, from the rules in ExpressionMap. The
        /// separate blinkLeft/blinkRight win over the single blink when a model has them, so an eye is never closed twice.
        /// </summary>
        public static ExpressionMap Build(IEnumerable<string> available)
        {
            var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (available != null)
            {
                foreach (var n in available)
                {
                    if (!string.IsNullOrEmpty(n) && !names.ContainsKey(n)) names[n] = n;
                }
            }

            var perfectNames = new List<string>();
            var perfectIndexes = new List<int>();
            for (var i = 0; i < StageProtocol.Arkit52.Length; i++)
            {
                if (names.TryGetValue(StageProtocol.Arkit52[i], out var own))
                {
                    perfectNames.Add(own);
                    perfectIndexes.Add(i);
                }
            }
            if (perfectNames.Count >= PerfectSyncMinimum) return new ExpressionMap(perfectNames.ToArray(), perfectIndexes.ToArray(), true);

            var driven = new List<string>();
            var source = new List<int>();
            void Add(int channel)
            {
                if (names.TryGetValue(ExpressionMap.ChannelNames[channel], out var own))
                {
                    driven.Add(own);
                    source.Add(channel);
                }
            }
            Add(ExpressionMap.Happy);
            Add(ExpressionMap.Angry);
            Add(ExpressionMap.Sad);
            Add(ExpressionMap.Surprised);
            Add(ExpressionMap.Aa);
            Add(ExpressionMap.Ih);
            Add(ExpressionMap.Ou);
            Add(ExpressionMap.Ee);
            Add(ExpressionMap.Oh);
            var hasLeft = names.ContainsKey("blinkLeft");
            var hasRight = names.ContainsKey("blinkRight");
            if (hasLeft || hasRight)
            {
                if (hasLeft) Add(ExpressionMap.BlinkLeft);
                if (hasRight) Add(ExpressionMap.BlinkRight);
            }
            else
            {
                Add(ExpressionMap.Blink);
            }
            Add(ExpressionMap.LookUp);
            Add(ExpressionMap.LookDown);
            Add(ExpressionMap.LookLeft);
            Add(ExpressionMap.LookRight);
            return new ExpressionMap(driven.ToArray(), source.ToArray(), false);
        }

        /// <summary>
        /// The baseline mood (perform.affect) as preset weights: the label picks the preset and the strength of the mood
        /// (the larger of |valence| and |arousal|) sets how far it goes, from 0.35 to 1. neutral and thinking have no preset
        /// (thinking is carried by the gaze and brows of the face frames); shy has none either and is a softened relaxed. The
        /// result holds only the presets that are driven, so combine it with the face frame by taking the larger weight per
        /// expression, and fade it in over perform.affect's blendMs.
        /// </summary>
        public static IReadOnlyDictionary<string, float> FromAffect(Affect affect)
        {
            var result = new Dictionary<string, float>();
            if (affect == null || string.IsNullOrEmpty(affect.Label)) return result;
            var strength = ExpressionMap.Clamp01((float)Math.Max(Math.Abs(affect.Valence), Math.Abs(affect.Arousal)));
            var weight = ExpressionMap.Clamp01(0.35f + 0.65f * strength);
            switch (affect.Label)
            {
                case "happy":
                case "sad":
                case "angry":
                case "relaxed":
                case "surprised":
                    result[affect.Label] = weight;
                    break;
                case "shy":
                    result["relaxed"] = 0.6f * weight;
                    break;
            }
            return result;
        }
    }
}
