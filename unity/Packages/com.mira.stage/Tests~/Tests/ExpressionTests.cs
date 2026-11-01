using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Mira.Stage.Tests
{
    /// <summary>
    /// ARKit face frames and moods to VRM 1.0 expressions (Vrm1Expressions.cs). The arithmetic is verified here; how it
    /// LOOKS on a model is not, and has to be tuned in Unity.
    /// </summary>
    public class ExpressionTests
    {
        private static float[] Frame(params (string Name, float Value)[] set)
        {
            var f = new float[StageProtocol.ArkitCount];
            foreach (var (name, value) in set)
            {
                var i = Array.IndexOf(StageProtocol.Arkit52, name);
                Assert.True(i >= 0, name + " is not an ARKit shape");
                f[i] = value;
            }
            return f;
        }

        private static Dictionary<string, float> Run(ExpressionMap map, float[] frame)
        {
            var output = new float[map.Driven.Count];
            map.Apply(frame, output);
            var d = new Dictionary<string, float>();
            for (var i = 0; i < output.Length; i++) d[map.Driven[i]] = output[i];
            return d;
        }

        private static ExpressionMap AllPresets() => Vrm1Expressions.Build(Vrm1Expressions.Presets);

        [Fact]
        public void ThePresetListIsTheVrm10Spec()
        {
            Assert.Equal(
                new[] { "happy", "angry", "sad", "relaxed", "surprised", "aa", "ih", "ou", "ee", "oh", "blink", "blinkLeft", "blinkRight", "lookUp", "lookDown", "lookLeft", "lookRight", "neutral" },
                Vrm1Expressions.Presets);
        }

        // ---------------------------------------------------------------------------------------------- what is driven

        [Fact]
        public void AModelWithEveryPresetIsDrivenOnTheOnesAFaceFrameCanFeed_NotRelaxedNotNeutralNotTheSingleBlink()
        {
            var map = AllPresets();
            Assert.False(map.PerfectSync);
            Assert.Equal(
                new[] { "happy", "angry", "sad", "surprised", "aa", "ih", "ou", "ee", "oh", "blinkLeft", "blinkRight", "lookUp", "lookDown", "lookLeft", "lookRight" },
                map.Driven);
        }

        [Fact]
        public void AModelIsOnlyEverDrivenOnExpressionsItHas()
        {
            var map = Vrm1Expressions.Build(new[] { "aa", "oh", "happy", "SomethingCustom" });
            Assert.Equal(new[] { "happy", "aa", "oh" }, map.Driven);
            var output = new float[map.Driven.Count];
            map.Apply(Frame(("jawOpen", 1f), ("mouthSmileLeft", 1f), ("mouthSmileRight", 1f)), output);
            Assert.True(output.All(v => v >= 0f && v <= 1f));
        }

        [Fact]
        public void TheSeparateBlinksWinOverTheSingleOneSoAnEyeIsNeverClosedTwice()
        {
            Assert.Equal(new[] { "blinkLeft", "blinkRight" }, Vrm1Expressions.Build(new[] { "blink", "blinkLeft", "blinkRight" }).Driven);
            Assert.Equal(new[] { "blinkLeft" }, Vrm1Expressions.Build(new[] { "blink", "blinkLeft" }).Driven);
            Assert.Equal(new[] { "blink" }, Vrm1Expressions.Build(new[] { "blink" }).Driven);
            var single = Run(Vrm1Expressions.Build(new[] { "blink" }), Frame(("eyeBlinkLeft", 1f), ("eyeBlinkRight", 0.5f)));
            Assert.Equal(0.75f, single["blink"], 3);
        }

        [Fact]
        public void NamesAreMatchedWithoutRegardToCaseAndTheModelsOwnSpellingIsUsed()
        {
            var map = Vrm1Expressions.Build(new[] { "AA", "Happy" });
            Assert.Equal(new[] { "Happy", "AA" }, map.Driven);
            Assert.True(Run(map, Frame(("jawOpen", 1f)))["AA"] > 0.9f);
        }

        [Fact]
        public void ANullOrEmptyListDrivesNothingAndStillApplies()
        {
            foreach (var map in new[] { Vrm1Expressions.Build(null), Vrm1Expressions.Build(new string[0]), Vrm1Expressions.Build(new[] { "", null }) })
            {
                Assert.Empty(map.Driven);
                map.Apply(Frame(("jawOpen", 1f)), new float[0]);
            }
        }

        // ---------------------------------------------------------------------------------------------- the rules

        [Fact]
        public void EachShapeMovesTheExpressionItIsMeantToMove()
        {
            var map = AllPresets();
            float Of(string expression, params (string, float)[] set) => Run(map, Frame(set))[expression];

            Assert.Equal(1f, Of("aa", ("jawOpen", 1f)), 3);
            Assert.Equal(1f, Of("ou", ("mouthPucker", 1f)), 3);
            Assert.Equal(1f, Of("oh", ("mouthFunnel", 1f)), 3);
            Assert.Equal(1f, Of("ee", ("mouthStretchLeft", 1f), ("mouthStretchRight", 1f)), 3);
            Assert.True(Of("ih", ("mouthStretchLeft", 1f), ("mouthStretchRight", 1f), ("jawOpen", 0.5f)) > 0.05f);
            Assert.Equal(0f, Of("ih", ("jawOpen", 1f)), 3); // an open jaw alone is "aa", not "ih"

            Assert.Equal(1f, Of("blinkLeft", ("eyeBlinkLeft", 1f)), 3);
            Assert.Equal(0f, Of("blinkRight", ("eyeBlinkLeft", 1f)), 3); // a wink stays a wink

            Assert.True(Of("happy", ("mouthSmileLeft", 0.35f), ("mouthSmileRight", 0.35f), ("cheekSquintLeft", 0.2f), ("cheekSquintRight", 0.2f)) > 0.4f);
            Assert.True(Of("sad", ("mouthFrownLeft", 0.3f), ("mouthFrownRight", 0.3f), ("browInnerUp", 0.45f)) > 0.4f);
            Assert.True(Of("angry", ("browDownLeft", 0.55f), ("browDownRight", 0.55f), ("noseSneerLeft", 0.2f), ("noseSneerRight", 0.2f)) > 0.4f);
            Assert.True(Of("surprised", ("eyeWideLeft", 0.5f), ("eyeWideRight", 0.5f), ("browInnerUp", 0.5f)) > 0.4f);

            Assert.Equal(0.5f, Of("lookUp", ("eyeLookUpLeft", 0.5f), ("eyeLookUpRight", 0.5f)), 3);
            Assert.Equal(0.5f, Of("lookDown", ("eyeLookDownLeft", 0.5f), ("eyeLookDownRight", 0.5f)), 3);
        }

        [Fact]
        public void TheGazeConventionIsTheAvatarsLeftEyeLookingOutwardIsLookingLeft()
        {
            // a convention that has not been checked on a rendered face: if the eyes go the wrong way in Unity, swap the two
            var map = AllPresets();
            var left = Run(map, Frame(("eyeLookOutLeft", 1f), ("eyeLookInRight", 1f)));
            Assert.Equal(1f, left["lookLeft"], 3);
            Assert.Equal(0f, left["lookRight"], 3);
            var right = Run(map, Frame(("eyeLookOutRight", 1f), ("eyeLookInLeft", 1f)));
            Assert.Equal(1f, right["lookRight"], 3);
            Assert.Equal(0f, right["lookLeft"], 3);
        }

        [Fact]
        public void ASilentNeutralFrameDrivesEverythingToZero()
        {
            Assert.All(Run(AllPresets(), new float[StageProtocol.ArkitCount]).Values, v => Assert.Equal(0f, v));
        }

        [Fact]
        public void TheVowelsTogetherNeverExceedOne_ARoundedOpenMouthIsNotFiveMouths()
        {
            var map = AllPresets();
            var all = Run(map, Frame(("jawOpen", 1f), ("mouthFunnel", 1f), ("mouthPucker", 1f), ("mouthStretchLeft", 1f), ("mouthStretchRight", 1f)));
            var sum = new[] { "aa", "ih", "ou", "ee", "oh" }.Sum(k => all[k]);
            Assert.InRange(sum, 0.999f, 1.001f);
            // and the proportions survive: with the jaw wide open and the lips only slightly rounded, "aa" stays the largest
            var open = Run(map, Frame(("jawOpen", 1f), ("mouthFunnel", 0.2f)));
            Assert.True(open["aa"] > open["oh"]);
        }

        [Fact]
        public void WhateverTheFrameHoldsEveryOutputIsFiniteAndInRange_20000RandomFramesWithNaNInfinityAndOutOfRangeValues()
        {
            var rng = new Random(1234);
            var specials = new[] { float.NaN, float.PositiveInfinity, float.NegativeInfinity, -1f, 2f, 1e30f, -1e30f, 0f, 1f };
            foreach (var map in new[] { AllPresets(), Vrm1Expressions.Build(StageProtocol.Arkit52), Vrm1Expressions.Build(StageProtocol.Arkit52.Select(n => char.ToUpperInvariant(n[0]) + n.Substring(1))) })
            {
                var output = new float[map.Driven.Count];
                for (var n = 0; n < 20000 / 3; n++)
                {
                    var f = new float[StageProtocol.ArkitCount];
                    for (var i = 0; i < f.Length; i++) f[i] = rng.Next(4) == 0 ? specials[rng.Next(specials.Length)] : (float)rng.NextDouble();
                    map.Apply(f, output);
                    foreach (var v in output) Assert.True(!float.IsNaN(v) && !float.IsInfinity(v) && v >= 0f && v <= 1f, "got " + v);
                }
            }
        }

        [Fact]
        public void AFrameOfTheWrongLengthIsAProgrammersMistakeAndThrows()
        {
            var map = AllPresets();
            Assert.Throws<ArgumentException>(() => map.Apply(new float[51], new float[map.Driven.Count]));
            Assert.Throws<ArgumentException>(() => map.Apply(null, new float[map.Driven.Count]));
            Assert.Throws<ArgumentException>(() => map.Apply(new float[52], new float[1]));
            Assert.Throws<ArgumentException>(() => map.Apply(new float[52], null));
        }

        // ---------------------------------------------------------------------------------------------- Perfect Sync

        [Fact]
        public void APerfectSyncModelIsDrivenOneToOneInItsOwnSpelling()
        {
            var pascal = StageProtocol.Arkit52.Select(n => char.ToUpperInvariant(n[0]) + n.Substring(1)).ToArray();
            var map = Vrm1Expressions.Build(pascal.Concat(Vrm1Expressions.Presets));
            Assert.True(map.PerfectSync);
            Assert.Equal(pascal, map.Driven);

            var frame = new float[StageProtocol.ArkitCount];
            for (var i = 0; i < frame.Length; i++) frame[i] = (i + 1) / 100f;
            var output = new float[52];
            map.Apply(frame, output);
            Assert.Equal(frame, output);
        }

        [Fact]
        public void PerfectSyncNeedsFortyOfTheFiftyTwoShapes_FewerAndTheModelGetsThePresetRules()
        {
            var enough = Vrm1Expressions.Build(StageProtocol.Arkit52.Take(40));
            Assert.True(enough.PerfectSync);
            Assert.Equal(40, enough.Driven.Count);
            var notEnough = Vrm1Expressions.Build(StageProtocol.Arkit52.Take(39).Concat(Vrm1Expressions.Presets));
            Assert.False(notEnough.PerfectSync);
            Assert.Contains("aa", notEnough.Driven);
        }

        [Fact]
        public void APerfectSyncModelWithAGapSkipsTheGapAndKeepsTheRestAligned()
        {
            var without = StageProtocol.Arkit52.Where(n => n != "tongueOut" && n != "cheekPuff");
            var map = Vrm1Expressions.Build(without);
            Assert.True(map.PerfectSync);
            Assert.Equal(50, map.Driven.Count);
            var frame = Frame(("jawOpen", 0.7f), ("tongueOut", 1f), ("cheekPuff", 1f));
            var d = Run(map, frame);
            Assert.Equal(0.7f, d["jawOpen"], 3);
            Assert.False(d.ContainsKey("tongueOut"));
        }

        // ------------------------------------------------------------------------------------------------ the real frames

        [Fact]
        public void TheFaceFramesTheRealDaemonSentMapToValidExpressionWeights()
        {
            var map = AllPresets();
            var frames = new List<float[]>();
            foreach (var entry in JArray.Parse(TestPaths.ReadGolden("recorded/frames/index.json")).Where(e => e.Value<string>("kind") == "face"))
            {
                var bytes = Convert.FromBase64String(TestPaths.ReadGolden("recorded/frames/" + entry.Value<string>("file")).Trim());
                var decoded = StageFrames.Decode(bytes);
                Assert.True(decoded.Ok);
                frames.AddRange(StageFrames.ToFace(decoded.Frame).Weights);
            }
            Assert.True(frames.Count >= 2, frames.Count + " recorded face frames");
            var jawIndex = Array.IndexOf(StageProtocol.Arkit52, "jawOpen");
            var spoken = 0;
            foreach (var f in frames)
            {
                var d = Run(map, f);
                Assert.All(d.Values, v => Assert.InRange(v, 0f, 1f));
                var jaw = f[jawIndex];
                Assert.True(d["aa"] <= jaw + 1e-4f, "the normalised vowel can only be at most the jaw that carries it");
                if (jaw > 0.1f)
                {
                    spoken++;
                    Assert.True(d["aa"] > 0f, "an open jaw must move the aa expression");
                }
            }
            Assert.True(spoken > 0, "none of the recorded face frames has the jaw open, so this proves nothing: record again");
        }

        // ------------------------------------------------------------------------------------------------------- mood

        private static Affect Mood(string label, double valence = 0.5, double arousal = 0.0) => new Affect { Label = label, Valence = valence, Arousal = arousal, Dominance = 0 };

        [Theory]
        [InlineData("happy", "happy")]
        [InlineData("sad", "sad")]
        [InlineData("angry", "angry")]
        [InlineData("relaxed", "relaxed")]
        [InlineData("surprised", "surprised")]
        public void AMoodLabelThatIsAPresetDrivesThatPreset(string label, string preset)
        {
            var d = Vrm1Expressions.FromAffect(Mood(label));
            Assert.Equal(new[] { preset }, d.Keys.ToArray());
            Assert.InRange(d[preset], 0.35f, 1f);
            Assert.Contains(preset, Vrm1Expressions.Presets);
        }

        [Theory]
        [InlineData("neutral")]
        [InlineData("thinking")]
        [InlineData("not-a-label")]
        [InlineData("")]
        [InlineData(null)]
        public void NeutralThinkingAndUnknownLabelsHaveNoPreset(string label)
        {
            Assert.Empty(Vrm1Expressions.FromAffect(Mood(label)));
        }

        [Fact]
        public void ShyIsASoftenedRelaxedAndAStrongerMoodGoesFurther()
        {
            var shy = Vrm1Expressions.FromAffect(Mood("shy", 0.6));
            var relaxed = Vrm1Expressions.FromAffect(Mood("relaxed", 0.6));
            Assert.Equal(new[] { "relaxed" }, shy.Keys.ToArray());
            Assert.True(shy["relaxed"] < relaxed["relaxed"]);

            var mild = Vrm1Expressions.FromAffect(Mood("happy", 0.1))["happy"];
            var strong = Vrm1Expressions.FromAffect(Mood("happy", 0.9))["happy"];
            Assert.True(strong > mild);
            Assert.InRange(mild, 0.35f, 1f);
            // arousal counts as well as valence (an angry mood is negative and high energy)
            Assert.True(Vrm1Expressions.FromAffect(Mood("angry", -0.1, 0.9))["angry"] > Vrm1Expressions.FromAffect(Mood("angry", -0.1, 0.0))["angry"]);
        }

        [Fact]
        public void ABrokenMoodNeverProducesAnOutOfRangeWeight()
        {
            Assert.Empty(Vrm1Expressions.FromAffect(null));
            foreach (var v in new[] { double.NaN, double.PositiveInfinity, double.NegativeInfinity, -5.0, 5.0 })
            {
                var d = Vrm1Expressions.FromAffect(Mood("happy", v, v));
                Assert.All(d.Values, w => Assert.True(!float.IsNaN(w) && w >= 0f && w <= 1f, "got " + w));
            }
        }
    }
}
